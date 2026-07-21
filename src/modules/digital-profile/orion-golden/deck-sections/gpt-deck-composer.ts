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
 * The plan only shapes the stage-2 prompts (emphasis and ordering of the
 * client text). Slide structure, metrics, tables and evidence stay fully
 * deterministic. Fail-safe: any error returns null and the pipeline proceeds
 * exactly as before level 2.
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

export const GPT_DECK_COMPOSER_PROMPT_VERSION = "gpt-deck-composer-v1";

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
});

const COMPOSER_INSTRUCTIONS = [
  `Ты — аналитик-композитор: построй ${GPT_DECK_COMPOSER_PROMPT_MARKER} о цифровом профиле субъекта.`,
  "Тебе переданы подтверждённые findings и список аналитических фрагментов отчёта с их собственными findings и доменами источников.",
  "Для каждого фрагмента реши: с какого смыслового акцента начать рассказ (storyAngle — одно клиентское предложение без жаргона), какие findings раскрыть в первую очередь (emphasisFindingIds — по убыванию важности) и какие домены источников вынести на передний план (keyDomains).",
  "Используй ТОЛЬКО переданные findingId и домены конкретного фрагмента; не переноси findings и домены между фрагментами; не добавляй новых фактов.",
  `storyAngle — по-русски, до ${COMPOSER_STORY_ANGLE_BUDGET} символов, без слов «черновик», «фрагмент», «findings», без URL и внутренних идентификаторов.`,
  'Верни ТОЛЬКО JSON: {"fragments": [{"fragmentKey": string, "storyAngle": string, "emphasisFindingIds": [string], "keyDomains": [string]}]}.',
].join(" ");

export type GptFragmentCompositionPlan = {
  fragmentKey: FragmentKey;
  storyAngle: string;
  /** Ordered subset of the fragment's own scoped finding ids. */
  emphasisFindingIds: string[];
  /** Subset of the fragment's own evidence/finding domains. */
  keyDomains: string[];
};

export type GptDeckComposition = {
  version: "gpt-deck-composition-v1";
  promptVersion: string;
  generatedAt: string;
  fragments: GptFragmentCompositionPlan[];
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

  if (fragments.length === 0) return null;
  return {
    version: "gpt-deck-composition-v1",
    promptVersion: GPT_DECK_COMPOSER_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    fragments,
    droppedFragments,
    droppedFields,
  };
}
