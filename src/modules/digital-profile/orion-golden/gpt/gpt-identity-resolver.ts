/**
 * REMEDIATION §2.4 — optional LLM disambiguation of AMBIGUOUS materials.
 *
 * Behind ORION_GPT_IDENTITY=1 (default off). Batches ~20 AMBIGUOUS items,
 * asks the model for LIKELY | AMBIGUOUS | OTHER, then clamps so the pipeline
 * can only raise to LIKELY_SUBJECT or lower to OTHER_SUBJECT — never SUBJECT_MATCH.
 * Fail-safe: transport/schema errors leave materials AMBIGUOUS.
 */

import { z } from "zod";
import { digitalProfileConfig } from "../../config";
import type { RawInventoryItem } from "../types";
import type { SubjectRelevanceDecision } from "../contracts/common";
import type {
  SubjectResolution,
  SubjectResolutionItem,
} from "../contracts/subject-resolution";
import type { SubjectIdentity } from "../analytics/subject-resolution-classifier";
import type { GptJsonCaller } from "./gpt-case-analysis";
import {
  defaultGptCallQueueOptions,
  runGptCallQueue,
  type GptCallQueueOptions,
} from "./gpt-call-queue";
import { callOpenAiStrictJson } from "./openai-json-client";

export const GPT_IDENTITY_RESOLUTION_VERSION = "gpt-identity-resolution-v1" as const;
export const GPT_IDENTITY_BATCH_SIZE = 20;
export const GPT_IDENTITY_PROMPT_VERSION = "gpt-identity-prompt-v1";

/** Loose parse — illegal values (e.g. SUBJECT_MATCH) are clamped after. */
const ModelItemSchema = z.object({
  ref: z.string().min(1),
  decision: z.string().min(1),
  reason: z.string().min(1).max(500),
});

const ModelBatchSchema = z.object({
  decisions: z.array(ModelItemSchema).max(GPT_IDENTITY_BATCH_SIZE + 5),
});

export type GptIdentityModelDecision = "LIKELY" | "AMBIGUOUS" | "OTHER";

export type GptIdentityAppliedRow = {
  evidenceRef: string;
  from: "AMBIGUOUS";
  to: "LIKELY_SUBJECT" | "OTHER_SUBJECT" | "AMBIGUOUS";
  modelDecision: GptIdentityModelDecision;
  reason: string;
  /** True when model asked for SUBJECT_MATCH (or similar) and we clamped. */
  clamped: boolean;
};

export type GptIdentityResolutionArtifact = {
  version: typeof GPT_IDENTITY_RESOLUTION_VERSION;
  promptVersion: typeof GPT_IDENTITY_PROMPT_VERSION;
  caseId: string;
  datasetId: string;
  enabled: boolean;
  generatedAt: string;
  batchCount: number;
  callCount: number;
  inputAmbiguousCount: number;
  applied: GptIdentityAppliedRow[];
  unchangedRefs: string[];
  failures: Array<{ batch: number; reason: string }>;
  sourceHashes: string[];
};

export function isGptIdentityEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.ORION_GPT_IDENTITY === "1" || digitalProfileConfig.orionGptIdentity;
}

/** Marker substring for offline prompt assertions. */
export const IDENTITY_SYSTEM_PROMPT = [
  "Ты — аналитик reputational due diligence, уточняющий принадлежность неоднозначных материалов проверяемому лицу.",
  "Тебе дан профиль субъекта (включая известных тёзок) и батч материалов со статусом AMBIGUOUS.",
  "Для каждого материала верни решение: LIKELY (вероятно о субъекте), AMBIGUOUS (остаётся неоднозначным), OTHER (скорее о другом лице).",
  "Строгий запрет: НИКОГДА не возвращай SUBJECT_MATCH и не утверждай однозначное подтверждение — максимум LIKELY.",
  "Не выдумывай факты; опирайся только на переданные поля. Пиши reason по-русски, кратко.",
  'Верни ТОЛЬКО JSON: {"decisions":[{"ref":string,"decision":"LIKELY|AMBIGUOUS|OTHER","reason":string}]}.',
].join(" ");

/**
 * Clamp model decision to pipeline enum. SUBJECT_MATCH (and unknowns that look
 * like upgrades) collapse to LIKELY_SUBJECT — invariant «не выше LIKELY».
 */
