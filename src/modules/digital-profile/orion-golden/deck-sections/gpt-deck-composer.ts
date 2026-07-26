/**
 * GPT stage 1.5 — deck composition planner (GPT levels plan, level 2).
 *
 * The model receives the verified findings and the per-fragment scope of the
 * deck (which findings and source domains each analytical fragment owns) and
 * returns a structured composition plan: for every fragment — the story
 * angle to open with, which findings to emphasise first and which source
 * domains to foreground. GPT decides «what to tell and in which order»;
 * the code keeps deciding «only the truth»:
 *
 *  - every fragmentKey must be a known analytical fragment — unknown dropped;
 *  - emphasised findingIds are intersected with the fragment's OWN scoped
 *    findings (fail-closed — a finding from another fragment never leaks in);
 *  - key domains are intersected with the fragment's own evidence/finding
 *    domains and pass the mock-domain guard;
 *  - the story angle passes the client-text token scans and a length budget.
 *
 * Level 2.5 addition: the composer may also pick a LAYOUT VARIANT for slides
 * whose template offers pre-built alternatives (TEMPLATE_LAYOUT_VARIANTS).
 * GPT never invents geometry — it selects among vetted deterministic layouts
 * implemented in the Python renderer; unknown slideIds/variants are dropped
 * fail-closed. The variant travels outside SectionPack content (presentation
 * only), so packs, hashes and caching are untouched.
 *
 * The plan shapes the stage-2 prompts (emphasis and ordering of the client
 * text) and the renderer layout choice. Slide structure, metrics, tables and
 * evidence stay fully deterministic. Fail-safe: any error returns null and
 * the pipeline proceeds exactly as before level 2.
 */

import { z } from "zod";
import type { FragmentKey, SectionPackV2 } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import { normalizeEvidenceRef, type ScopedEvidenceIndex, type SubjectProfileInput } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { GptCaseAnalysis, GptJsonCaller } from "../gpt/gpt-case-analysis";
import { defaultGptCallQueueOptions, runGptCallQueue } from "../gpt/gpt-call-queue";
import { riskLevelRu } from "../gpt/client-payload-labels";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../client/client-text-sanitizer";
import { matchInternalClientToken } from "../client/load-client-text-contract";
import { isMockClientDomain } from "../../services/composite-serp-merge";
import {
  isAllowedLayoutVariant,
  TEMPLATE_LAYOUT_VARIANTS,
  type DeckTemplateId,
} from "./template-registry";

export const GPT_DECK_COMPOSER_PROMPT_VERSION = "gpt-deck-composer-v3";

/** Prompt marker for offline smokes asserting the composer call. */
export const GPT_DECK_COMPOSER_PROMPT_MARKER = "план композиции отчёта";

/** Client-safe one-liner budget for the per-fragment story angle. */
export const COMPOSER_STORY_ANGLE_BUDGET = 300;

const ComposerResponseSchema = z.object({
  fragments: z
    .array(
      z.object({
        fragmentKey: z.string().min(1),
        storyAngle: z.string().min(1),
        emphasisFindingIds: z.array(z.string()).max(12).optional(),
        keyDomains: z.array(z.string()).max(12).optional(),
      })
    )
    .max(32),
  // Level 2.5: layout picks are optional and tolerated as null/absent — the
  // model may return them only for slides that offer variants.
  layouts: z
    .array(
      z.object({
        slideId: z.string().min(1),
        layoutVariant: z.string().min(1),
      })
    )
    .max(64)
    .nullish(),
});

const COMPOSER_INSTRUCTIONS = [
  `Ты — аналитик-композитор: построй ${GPT_DECK_COMPOSER_PROMPT_MARKER} о цифровом профиле субъекта.`,
  "Тебе переданы подтверждённые findings и список аналитических фрагментов отчёта с их собственными findings и доменами источников.",
  "Для каждого фрагмента реши: с какого смыслового акцента начать рассказ (storyAngle — одно клиентское предложение без жаргона), какие findings раскрыть в первую очередь (emphasisFindingIds — по убыванию важности) и какие домены источников вынести на передний план (keyDomains).",
  "Используй ТОЛЬКО переданные findingId и домены конкретного фрагмента; не переноси findings и домены между фрагментами; не добавляй новых фактов.",
  `storyAngle — по-русски, до ${COMPOSER_STORY_ANGLE_BUDGET} символов, без слов «черновик», «фрагмент», «findings», без URL и внутренних идентификаторов.`,
  "Отдельно передан список layoutOptions: слайды, у которых есть альтернативные варианты вёрстки, с описанием каждого варианта. Ты — ещё и арт-директор: для каждого такого слайда ПРЕДПОЧИТАЙ выразительный вариант вёрстки (верни slideId и layoutVariant из списка), если содержание страницы это позволяет; стандартную вёрстку оставляй (не возвращай слайд) только когда данных для варианта явно недостаточно (например, нет нарратива или метрик).",
  'Верни ТОЛЬКО JSON: {"fragments": [{"fragmentKey": string, "storyAngle": string, "emphasisFindingIds": [string], "keyDomains": [string]}], "layouts": [{"slideId": string, "layoutVariant": string}]}.',
].join(" ");

