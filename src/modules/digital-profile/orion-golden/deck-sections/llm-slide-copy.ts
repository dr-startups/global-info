/**
 * GPT stage 2 — per-slide client copy.
 *
 * After the deterministic builders produce structurally valid SectionPacks,
 * this stage asks the model to rewrite the CLIENT TEXT of every analytical
 * slide (narrative, «что обнаружено», «почему важно», «что проверить»,
 * bullets) in detailed client language: explain why each signal is risky and
 * what to do about it. The model receives the fragment's own scoped findings,
 * the deterministic draft and the holistic case analysis (stage 1) — never
 * unrelated sections or raw datasets (one prompt per fragment, as designed in
 * prompts.ts).
 *
 * Fail-safe by construction:
 *  - every returned field passes budgets, internal-token and forbidden-token
 *    scans, and the domain gate (no domain the slide's own evidence does not
 *    carry) — a bad field is rejected individually;
 *  - the enhanced pack is re-validated by the section QA; if it fails, the
 *    deterministic pack is kept unchanged (per-fragment fallback);
 *  - any transport error keeps the deterministic pack. The GPT layer can only
 *    improve text, never block the report.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { FragmentKey, SectionPackV2, SlideContentContract } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import { normalizeEvidenceRef, type ScopedEvidenceIndex, type SubjectProfileInput } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { GptCaseAnalysis, GptJsonCaller } from "../gpt/gpt-case-analysis";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../client/client-text-sanitizer";
import { riskLevelRu, subjectMatchRu } from "../gpt/client-payload-labels";

export const GPT_SLIDE_COPY_PROMPT_VERSION = "gpt-slide-copy-v2";

/** Mirrors section-validation budgets — a GPT field must fit the same box. */
const TEXT_BUDGETS = {
  narrative: 900,
  bullet: 400,
  whatWasFound: 400,
  whyItMatters: 320,
  whatToCheck: 220,
} as const;

const INTERNAL_TOKENS =
  /\baudit\b|reportRunId|report_run|datasetId|pipeline|arsenkin|serp[-_]obs|inventoryId|schemaVersion/iu;

const DOMAIN_TOKEN_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu;

const SlideOverrideSchema = z.object({
  slideId: z.string().min(1),
  narrative: z.string().optional(),
  bullets: z.array(z.string().min(1)).min(1).max(8).optional(),
  whatWasFound: z.string().optional(),
  whyItMatters: z.string().optional(),
  whatToCheck: z.string().optional(),
});
const FragmentCopyResponseSchema = z.object({
  slides: z.array(SlideOverrideSchema).max(16),
});
type SlideOverride = z.infer<typeof SlideOverrideSchema>;

const COPY_INSTRUCTIONS = [
  "Твоя задача — переписать клиентский текст каждого переданного слайда лучше чернового варианта: подробным клиентским языком, без жаргона.",
  "Для каждого негативного или неоднозначного сигнала объясняй, ПОЧЕМУ он рискован (влияние на репутацию, сделки, банковские и партнёрские проверки), и давай конкретный совет, что с этой информацией делать.",
  "Опирайся только на переданные findings, claims и черновой текст; не добавляй новых фактов, имён, компаний и доменов.",
  "Используй переданный общий анализ кейса (caseAnalysis), чтобы все слайды говорили согласованными выводами.",
  "Не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider) и идентификаторы; не вставляй URL. Пиши только по-русски: не копируй в текст английские служебные слова и коды из данных.",
  "Соблюдай лимиты длины: narrative до 850 символов, каждый bullet до 380, whatWasFound до 380, whyItMatters до 300, whatToCheck до 200.",
  'Верни ТОЛЬКО JSON: {"slides": [{"slideId": string, "narrative"?: string, "bullets"?: [string], "whatWasFound"?: string, "whyItMatters"?: string, "whatToCheck"?: string}]}. Поле можно опустить, если черновик лучше не менять.',
].join(" ");

export type GptSlideCopyFragmentStatus =
  | "APPLIED"
  | "NO_CHANGES"
  | "SKIPPED_DETERMINISTIC"
  | "SKIPPED_EMPTY"
  | "SKIPPED_CACHED"
  | "FALLBACK_VALIDATION"
  | "FALLBACK_ERROR";

export type GptSlideCopyFragmentReport = {
  fragmentKey: FragmentKey;
  status: GptSlideCopyFragmentStatus;
  appliedFields: number;
  rejectedFields: string[];
  detail?: string;
};

export type GptSlideCopyReport = {
  version: "gpt-report-copy-v1";
  promptVersion: string;
  caseAnalysisUsed: boolean;
  fragments: GptSlideCopyFragmentReport[];
};

