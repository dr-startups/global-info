/**
 * REMEDIATION §3.3 — optional LLM theme suggestion for uncategorized materials.
 *
 * Behind ORION_GPT_THEMES=1 (default off). Model proposes themes; code verifies
 * keywords (≥2 materials), evidence refs, and non-duplication of configured
 * themes. Passing suggestions become findings with origin "llm-suggested",
 * confidence penalty, subjectMatch LIKELY_SUBJECT («Требует подтверждения»).
 * Fail-safe: invalid / transport error → nothing added.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { digitalProfileConfig } from "../../config";
import { getFindingThemes } from "../../config/finding-themes";
import type { RawInventoryItem } from "../types";
import {
  FINDING_SCHEMA_VERSION,
  FindingSchema,
  type Finding,
} from "../contracts/finding";
import type { UncategorizedMaterialsBlock } from "../analytics/finding-synthesizer";
import { domainOf } from "../analytics/composite-dataset-builder";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";
import type { GptJsonCaller } from "./gpt-case-analysis";
import {
  defaultGptCallQueueOptions,
  runGptCallQueue,
  type GptCallQueueOptions,
} from "./gpt-call-queue";
import { callOpenAiStrictJson } from "./openai-json-client";

export const GPT_THEME_SUGGESTION_VERSION = "gpt-theme-suggestion-v1" as const;
export const GPT_THEME_PROMPT_VERSION = "gpt-theme-prompt-v1";
/** Confidence ceiling after LLM penalty (below typical LIKELY band). */
export const LLM_THEME_CONFIDENCE_CAP = 0.45;

const SuggestionSchema = z.object({
  themeLabel: z.string().min(2).max(160),
  keywords: z.array(z.string().min(2).max(80)).min(1).max(12),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(40),
});

const ModelResponseSchema = z.object({
  themes: z.array(SuggestionSchema).max(8).default([]),
});

export type GptThemeSuggestion = z.infer<typeof SuggestionSchema>;

export type GptThemeVerification = {
  themeLabel: string;
  accepted: boolean;
  reason: string;
  keywordsAccepted: string[];
  keywordsRejected: string[];
  evidenceRefs: string[];
};

export type GptThemeSuggestionArtifact = {
  version: typeof GPT_THEME_SUGGESTION_VERSION;
  promptVersion: typeof GPT_THEME_PROMPT_VERSION;
  caseId: string;
  datasetId: string;
  enabled: boolean;
  generatedAt: string;
  callCount: number;
  inputUncategorizedCount: number;
  proposed: GptThemeSuggestion[];
  verification: GptThemeVerification[];
  acceptedFindingIds: string[];
  failureReason: string | null;
  sourceHashes: string[];
};

export function isGptThemesEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.ORION_GPT_THEMES === "1" || digitalProfileConfig.orionGptThemes;
}

export const THEME_SYSTEM_PROMPT = [
  "Ты — аналитик reputational due diligence. Тебе переданы материалы о субъекте, не попавшие ни в одну настроенную тему.",
  "Предложи новые темы риска/контекста, которых нет в списке alreadyConfiguredThemes.",
  "Для каждой темы: themeLabel (клиентский язык), keywords (слова/фразы реально встречающиеся в текстах), evidenceRefs (refs из входа).",
  "Не дублируй configured themes. Не выдумывай refs. Пиши по-русски.",
  'Верни ТОЛЬКО JSON: {"themes":[{"themeLabel":string,"keywords":[string],"evidenceRefs":[string]}]}.',
].join(" ");

function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function itemText(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/ё/gu, "е");
}

function keywordInText(keyword: string, text: string): boolean {
  const k = keyword.toLowerCase().replace(/ё/gu, "е").trim();
  if (k.length < 2) return false;
  return text.includes(k);
}

/** Configured theme labels/ids — suggestions must not duplicate these. */
export function configuredThemeLabels(): Set<string> {
  const labels = new Set<string>();
  for (const t of getFindingThemes()) {
    labels.add(normLabel(t.label));
    labels.add(normLabel(t.themeId.replace(/_/g, " ")));
  }
  return labels;
}

/**
 * Deterministic verification of one model suggestion.
 * Each keyword must appear in ≥2 materials among the referenced set;
 * all refs must exist; label must not duplicate configured themes.
 */