export type GptFragmentCompositionPlan = {
  fragmentKey: FragmentKey;
  storyAngle: string;
  /** Ordered subset of the fragment's own scoped finding ids. */
  emphasisFindingIds: string[];
  /** Subset of the fragment's own evidence/finding domains. */
  keyDomains: string[];
};

/** A validated layout pick: slide exists and the variant is registered. */
export type GptSlideLayoutPick = {
  slideId: string;
  layoutVariant: string;
};

export type GptDeckComposition = {
  version: "gpt-deck-composition-v1";
  promptVersion: string;
  generatedAt: string;
  fragments: GptFragmentCompositionPlan[];
  /** Level 2.5: per-slide layout variant picks (presentation only). */
  layouts: GptSlideLayoutPick[];
  /** Fail-closed observability: what the validator refused and why. */
  droppedFragments: string[];
  droppedFields: string[];
};

/** Fragments the composer may plan: analytical, READY, with slides. */
function composerEligiblePacks(packs: SectionPackV2[]): SectionPackV2[] {
  return packs.filter(
    (p) =>
      !getFragmentPrompt(p.fragmentKey).deterministic &&
      p.status === "READY" &&
      p.slides.length > 0
  );
}

/** Domains a fragment may foreground: its own evidence + finding domains. */
function fragmentAllowedDomains(input: {
  pack: SectionPackV2;
  bundle: VerifiedFindingBundle;
  evidenceIndex: ScopedEvidenceIndex;
}): Set<string> {
  const allowed = new Set<string>();
  const refs = new Set(input.pack.inputs.evidenceRefs.map(normalizeEvidenceRef));
  for (const [ref, e] of Object.entries(input.evidenceIndex)) {
    if (e.domain && e.domain !== "—" && refs.has(normalizeEvidenceRef(ref))) {
      allowed.add(e.domain.toLowerCase());
    }
  }
  const scopedIds = new Set(input.pack.inputs.findingIds);
  for (const f of input.bundle.findings) {
    if (!scopedIds.has(f.findingId)) continue;
    for (const d of f.sourceDomains ?? []) allowed.add(d.toLowerCase());
  }
  return allowed;
}

/**
 * One composition call for the whole deck. Never throws; null on any failure
 * (transport, schema, or when nothing passes the fail-closed validation).
 */
