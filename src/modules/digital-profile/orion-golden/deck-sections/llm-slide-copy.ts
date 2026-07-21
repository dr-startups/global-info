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
import { defaultGptCallQueueOptions, runGptCallQueue } from "../gpt/gpt-call-queue";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../client/client-text-sanitizer";
import {
  getClientTextFieldBudgets,
  matchInternalClientToken,
} from "../client/load-client-text-contract";
import { riskLevelRu, subjectMatchRu } from "../gpt/client-payload-labels";

/** v5 — Phase A.2: hard ban on meta-speak («черновик», «переданный фрагмент») in client text. */
export const GPT_SLIDE_COPY_PROMPT_VERSION = "gpt-slide-copy-v5";

/** Mirrors section-validation budgets — from client-text-contract (§6.1). */
export const GPT_SLIDE_COPY_FIELD_BUDGETS = (() => {
  const b = getClientTextFieldBudgets();
  return {
    narrative: b.narrative,
    bullet: b.bullet,
    whatWasFound: b.whatWasFound,
    whyItMatters: b.whyItMatters,
    whatToCheck: b.whatToCheck,
  } as const;
})();

const TEXT_BUDGETS = GPT_SLIDE_COPY_FIELD_BUDGETS;

/** Prompt marker for offline smokes asserting §7.5 density instructions. */
export const GPT_SLIDE_COPY_DENSITY_MARKER = "заполняй ВСЕ поля черновика";

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
  `Для страниц с данными ${GPT_SLIDE_COPY_DENSITY_MARKER} (narrative, whatWasFound, whyItMatters, whatToCheck, bullets) — не ограничивайся правкой одного поля, если остальные пустые или слишком короткие.`,
  "Для страниц с данными опирайся на конкретику из scoped findings и черновика: числа публикаций, домены источников, темы риска; не пиши общими фразами без опоры на переданные факты.",
  "Для каждого негативного или неоднозначного сигнала объясняй, ПОЧЕМУ он рискован (влияние на репутацию, сделки, банковские и партнёрские проверки), и давай конкретный совет, что с этой информацией делать.",
  "Опирайся только на переданные findings, claims и черновой текст; не добавляй новых фактов, имён, компаний и доменов.",
  "Используй переданный общий анализ кейса (caseAnalysis), чтобы все слайды говорили согласованными выводами.",
  "Не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider) и идентификаторы; не вставляй URL. Пиши только по-русски: не копируй в текст английские служебные слова и коды из данных.",
  "СТРОГО ЗАПРЕЩЕНО упоминать в клиентском тексте процесс подготовки отчёта и источник данных для тебя: слова «черновик», «черновой», «переданный фрагмент», «переданные данные», «scoped», «findings» и любые рассуждения о том, что в черновике чего-то нет или что страницу не следует чем-то наполнять. Клиент видит только выводы о субъекте и фактах, а не твою работу с материалами.",
  "Лимиты длины (верхняя граница с зазором до бюджета валидации): narrative до 850, каждый bullet до 380, whatWasFound до 380, whyItMatters до 300, whatToCheck до 200.",
  "Нижняя граница для страниц с данными: каждый заполняемый текстовый блок — не короче ~40% своего бюджета (narrative ≳360, whatWasFound ≳160, whyItMatters ≳130, whatToCheck ≳90, bullet ≳160), если в черновике/findings есть материал для раскрытия.",
  "Не переписывай честные пустые состояния: если черновик говорит, что поверхность не собиралась / проверена и пуста / визуал недоступен — не подставляй findings с других поверхностей или регионов.",
  'Верни ТОЛЬКО JSON: {"slides": [{"slideId": string, "narrative": string, "bullets": [string], "whatWasFound": string, "whyItMatters": string, "whatToCheck": string}]}. Опускай поле только если поверхность пустая и черновик честно сообщает об отсутствии данных.',
].join(" ");

/**
 * Honest coverage / visual fallbacks must keep deterministic copy.
 * GPT must not invent organic/AI content from sibling findings (§UAE SERP).
 */
export function isHonestEmptyStateSlide(slide: SlideContentContract): boolean {
  if (slide.templateId === "coverage-empty-state") return true;
  if (slide.emptyStateReason && slide.emptyStateReason.trim().length > 0) return true;
  return false;
}