/** Domains a slide is allowed to mention: its own evidence + existing draft. */
function allowedDomainsForSlide(
  slide: SlideContentContract,
  evidenceIndex: ScopedEvidenceIndex
): Set<string> {
  const allowed = new Set<string>();
  const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
  for (const [ref, e] of Object.entries(evidenceIndex)) {
    if (e.domain && e.domain !== "—" && normRefs.has(normalizeEvidenceRef(ref))) {
      allowed.add(e.domain.toLowerCase());
    }
  }
  const draftTexts = [
    slide.title,
    slide.subtitle,
    slide.content.narrative,
    slide.content.whatWasFound,
    slide.content.whyItMatters,
    slide.content.whatToCheck,
    slide.content.sourceNote,
    ...(slide.content.bullets ?? []),
  ].filter((t): t is string => Boolean(t));
  for (const text of draftTexts) {
    for (const m of text.matchAll(DOMAIN_TOKEN_RE)) allowed.add(m[0].toLowerCase());
  }
  return allowed;
}

/** null when acceptable; otherwise a rejection reason. */
function rejectReason(value: string, budget: number, allowedDomains: Set<string>): string | null {
  const text = value.trim();
  if (!text) return "empty";
  if (text.length > budget) return `over-budget:${text.length}>${budget}`;
  if (INTERNAL_TOKENS.test(text)) return "internal-token";
  const forbidden = scanOrionGoldenClientTextForForbiddenTokens(text);
  if (forbidden.length > 0) return `forbidden:${forbidden[0]}`;
  for (const m of text.matchAll(DOMAIN_TOKEN_RE)) {
    if (!allowedDomains.has(m[0].toLowerCase())) return `foreign-domain:${m[0]}`;
  }
  return null;
}