export function verifyThemeSuggestion(input: {
  suggestion: GptThemeSuggestion;
  materialsByRef: Map<string, RawInventoryItem>;
  allowedRefs: Set<string>;
  configuredLabels?: Set<string>;
}): GptThemeVerification & { findingMaterials?: RawInventoryItem[] } {
  const configured = input.configuredLabels ?? configuredThemeLabels();
  const label = String(input.suggestion.themeLabel ?? "").trim();
  const keywords = (input.suggestion.keywords ?? [])
    .map((k) => String(k).trim())
    .filter((k) => k.length >= 2);
  const refs = [...new Set((input.suggestion.evidenceRefs ?? []).map(String))];

  if (!label || configured.has(normLabel(label))) {
    return {
      themeLabel: label || "(empty)",
      accepted: false,
      reason: "duplicate-or-empty-theme",
      keywordsAccepted: [],
      keywordsRejected: keywords,
      evidenceRefs: refs,
    };
  }

  const validRefs = refs.filter((r) => input.allowedRefs.has(r) && input.materialsByRef.has(r));
  if (validRefs.length < 2) {
    return {
      themeLabel: label,
      accepted: false,
      reason: "insufficient-valid-refs",
      keywordsAccepted: [],
      keywordsRejected: keywords,
      evidenceRefs: refs,
    };
  }

  const materials = validRefs
    .map((r) => input.materialsByRef.get(r)!)
    .filter(Boolean);
  const texts = materials.map(itemText);

  const keywordsAccepted: string[] = [];
  const keywordsRejected: string[] = [];
  for (const kw of keywords) {
    const hits = texts.filter((t) => keywordInText(kw, t)).length;
    if (hits >= 2) keywordsAccepted.push(kw);
    else keywordsRejected.push(kw);
  }

  if (keywordsAccepted.length === 0) {
    return {
      themeLabel: label,
      accepted: false,
      reason: "no-keyword-with-2-hits",
      keywordsAccepted,
      keywordsRejected,
      evidenceRefs: validRefs,
    };
  }

  return {
    themeLabel: label,
    accepted: true,
    reason: "ok",
    keywordsAccepted,
    keywordsRejected,
    evidenceRefs: validRefs,
    findingMaterials: materials,
  };
}

function buildLlmFinding(input: {
  caseId: string;
  datasetId: string;
  sourceHashes: string[];
  themeLabel: string;
  keywords: string[];
  materials: RawInventoryItem[];
}): Finding {
  const evidenceRefs = input.materials.map((i) => `inventory:${i.inventoryId}`);
  const domains = [...new Set(input.materials.map((i) => domainOf(i.sourceUrl)).filter(Boolean))];
  const providers = [
    ...new Set(input.materials.map((i) => String(i.provider ?? "unknown").toLowerCase())),
  ];
  const regions = [...new Set(input.materials.map((i) => mapRegionBucket(i.region)))];
  const surfaces = [
    ...new Set(
      input.materials.map((i) =>
        mapSurfaceBucket(
          String(((i.rawMetadata ?? {}) as Record<string, unknown>).surface ?? i.evidenceType)
        )
      )
    ),
  ];
  const topTitles = input.materials
    .slice(0, 3)
    .map((i) => String(i.title ?? "").trim())
    .filter(Boolean);

  const claim =
    `${input.materials.length} публикаций по теме, предложенной моделью (требует подтверждения). ` +
    `Ключевые слова: ${input.keywords.slice(0, 6).join(", ")}. ` +
    `Источники: ${domains.slice(0, 4).join(", ") || "без URL"}.` +
    (topTitles.length ? ` Примеры: ${topTitles.join(" · ").slice(0, 280)}` : "");

  return FindingSchema.parse({
    schemaVersion: FINDING_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs,
    findingId: `finding-llm-${createHash("sha1")
      .update(`${normLabel(input.themeLabel)}|${evidenceRefs.sort().join("|")}`)
      .digest("hex")
      .slice(0, 10)}`,
    theme: input.themeLabel,
    claim,
    // LIKELY_SUBJECT → matrix «Требует подтверждения», never KPI (§2.1 / §3.3).
    subjectMatch: "LIKELY_SUBJECT",
    riskLevel: "low",
    confidence: LLM_THEME_CONFIDENCE_CAP,
    regions,
    sourceDomains: domains,
    providers,
    recommendedAction: "Проверить предложенную тему и подтвердить или отклонить вручную.",
    contradictions: [],
    limitations: [
      "Тема предложена LLM (origin: llm-suggested) и не входит в подтверждённый словарь.",
      "Принадлежность и формулировка требуют подтверждения аналитика.",
    ],
    promotionPriority: "APPENDIX",
    surfaceKinds: surfaces,
    origin: "llm-suggested",
  });
}

export function defaultGptThemesCaller(): GptJsonCaller {
  return (input) =>
    callOpenAiStrictJson({
      systemPrompt: input.systemPrompt,
      userPayload: input.userPayload,
      maxOutputTokens: 4000,
    });
}