/** Offline metric for §7.5 — field fill + length-vs-budget on data slides. */
export type SlideCopyDensityStats = {
  dataSlides: number;
  fieldsExpected: number;
  fieldsFilled: number;
  fieldFillRatio: number;
  avgLengthRatio: number;
};

export function measureSlideCopyDensity(
  slides: SlideContentContract[]
): SlideCopyDensityStats {
  const textFields = ["narrative", "whatWasFound", "whyItMatters", "whatToCheck"] as const;
  let dataSlides = 0;
  let fieldsExpected = 0;
  let fieldsFilled = 0;
  let lengthRatioSum = 0;
  let lengthSamples = 0;

  for (const s of slides) {
    if (s.isContinuation) continue;
    const hasData =
      (s.evidenceRefs?.length ?? 0) > 0 ||
      (s.findingIds?.length ?? 0) > 0 ||
      (s.content.table?.rows?.length ?? 0) > 0 ||
      (s.content.bullets?.length ?? 0) > 0 ||
      Boolean(s.content.narrative?.trim());
    if (!hasData) continue;
    dataSlides += 1;
    for (const field of textFields) {
      fieldsExpected += 1;
      const text = String(s.content[field] ?? "").trim();
      if (!text) continue;
      fieldsFilled += 1;
      lengthRatioSum += Math.min(1, text.length / TEXT_BUDGETS[field]);
      lengthSamples += 1;
    }
    fieldsExpected += 1;
    const bullets = (s.content.bullets ?? []).map((b) => b.trim()).filter(Boolean);
    if (bullets.length > 0) {
      fieldsFilled += 1;
      const joined = bullets.join(" ");
      lengthRatioSum += Math.min(1, joined.length / (TEXT_BUDGETS.bullet * Math.min(3, bullets.length)));
      lengthSamples += 1;
    }
  }

  return {
    dataSlides,
    fieldsExpected,
    fieldsFilled,
    fieldFillRatio: fieldsExpected > 0 ? fieldsFilled / fieldsExpected : 0,
    avgLengthRatio: lengthSamples > 0 ? lengthRatioSum / lengthSamples : 0,
  };
}

export type GptSlideCopyFragmentStatus =
  | "APPLIED"
  | "NO_CHANGES"
  | "SKIPPED_DETERMINISTIC"
  | "SKIPPED_EMPTY"
  | "SKIPPED_CACHED"
  | "FALLBACK_VALIDATION"
  | "FALLBACK_ERROR"
  | "FALLBACK_TIMEOUT";

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
  if (matchInternalClientToken(text)) return "internal-token";
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
    fragmentKey: input.pack.fragmentKey,
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
    // Fail-closed: never overwrite coverage/visual empty states even if the
    // model returns an override for that slideId.
    if (isHonestEmptyStateSlide(slide)) return slide;
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

type PendingGptPack = {
  pack: SectionPackV2;
  targets: SlideContentContract[];
  systemPrompt: string;
  userPayload: unknown;
  wantCaseAnalysis: boolean;
};

/** REMEDIATION §4.3 — cache hit only for successful stage-2 stamps. */
export function isGptCopyCacheHit(
  pack: SectionPackV2,
  wantCaseAnalysis: boolean
): boolean {
  const g = pack.gptCopy;
  if (!g) return false;
  if (!g.promptVersion || g.promptVersion !== GPT_SLIDE_COPY_PROMPT_VERSION) {
    return false;
  }
  if (g.lastStatus?.startsWith("FALLBACK_")) return false;
  if (Boolean(g.caseAnalysisUsed) !== wantCaseAnalysis) return false;
  return true;
}

export function packNeedsGptCopyFallbackRetry(
  pack: SectionPackV2,
  fallbackKeys?: ReadonlySet<string>
): boolean {
  if (pack.gptCopy?.lastStatus?.startsWith("FALLBACK_")) return true;
  // Compat: report listed FALLBACK_* before packs stamped lastStatus.
  if (
    fallbackKeys?.has(pack.fragmentKey) &&
    !isGptCopyCacheHit(pack, Boolean(pack.gptCopy?.caseAnalysisUsed))
  ) {
    return true;
  }
  return false;
}