export function clampGptIdentityDecision(raw: unknown): {
  decision: "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT";
  modelDecision: GptIdentityModelDecision;
  clamped: boolean;
} {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (s === "LIKELY" || s === "LIKELY_SUBJECT") {
    return { decision: "LIKELY_SUBJECT", modelDecision: "LIKELY", clamped: false };
  }
  if (s === "OTHER" || s === "OTHER_SUBJECT" || s === "WRONG_SUBJECT") {
    return { decision: "OTHER_SUBJECT", modelDecision: "OTHER", clamped: false };
  }
  if (s === "AMBIGUOUS") {
    return { decision: "AMBIGUOUS", modelDecision: "AMBIGUOUS", clamped: false };
  }
  // Never allow SUBJECT_MATCH / confirmed upgrades.
  if (s === "SUBJECT_MATCH" || s === "EXACT_SUBJECT" || s === "CONFIRMED") {
    return { decision: "LIKELY_SUBJECT", modelDecision: "LIKELY", clamped: true };
  }
  return { decision: "AMBIGUOUS", modelDecision: "AMBIGUOUS", clamped: true };
}

function itemText(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .slice(0, 600);
}

function buildSubjectPayload(subject: SubjectIdentity) {
  return {
    displayName: subject.displayName,
    lastName: subject.lastName,
    firstNames: subject.firstNames.slice(0, 8),
    patronymics: subject.patronymics.slice(0, 4),
    aliases: subject.aliases.slice(0, 10),
    strongIdentifiers: subject.strongIdentifiers.slice(0, 6),
    contextIdentifiers: subject.contextIdentifiers.slice(0, 12),
    namesakes: subject.namesakeProfiles.map((n) => ({
      label: n.label,
      noiseTerms: n.noiseTerms.slice(0, 12),
    })),
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function applyResolutionUpdate(input: {
  evidenceRef: string;
  nextDecision: "LIKELY_SUBJECT" | "OTHER_SUBJECT";
  reason: string;
  resolutionByRef: Map<string, SubjectResolutionItem>;
  subjectResolution: SubjectResolution;
}): void {
  const prev = input.resolutionByRef.get(input.evidenceRef);
  const reasonCode =
    input.nextDecision === "LIKELY_SUBJECT" ? "gpt_identity_likely" : "gpt_identity_other";
  const next: SubjectResolutionItem = {
    evidenceRef: input.evidenceRef,
    decision: input.nextDecision as SubjectRelevanceDecision,
    confidence:
      input.nextDecision === "LIKELY_SUBJECT"
        ? Math.min(0.68, Math.max(0.6, prev?.confidence ?? 0.62))
        : Math.min(0.85, Math.max(0.55, prev?.confidence ?? 0.7)),
    matchedIdentifiers: prev?.matchedIdentifiers ?? [],
    conflictingIdentifiers: prev?.conflictingIdentifiers ?? [],
    reasonCode,
    legacyBindingNote: `gpt-identity: ${input.reason}`.slice(0, 280),
  };
  input.resolutionByRef.set(input.evidenceRef, next);
  const idx = input.subjectResolution.items.findIndex(
    (i) => i.evidenceRef === input.evidenceRef
  );
  if (idx >= 0) input.subjectResolution.items[idx] = next;
  else input.subjectResolution.items.push(next);
}

export function defaultGptIdentityCaller(): GptJsonCaller {
  return (input) =>
    callOpenAiStrictJson({
      systemPrompt: input.systemPrompt,
      userPayload: input.userPayload,
      maxOutputTokens: 4000,
    });
}

export async function runGptIdentityResolution(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  subjectResolution: SubjectResolution;
  sourceHashes: string[];
  /** When false, no GPT calls — empty artifact. */
  enabled?: boolean;
  caller?: GptJsonCaller;
  queueOptions?: GptCallQueueOptions;
}): Promise<GptIdentityResolutionArtifact> {
  const enabled = input.enabled ?? isGptIdentityEnabled();
  const generatedAt = new Date().toISOString();
  const empty = (extra: Partial<GptIdentityResolutionArtifact> = {}): GptIdentityResolutionArtifact => ({
    version: GPT_IDENTITY_RESOLUTION_VERSION,
    promptVersion: GPT_IDENTITY_PROMPT_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    enabled,
    generatedAt,
    batchCount: 0,
    callCount: 0,
    inputAmbiguousCount: 0,
    applied: [],
    unchangedRefs: [],
    failures: [],
    sourceHashes: input.sourceHashes,
    ...extra,
  });

  if (!enabled) return empty();

  const ambiguousItems = input.items.filter((item) => {
    const ref = `inventory:${item.inventoryId}`;
    return input.resolutionByRef.get(ref)?.decision === "AMBIGUOUS";
  });
  if (ambiguousItems.length === 0) {
    return empty({ inputAmbiguousCount: 0 });
  }

  const caller = input.caller ?? defaultGptIdentityCaller();
  const batches = chunk(ambiguousItems, GPT_IDENTITY_BATCH_SIZE);
  const defaults = defaultGptCallQueueOptions();
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;

  const subjectPayload = buildSubjectPayload(input.subject);
  const applied: GptIdentityAppliedRow[] = [];
  const unchangedRefs: string[] = [];
  const failures: Array<{ batch: number; reason: string }> = [];
  let callCount = 0;

  const tasks = batches.map((batch, batchIdx) => ({
    key: `gpt-identity-batch-${batchIdx}`,
    run: async () => {
      const payload = {
        subject: subjectPayload,
        materials: batch.map((item) => ({
          ref: `inventory:${item.inventoryId}`,
          title: String(item.title ?? "").slice(0, 240),
          snippet: String(item.snippet ?? "").slice(0, 320),
          domain: String(item.sourceUrl ?? "").slice(0, 160),
          region: item.region ?? null,
          text: itemText(item),
        })),
      };
      callCount += 1;
      const raw = await caller({
        systemPrompt: IDENTITY_SYSTEM_PROMPT,
        userPayload: payload,
      });
      return { batchIdx, raw, refs: batch.map((i) => `inventory:${i.inventoryId}`) };
    },
  }));

  let queued: Awaited<ReturnType<typeof runGptCallQueue<{
    batchIdx: number;
    raw: unknown;
    refs: string[];
  }>>>;
  try {
    queued = await runGptCallQueue({
      tasks,
      options: {
        concurrency: Math.min(2, defaults.concurrency),
        maxAttempts: defaults.maxAttempts,
        deadlineMs: defaults.deadlineMs,
        sleep: offlineSleep,
        ...input.queueOptions,
      },
    });
  } catch (err) {
    // Total queue failure — leave everything AMBIGUOUS.
    return empty({
      inputAmbiguousCount: ambiguousItems.length,
      batchCount: batches.length,
      failures: [
        {
          batch: -1,
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
      unchangedRefs: ambiguousItems.map((i) => `inventory:${i.inventoryId}`),
    });
  }

  for (const result of queued) {
    if (!result.ok) {
      const batchIdx = Number(String(result.key).replace(/\D/g, "")) || 0;
      failures.push({
        batch: batchIdx,
        reason: result.error.message,
      });
      const batch = batches[batchIdx] ?? [];
      for (const item of batch) unchangedRefs.push(`inventory:${item.inventoryId}`);
      continue;
    }

    const { batchIdx, raw, refs } = result.value;
    const parsed = ModelBatchSchema.safeParse(raw);
    if (!parsed.success) {
      failures.push({ batch: batchIdx, reason: `schema: ${parsed.error.message}` });
      unchangedRefs.push(...refs);
      continue;
    }

    const byRef = new Map(parsed.data.decisions.map((d) => [d.ref, d]));
    for (const ref of refs) {
      const row = byRef.get(ref);
      if (!row) {
        unchangedRefs.push(ref);
        continue;
      }
      const clamped = clampGptIdentityDecision(row.decision);
      // Also clamp if the raw object somehow carried SUBJECT_MATCH under another key.
      const reason = String(row.reason ?? "").trim().slice(0, 500) || "без обоснования";

      if (clamped.decision === "AMBIGUOUS") {
        applied.push({
          evidenceRef: ref,
          from: "AMBIGUOUS",
          to: "AMBIGUOUS",
          modelDecision: clamped.modelDecision,
          reason,
          clamped: clamped.clamped,
        });
        unchangedRefs.push(ref);
        continue;
      }

      applyResolutionUpdate({
        evidenceRef: ref,
        nextDecision: clamped.decision,
        reason,
        resolutionByRef: input.resolutionByRef,
        subjectResolution: input.subjectResolution,
      });
      applied.push({
        evidenceRef: ref,
        from: "AMBIGUOUS",
        to: clamped.decision,
        modelDecision: clamped.modelDecision,
        reason,
        clamped: clamped.clamped,
      });
    }
  }

  return {
    version: GPT_IDENTITY_RESOLUTION_VERSION,
    promptVersion: GPT_IDENTITY_PROMPT_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    enabled: true,
    generatedAt,
    batchCount: batches.length,
    callCount,
    inputAmbiguousCount: ambiguousItems.length,
    applied,
    unchangedRefs: [...new Set(unchangedRefs)],
    failures,
    sourceHashes: input.sourceHashes,
  };
}