export async function runGptThemeSuggestion(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  uncategorized: UncategorizedMaterialsBlock;
  sourceHashes: string[];
  enabled?: boolean;
  caller?: GptJsonCaller;
  queueOptions?: GptCallQueueOptions;
}): Promise<{
  artifact: GptThemeSuggestionArtifact;
  findings: Finding[];
}> {
  const enabled = input.enabled ?? isGptThemesEnabled();
  const generatedAt = new Date().toISOString();
  const baseArtifact = (
    extra: Partial<GptThemeSuggestionArtifact> = {}
  ): GptThemeSuggestionArtifact => ({
    version: GPT_THEME_SUGGESTION_VERSION,
    promptVersion: GPT_THEME_PROMPT_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    enabled,
    generatedAt,
    callCount: 0,
    inputUncategorizedCount: input.uncategorized.count,
    proposed: [],
    verification: [],
    acceptedFindingIds: [],
    failureReason: null,
    sourceHashes: input.sourceHashes,
    ...extra,
  });

  if (!enabled) {
    return { artifact: baseArtifact(), findings: [] };
  }

  const allowedRefs = new Set(
    (input.uncategorized.allEvidenceRefs?.length
      ? input.uncategorized.allEvidenceRefs
      : input.uncategorized.topExamples.map((e) => e.evidenceRef)
    ).filter(Boolean)
  );

  if (allowedRefs.size === 0 || input.uncategorized.count === 0) {
    return {
      artifact: baseArtifact({ failureReason: "no-uncategorized-materials" }),
      findings: [],
    };
  }

  const materialsByRef = new Map<string, RawInventoryItem>();
  for (const item of input.items) {
    const ref = `inventory:${item.inventoryId}`;
    if (allowedRefs.has(ref)) materialsByRef.set(ref, item);
  }

  const materialRows = [...allowedRefs]
    .map((ref) => {
      const item = materialsByRef.get(ref);
      if (!item) return null;
      return {
        ref,
        title: String(item.title ?? "").slice(0, 240),
        text: itemText(item).slice(0, 500),
        domain: domainOf(item.sourceUrl) || "—",
      };
    })
    .filter(Boolean);

  const caller = input.caller ?? defaultGptThemesCaller();
  const defaults = defaultGptCallQueueOptions();
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;

  let callCount = 0;
  let raw: unknown;
  try {
    const queued = await runGptCallQueue({
      tasks: [
        {
          key: "gpt-theme-suggest",
          run: async () => {
            callCount += 1;
            return caller({
              systemPrompt: THEME_SYSTEM_PROMPT,
              userPayload: {
                alreadyConfiguredThemes: getFindingThemes().map((t) => ({
                  themeId: t.themeId,
                  label: t.label,
                })),
                materials: materialRows,
              },
            });
          },
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
    const result = queued[0];
    if (!result || !result.ok) {
      return {
        artifact: baseArtifact({
          callCount,
          failureReason:
            result && !result.ok ? result.error.message : "gpt-theme-missing-result",
        }),
        findings: [],
      };
    }
    raw = result.value;
  } catch (err) {
    return {
      artifact: baseArtifact({
        callCount,
        failureReason: err instanceof Error ? err.message : String(err),
      }),
      findings: [],
    };
  }

  const parsed = ModelResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      artifact: baseArtifact({
        callCount,
        failureReason: `schema: ${parsed.error.message}`,
      }),
      findings: [],
    };
  }

  const configured = configuredThemeLabels();
  const verification: GptThemeVerification[] = [];
  const findings: Finding[] = [];

  for (const suggestion of parsed.data.themes) {
    const verified = verifyThemeSuggestion({
      suggestion,
      materialsByRef,
      allowedRefs,
      configuredLabels: configured,
    });
    verification.push({
      themeLabel: verified.themeLabel,
      accepted: verified.accepted,
      reason: verified.reason,
      keywordsAccepted: verified.keywordsAccepted,
      keywordsRejected: verified.keywordsRejected,
      evidenceRefs: verified.evidenceRefs,
    });
    if (!verified.accepted || !verified.findingMaterials) continue;

    // Mark label as used so duplicate proposals in the same batch collapse.
    configured.add(normLabel(verified.themeLabel));

    const finding = buildLlmFinding({
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      themeLabel: verified.themeLabel,
      keywords: verified.keywordsAccepted,
      materials: verified.findingMaterials,
    });
    findings.push(finding);
  }

  return {
    artifact: baseArtifact({
      callCount,
      proposed: parsed.data.themes,
      verification,
      acceptedFindingIds: findings.map((f) => f.findingId),
      failureReason: null,
    }),
    findings,
  };
}