function stampGptCopy(
  pack: SectionPackV2,
  input: {
    status: GptSlideCopyFragmentStatus;
    detail?: string;
    wantCaseAnalysis: boolean;
    appliedSlides?: number;
    cacheable: boolean;
  }
): SectionPackV2 {
  return {
    ...pack,
    gptCopy: {
      promptVersion: input.cacheable ? GPT_SLIDE_COPY_PROMPT_VERSION : "",
      appliedSlides: input.appliedSlides ?? pack.gptCopy?.appliedSlides ?? 0,
      caseAnalysisUsed: input.wantCaseAnalysis,
      lastStatus: input.status,
      ...(input.detail ? { lastDetail: input.detail } : {}),
    },
  };
}

function applyGptRawToPack(input: {
  pack: SectionPackV2;
  targets: SlideContentContract[];
  raw: unknown;
  wantCaseAnalysis: boolean;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
}): { pack: SectionPackV2; report: GptSlideCopyFragmentReport } {
  const report: GptSlideCopyFragmentReport = {
    fragmentKey: input.pack.fragmentKey,
    status: "NO_CHANGES",
    appliedFields: 0,
    rejectedFields: [],
  };
  const parsed = FragmentCopyResponseSchema.safeParse(input.raw);
  if (!parsed.success) {
    report.status = "FALLBACK_ERROR";
    report.detail = "invalid response schema";
    return {
      pack: stampGptCopy(input.pack, {
        status: "FALLBACK_ERROR",
        detail: report.detail,
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: false,
      }),
      report,
    };
  }

  const knownIds = new Set(input.targets.map((s) => s.slideId));
  const overrides = parsed.data.slides.filter((o) => knownIds.has(o.slideId));
  const { slides, appliedFields } = applyOverrides({
    pack: input.pack,
    overrides,
    evidenceIndex: input.evidenceIndex,
    rejectedFields: report.rejectedFields,
  });
  report.appliedFields = appliedFields;
  if (appliedFields === 0) {
    report.status = "NO_CHANGES";
    return {
      pack: stampGptCopy(input.pack, {
        status: "NO_CHANGES",
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: true,
      }),
      report,
    };
  }

  const appliedSlides = new Set(
    overrides.filter((o) => knownIds.has(o.slideId)).map((o) => o.slideId)
  ).size;
  const candidate: SectionPackV2 = {
    ...input.pack,
    slides,
    contentHash: contentHashOf(slides),
    gptCopy: {
      promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
      appliedSlides,
      caseAnalysisUsed: input.wantCaseAnalysis,
      lastStatus: "APPLIED",
    },
  };
  const validation = input.validatePack(candidate);
  if (!validation.passed) {
    report.status = "FALLBACK_VALIDATION";
    report.detail = validation.issues.slice(0, 3).join("; ");
    return {
      pack: stampGptCopy(input.pack, {
        status: "FALLBACK_VALIDATION",
        detail: report.detail,
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: false,
      }),
      report,
    };
  }

  report.status = "APPLIED";
  return {
    pack: { ...candidate, validation: { passed: true, issues: [] } },
    report,
  };
}

/**
 * Enhance analytical SectionPacks with GPT-written client copy.
 * Deterministic fragments, cached GPT packs and anything that fails QA keep
 * their existing content — the result is never worse than the input.
 *
 * REMEDIATION §4.2: eligible fragment calls go through `runGptCallQueue`
 * (concurrency + retries + stage deadline). Application order is sorted by
 * fragmentKey for deterministic artifacts.
 */