function contentHashOf(slides: SlideContentContract[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(slides)).digest("hex")}`;
}

function buildFragmentPayload(input: {
  pack: SectionPackV2;
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  caseAnalysis: GptCaseAnalysis | null;
  targets: SlideContentContract[];
}): Record<string, unknown> {
  const findingById = new Map(input.bundle.findings.map((f) => [f.findingId, f]));
  const scopedFindings = input.pack.sourceFindingIds
    .map((id) => findingById.get(id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .slice(0, 24)
    // Client-language labels only: the model echoes payload tokens, and raw
    // enums (riskLevel "high", SUBJECT_MATCH, finding ids) would leak into the
    // generated text and be rejected by the token scanner afterwards.
    .map((f) => ({
      theme: f.theme,
      claim: f.claim,
      riskLevel: riskLevelRu(f.riskLevel),
      subjectMatch: subjectMatchRu(f.subjectMatch),
      recommendedAction: f.recommendedAction,
      sourceDomains: f.sourceDomains.slice(0, 6),
    }));
  return {
    subject: { displayName: input.subject.displayName, aliases: input.subject.aliases },
    caseAnalysis: input.caseAnalysis
      ? {
          overallRiskLevel: input.caseAnalysis.overallRiskLevel,
          executiveConclusion: input.caseAnalysis.executiveConclusion,
          keyRisks: input.caseAnalysis.keyRisks,
          recommendations: input.caseAnalysis.recommendations,
        }
      : null,
    findings: scopedFindings,
    slides: input.targets.map((s) => ({
      slideId: s.slideId,
      title: s.title,
      subtitle: s.subtitle,
      draft: {
        narrative: s.content.narrative,
        bullets: s.content.bullets,
        whatWasFound: s.content.whatWasFound,
        whyItMatters: s.content.whyItMatters,
        whatToCheck: s.content.whatToCheck,
      },
    })),
  };
}

function applyOverrides(input: {
  pack: SectionPackV2;
  overrides: SlideOverride[];
  evidenceIndex: ScopedEvidenceIndex;
  rejectedFields: string[];
}): { slides: SlideContentContract[]; appliedFields: number } {
  const { pack, overrides, evidenceIndex, rejectedFields } = input;
  const overrideById = new Map(overrides.map((o) => [o.slideId, o]));
  const continuationBases = new Set(
    pack.slides.filter((s) => s.isContinuation).map((s) => s.continuationOf)
  );
  let appliedFields = 0;

  const slides = pack.slides.map((slide) => {
    if (slide.isContinuation) return slide;
    const o = overrideById.get(slide.slideId);
    if (!o) return slide;
    const allowed = allowedDomainsForSlide(slide, evidenceIndex);
    const content = { ...slide.content };

    const tryField = (
      field: "narrative" | "whatWasFound" | "whyItMatters" | "whatToCheck",
      value: string | undefined,
      budget: number
    ) => {
      if (value === undefined) return;
      const reason = rejectReason(value, budget, allowed);
      if (reason) {
        rejectedFields.push(`${slide.slideId}.${field}:${reason}`);
        return;
      }
      content[field] = value.trim();
      appliedFields += 1;
    };

    tryField("narrative", o.narrative, TEXT_BUDGETS.narrative);
    tryField("whatWasFound", o.whatWasFound, TEXT_BUDGETS.whatWasFound);
    tryField("whyItMatters", o.whyItMatters, TEXT_BUDGETS.whyItMatters);
    tryField("whatToCheck", o.whatToCheck, TEXT_BUDGETS.whatToCheck);

    // Bullets stay deterministic when the slide has chunked continuations
    // (rewriting only the base chunk would desynchronize the sequence).
    if (o.bullets && !continuationBases.has(slide.slideId)) {
      const reasons = o.bullets
        .map((b) => rejectReason(b, TEXT_BUDGETS.bullet, allowed))
        .filter((r): r is string => Boolean(r));
      if (reasons.length > 0) {
        rejectedFields.push(`${slide.slideId}.bullets:${reasons[0]}`);
      } else {
        content.bullets = o.bullets.map((b) => b.trim());
        appliedFields += 1;
      }
    }

    return { ...slide, content };
  });

  return { slides, appliedFields };
}

/**
 * Enhance analytical SectionPacks with GPT-written client copy.
 * Deterministic fragments, cached GPT packs and anything that fails QA keep
 * their existing content — the result is never worse than the input.
 */
export async function enhanceSectionPacksWithGptCopy(input: {
  packs: SectionPackV2[];
  subject: SubjectProfileInput;
  caller: GptJsonCaller;
  caseAnalysis: GptCaseAnalysis | null;
  bundle: VerifiedFindingBundle;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
}): Promise<{ packs: SectionPackV2[]; report: GptSlideCopyReport }> {
  const fragments: GptSlideCopyFragmentReport[] = [];
  const outPacks: SectionPackV2[] = [];

  for (const pack of input.packs) {
    const prompt = getFragmentPrompt(pack.fragmentKey);
    const report: GptSlideCopyFragmentReport = {
      fragmentKey: pack.fragmentKey,
      status: "NO_CHANGES",
      appliedFields: 0,
      rejectedFields: [],
    };

    if (prompt.deterministic) {
      report.status = "SKIPPED_DETERMINISTIC";
      fragments.push(report);
      outPacks.push(pack);
      continue;
    }
    if (pack.status !== "READY" || pack.slides.length === 0) {
      report.status = "SKIPPED_EMPTY";
      fragments.push(report);
      outPacks.push(pack);
      continue;
    }
    if (pack.gptCopy?.promptVersion === GPT_SLIDE_COPY_PROMPT_VERSION) {
      report.status = "SKIPPED_CACHED";
      fragments.push(report);
      outPacks.push(pack);
      continue;
    }

    const targets = pack.slides.filter((s) => !s.isContinuation);
    try {
      const raw = await input.caller({
        systemPrompt: `${prompt.systemPrompt} ${COPY_INSTRUCTIONS}`,
        userPayload: buildFragmentPayload({
          pack,
          subject: input.subject,
          bundle: input.bundle,
          caseAnalysis: input.caseAnalysis,
          targets,
        }),
      });
      const parsed = FragmentCopyResponseSchema.safeParse(raw);
      if (!parsed.success) {
        report.status = "FALLBACK_ERROR";
        report.detail = "invalid response schema";
        fragments.push(report);
        outPacks.push(pack);
        continue;
      }

      const knownIds = new Set(targets.map((s) => s.slideId));
      const overrides = parsed.data.slides.filter((o) => knownIds.has(o.slideId));
      const { slides, appliedFields } = applyOverrides({
        pack,
        overrides,
        evidenceIndex: input.evidenceIndex,
        rejectedFields: report.rejectedFields,
      });
      report.appliedFields = appliedFields;
      if (appliedFields === 0) {
        report.status = "NO_CHANGES";
        fragments.push(report);
        outPacks.push(pack);
        continue;
      }

      const candidate: SectionPackV2 = {
        ...pack,
        slides,
        contentHash: contentHashOf(slides),
        gptCopy: {
          promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
          appliedSlides: new Set(
            overrides.filter((o) => knownIds.has(o.slideId)).map((o) => o.slideId)
          ).size,
        },
      };
      const validation = input.validatePack(candidate);
      if (!validation.passed) {
        report.status = "FALLBACK_VALIDATION";
        report.detail = validation.issues.slice(0, 3).join("; ");
        fragments.push(report);
        outPacks.push(pack);
        continue;
      }

      report.status = "APPLIED";
      fragments.push(report);
      outPacks.push({ ...candidate, validation: { passed: true, issues: [] } });
    } catch (err) {
      report.status = "FALLBACK_ERROR";
      report.detail = err instanceof Error ? err.message : String(err);
      fragments.push(report);
      outPacks.push(pack);
    }
  }

  return {
    packs: outPacks,
    report: {
      version: "gpt-report-copy-v1",
      promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
      caseAnalysisUsed: Boolean(input.caseAnalysis),
      fragments,
    },
  };
}