export async function runGptDeckComposer(input: {
  packs: SectionPackV2[];
  subject: SubjectProfileInput;
  caller: GptJsonCaller;
  caseAnalysis: GptCaseAnalysis | null;
  bundle: VerifiedFindingBundle;
  evidenceIndex: ScopedEvidenceIndex;
  /** Optional queue overrides (tests inject fake sleep / short deadline). */
  queueOptions?: Parameters<typeof runGptCallQueue>[0]["options"];
}): Promise<GptDeckComposition | null> {
  const eligible = composerEligiblePacks(input.packs);
  if (eligible.length === 0) return null;

  const findingById = new Map(input.bundle.findings.map((f) => [f.findingId, f]));
  const allowedDomainsByFragment = new Map<string, Set<string>>();
  const scopedIdsByFragment = new Map<string, Set<string>>();

  // Level 2.5 — slides that offer pre-built layout variants. Deterministic
  // fragments participate too: a layout pick changes presentation only and
  // never touches pack content.
  const templateBySlideId = new Map<string, string>();
  const layoutOptionsPayload: Array<Record<string, unknown>> = [];
  for (const pack of input.packs) {
    if (pack.status !== "READY") continue;
    for (const slide of pack.slides) {
      if (slide.isContinuation) continue;
      const variants = TEMPLATE_LAYOUT_VARIANTS[slide.templateId as DeckTemplateId];
      if (!variants || variants.length === 0) continue;
      templateBySlideId.set(slide.slideId, slide.templateId);
      layoutOptionsPayload.push({
        slideId: slide.slideId,
        templateId: slide.templateId,
        title: slide.title,
        content: {
          narrativeChars: slide.content.narrative?.length ?? 0,
          bulletCount: slide.content.bullets?.length ?? 0,
          tableRowCount: slide.content.table?.rows.length ?? 0,
          kpiCount: slide.content.kpis?.length ?? 0,
        },
        variants: variants.map((v) => ({ id: v.id, description: v.description })),
      });
    }
  }

  const fragmentsPayload = eligible.map((pack) => {
    const allowedDomains = fragmentAllowedDomains({
      pack,
      bundle: input.bundle,
      evidenceIndex: input.evidenceIndex,
    });
    allowedDomainsByFragment.set(pack.fragmentKey, allowedDomains);
    scopedIdsByFragment.set(pack.fragmentKey, new Set(pack.inputs.findingIds));
    const findings = pack.inputs.findingIds
      .map((id) => findingById.get(id))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .slice(0, 24)
      .map((f) => ({
        findingId: f.findingId,
        theme: f.theme,
        claim: f.claim,
        riskLevel: riskLevelRu(f.riskLevel),
        sourceDomains: (f.sourceDomains ?? []).slice(0, 6),
      }));
    return {
      fragmentKey: pack.fragmentKey,
      sectionId: pack.sectionId,
      findings,
      availableDomains: [...allowedDomains].sort().slice(0, 24),
    };
  });

  const defaults = defaultGptCallQueueOptions();
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;
  const [queued] = await runGptCallQueue({
    tasks: [
      {
        key: "deck-composer",
        run: () =>
          input.caller({
            systemPrompt: COMPOSER_INSTRUCTIONS,
            userPayload: {
              subject: {
                displayName: input.subject.displayName,
                aliases: input.subject.aliases,
              },
              caseAnalysis: input.caseAnalysis
                ? {
                    overallRiskLevel: input.caseAnalysis.overallRiskLevel,
                    executiveConclusion: input.caseAnalysis.executiveConclusion,
                    keyRisks: input.caseAnalysis.keyRisks,
                  }
                : null,
              fragments: fragmentsPayload,
              layoutOptions: layoutOptionsPayload,
            },
          }),
      },
    ],
    options: {
      concurrency: 1,
      maxAttempts: defaults.maxAttempts,
      deadlineMs: defaults.deadlineMs,
      sleep: offlineSleep,
      ...input.queueOptions,
    },
  });
  if (!queued || !queued.ok) return null;
  const parsed = ComposerResponseSchema.safeParse(queued.value);
  if (!parsed.success) return null;

  const droppedFragments: string[] = [];
  const droppedFields: string[] = [];
  const seen = new Set<string>();
  const fragments: GptFragmentCompositionPlan[] = [];

  for (const raw of parsed.data.fragments) {
    const key = raw.fragmentKey;
    const scopedIds = scopedIdsByFragment.get(key);
    const allowedDomains = allowedDomainsByFragment.get(key);
    if (!scopedIds || !allowedDomains || seen.has(key)) {
      droppedFragments.push(`${key}:unknown-or-duplicate-fragment`);
      continue;
    }
    const storyAngle = raw.storyAngle.trim();
    if (
      !storyAngle ||
      storyAngle.length > COMPOSER_STORY_ANGLE_BUDGET ||
      matchInternalClientToken(storyAngle) ||
      scanOrionGoldenClientTextForForbiddenTokens(storyAngle).length > 0 ||
      /https?:\/\//iu.test(storyAngle)
    ) {
      droppedFragments.push(`${key}:unsafe-story-angle`);
      continue;
    }
    const emphasisFindingIds = (raw.emphasisFindingIds ?? []).filter((id) => {
      const ok = scopedIds.has(id);
      if (!ok) droppedFields.push(`${key}.emphasisFindingIds:${id}`);
      return ok;
    });
    const keyDomains = (raw.keyDomains ?? [])
      .map((d) => d.trim().toLowerCase())
      .filter((d) => {
        const ok = d.length > 0 && allowedDomains.has(d) && !isMockClientDomain(d);
        if (!ok && d) droppedFields.push(`${key}.keyDomains:${d}`);
        return ok;
      });
    seen.add(key);
    fragments.push({
      fragmentKey: key as FragmentKey,
      storyAngle,
      emphasisFindingIds: emphasisFindingIds.slice(0, 8),
      keyDomains: keyDomains.slice(0, 8),
    });
  }

  // Level 2.5 — validate layout picks fail-closed: the slide must be one we
  // offered and the variant must be registered for its template.
  const layouts: GptSlideLayoutPick[] = [];
  const seenLayoutSlides = new Set<string>();
  for (const raw of parsed.data.layouts ?? []) {
    const templateId = templateBySlideId.get(raw.slideId);
    const variant = raw.layoutVariant.trim();
    if (
      !templateId ||
      seenLayoutSlides.has(raw.slideId) ||
      !isAllowedLayoutVariant(templateId, variant)
    ) {
      droppedFields.push(`layouts.${raw.slideId}:${variant || "?"}`);
      continue;
    }
    seenLayoutSlides.add(raw.slideId);
    layouts.push({ slideId: raw.slideId, layoutVariant: variant });
  }

  if (fragments.length === 0 && layouts.length === 0) return null;
  return {
    version: "gpt-deck-composition-v1",
    promptVersion: GPT_DECK_COMPOSER_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    fragments,
    layouts,
    droppedFragments,
    droppedFields,
  };
}