export async function enhanceSectionPacksWithGptCopy(input: {
  packs: SectionPackV2[];
  subject: SubjectProfileInput;
  caller: GptJsonCaller;
  caseAnalysis: GptCaseAnalysis | null;
  bundle: VerifiedFindingBundle;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
  /** Optional queue overrides (tests inject fake sleep / short deadline). */
  queueOptions?: Parameters<typeof runGptCallQueue>[0]["options"];
  /**
   * REMEDIATION §4.3 — only call GPT for FALLBACK_* fragments; others stay
   * SKIPPED_CACHED / deterministic / empty.
   */
  retryOnlyFallback?: boolean;
  /** Fragment keys listed as FALLBACK_* in gpt-report-copy.json (compat). */
  fallbackFragmentKeys?: ReadonlySet<string>;
  /**
   * Full prepare / «Пересобрать»: never short-circuit as SKIPPED_CACHED.
   * Selective gpt-copy retry must leave this false (uses retryOnlyFallback).
   */
  forceRefresh?: boolean;
}): Promise<{ packs: SectionPackV2[]; report: GptSlideCopyReport }> {
  const byKey = new Map<
    string,
    { pack: SectionPackV2; report: GptSlideCopyFragmentReport }
  >();
  const pending: PendingGptPack[] = [];
  const wantCaseAnalysis = Boolean(input.caseAnalysis);
  const fallbackKeys = input.fallbackFragmentKeys;

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
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }
    if (pack.status !== "READY" || pack.slides.length === 0) {
      report.status = "SKIPPED_EMPTY";
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }
    if (input.retryOnlyFallback) {
      if (!packNeedsGptCopyFallbackRetry(pack, fallbackKeys)) {
        report.status = "SKIPPED_CACHED";
        byKey.set(pack.fragmentKey, { pack, report });
        continue;
      }
    } else if (
      !input.forceRefresh &&
      isGptCopyCacheHit(pack, wantCaseAnalysis)
    ) {
      report.status = "SKIPPED_CACHED";
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }

    // Never send honest empty-state slides to GPT — it otherwise pulls
    // pack-level findings (other surfaces/regions) into «проверено, пусто».
    const targets = pack.slides.filter(
      (s) => !s.isContinuation && !isHonestEmptyStateSlide(s)
    );
    if (targets.length === 0) {
      report.status = "SKIPPED_EMPTY";
      report.detail = "honest-empty-state";
      byKey.set(pack.fragmentKey, {
        pack: stampGptCopy(pack, {
          status: "SKIPPED_EMPTY",
          detail: "honest-empty-state",
          wantCaseAnalysis,
          cacheable: true,
          appliedSlides: 0,
        }),
        report,
      });
      continue;
    }
    pending.push({
      pack,
      targets,
      systemPrompt: `${prompt.systemPrompt} ${COPY_INSTRUCTIONS}`,
      userPayload: buildFragmentPayload({
        pack,
        subject: input.subject,
        bundle: input.bundle,
        caseAnalysis: input.caseAnalysis,
        targets,
      }),
      wantCaseAnalysis,
    });
  }

  const defaults = defaultGptCallQueueOptions();
  // Offline smokes must not pay real backoff sleeps when fakes throw 429/5xx.
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;
  const queueResults = await runGptCallQueue({
    tasks: pending.map((p) => ({
      key: p.pack.fragmentKey,
      run: () =>
        input.caller({
          systemPrompt: p.systemPrompt,
          userPayload: p.userPayload,
        }),
    })),
    options: {
      concurrency: defaults.concurrency,
      maxAttempts: defaults.maxAttempts,
      deadlineMs: defaults.deadlineMs,
      sleep: offlineSleep,
      ...input.queueOptions,
    },
  });

  const rawByKey = new Map(queueResults.map((r) => [r.key, r]));
  for (const item of pending) {
    const queued = rawByKey.get(item.pack.fragmentKey);
    if (!queued || !queued.ok) {
      const reason = queued && !queued.ok ? queued.reason : "FALLBACK_ERROR";
      const status =
        reason === "FALLBACK_TIMEOUT" ? "FALLBACK_TIMEOUT" : "FALLBACK_ERROR";
      const detail =
        queued && !queued.ok
          ? queued.error.message
          : "gpt-queue-missing-result";
      byKey.set(item.pack.fragmentKey, {
        pack: stampGptCopy(item.pack, {
          status,
          detail,
          wantCaseAnalysis: item.wantCaseAnalysis,
          cacheable: false,
        }),
        report: {
          fragmentKey: item.pack.fragmentKey,
          status,
          appliedFields: 0,
          rejectedFields: [],
          detail,
        },
      });
      continue;
    }
    byKey.set(
      item.pack.fragmentKey,
      applyGptRawToPack({
        pack: item.pack,
        targets: item.targets,
        raw: queued.value,
        wantCaseAnalysis: item.wantCaseAnalysis,
        evidenceIndex: input.evidenceIndex,
        validatePack: input.validatePack,
      })
    );
  }

  // Deterministic artifact order: original pack order for packs, fragmentKey
  // sort for the report (stable across concurrent completion).
  const outPacks = input.packs.map(
    (p) => byKey.get(p.fragmentKey)?.pack ?? p
  );
  const fragments = [...byKey.values()]
    .map((v) => v.report)
    .sort((a, b) => a.fragmentKey.localeCompare(b.fragmentKey));

  return {
    packs: outPacks,
    report: {
      version: "gpt-report-copy-v1",
      promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
      caseAnalysisUsed: wantCaseAnalysis,
      fragments,
    },
  };
}
