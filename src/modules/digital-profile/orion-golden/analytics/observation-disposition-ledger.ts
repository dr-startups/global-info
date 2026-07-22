/**
 * Stage 1 — build ObservationDisposition ledger over analytics pipeline outputs.
 * Accounts for 100% of raw inventory observations without changing filters/renderer.
 */

import { createHash } from "node:crypto";
import type { RawInventoryItem } from "../types";
import type { Finding } from "../contracts/finding";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import type { SubjectRelevanceDecision } from "../contracts/common";
import {
  DISPOSITION_SUMMARY_SCHEMA_VERSION,
  OBSERVATION_DISPOSITION_LEDGER_SCHEMA_VERSION,
  ObservationDispositionLedgerSchema,
  DispositionSummarySchema,
  type ObservationDispositionEntry,
  type ObservationDispositionKind,
  type ObservationDispositionLedger,
  type DispositionSummary,
} from "../contracts/observation-disposition";
import {
  compositeObservationKey,
  type CompositeSerpProvenance,
} from "./composite-dataset-builder";
import type { FindingSynthesisResult } from "./finding-synthesizer";
import { resolveFindingThemesConfig } from "../../config/finding-themes";

const ADVERSE_THEME_HINT =
  /уголов|criminal|арест|санкц|sanction|корруп|corrupt|фбк|расследован|investigat|суд|court|офшор|offshore|pep|rca|watch.?list|скандал|yacht|рыбк|navalny|навальн/iu;

const FORBIDDEN_SILENT_EXCLUDE_REASONS =
  /top[_-]?n|source[_-]?quality|date|recency|low[_-]?confidence|confidence[_-]?threshold/iu;

export type DispositionLedgerBuildInput = {
  caseId: string;
  datasetId: string;
  inventoryReportRunId: string;
  sourceHashes: string[];
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  synthesis: FindingSynthesisResult;
  provenance?: CompositeSerpProvenance | null;
  /** Optional: executive key finding ids — used only for OTHER_SUBJECT_IN_SUBJECT_KPI gate. */
  kpiFindingIds?: Set<string>;
};

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function sourceEvidenceRefs(item: RawInventoryItem): string[] {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const raw = meta.sourceEvidenceRefs;
  if (!Array.isArray(raw)) return [refOf(item)];
  const refs = raw
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const kind = String(o.kind ?? o.type ?? "evidence");
        const id = String(o.id ?? o.ref ?? "");
        return id ? `${kind}:${id}` : "";
      }
      return "";
    })
    .filter(Boolean);
  return refs.length > 0 ? refs : [refOf(item)];
}

function fullTextRefOf(item: RawInventoryItem): string | null {
  if (item.storageRef) return item.storageRef;
  if (item.sourceUrl) return `url:${item.sourceUrl}`;
  return null;
}

function materialitySignalsFor(
  item: RawInventoryItem,
  themes: string[],
  adverseRe: RegExp
): string[] {
  const text = [item.title, item.snippet, item.classification].filter(Boolean).join(" ");
  const signals: string[] = [];
  if (adverseRe.test(text) || ADVERSE_THEME_HINT.test(text)) signals.push("adverse_text");
  for (const t of themes) {
    if (
      /criminal|pep|political|offshore|financial|security|family|corrupt|sanction/iu.test(t)
    ) {
      signals.push(`theme:${t}`);
    }
  }
  if (/currenttime|theguardian|nytimes|reuters|rucriminal|sledstvie/iu.test(item.sourceUrl ?? "")) {
    signals.push("notable_domain");
  }
  return [...new Set(signals)];
}

function isPotentiallyMaterialAdverse(signals: string[], themes: string[]): boolean {
  return signals.some((s) => s === "adverse_text" || s.startsWith("theme:")) || themes.length > 0;
}

type FindingLite = Pick<
  Finding,
  "findingId" | "subjectMatch" | "promotionPriority" | "riskLevel" | "confidence" | "evidenceRefs" | "theme"
>;

function buildFindingIndex(synthesis: FindingSynthesisResult): {
  byRef: Map<string, FindingLite[]>;
  kpiRefs: Set<string>;
  otherSubjectFindingRefs: Set<string>;
} {
  const byRef = new Map<string, FindingLite[]>();
  const kpiRefs = new Set<string>();
  const otherSubjectFindingRefs = new Set<string>();
  const allFindings: FindingLite[] = [
    ...synthesis.bundle.findings,
    ...synthesis.ambiguousFindings,
  ];
  const excluded = new Set(synthesis.bundle.excludedFindingIds);
  for (const f of allFindings) {
    for (const r of f.evidenceRefs ?? []) {
      const list = byRef.get(r) ?? [];
      list.push(f);
      byRef.set(r, list);
      if (f.subjectMatch === "OTHER_SUBJECT" || excluded.has(f.findingId)) {
        otherSubjectFindingRefs.add(r);
      }
      if (
        f.subjectMatch === "SUBJECT_MATCH" &&
        !excluded.has(f.findingId) &&
        (f.promotionPriority === "P1" || f.promotionPriority === "P2")
      ) {
        kpiRefs.add(r);
      }
    }
  }
  return { byRef, kpiRefs, otherSubjectFindingRefs };
}

function buildDuplicateGroups(
  items: RawInventoryItem[],
  provenance?: CompositeSerpProvenance | null
): Map<string, { groupId: string; primaryRef: string; memberRefs: string[] }> {
  const byKey = new Map<string, string[]>();
  if (provenance?.entries?.length) {
    for (const e of provenance.entries) {
      const refs = [...e.evidenceRefs].sort();
      if (refs.length === 0) continue;
      byKey.set(e.observationKey, refs);
    }
  } else {
    for (const item of items) {
      const key = compositeObservationKey(item);
      const ref = refOf(item);
      const bucket = byKey.get(key) ?? [];
      bucket.push(ref);
      byKey.set(key, bucket);
    }
    for (const [k, refs] of byKey) {
      byKey.set(k, [...new Set(refs)].sort());
    }
  }

  const out = new Map<string, { groupId: string; primaryRef: string; memberRefs: string[] }>();
  for (const [observationKey, memberRefs] of byKey) {
    if (memberRefs.length <= 1) continue;
    const primaryRef = memberRefs[0]!;
    const groupId = `dup:${createHash("sha1").update(observationKey).digest("hex").slice(0, 12)}`;
    for (const r of memberRefs) {
      out.set(r, { groupId, primaryRef, memberRefs });
    }
  }
  return out;
}

function decideDisposition(input: {
  ref: string;
  decision: SubjectRelevanceDecision;
  themes: string[];
  findings: FindingLite[];
  uncategorized: boolean;
  duplicate: { groupId: string; primaryRef: string } | null;
  material: boolean;
  invalid: boolean;
}): {
  disposition: ObservationDispositionKind;
  reasonCode: string;
  duplicateOf: string | null;
  duplicateGroupId: string | null;
  stage: string;
  functionName: string;
} {
  if (input.invalid) {
    return {
      disposition: "EXCLUDE_INVALID",
      reasonCode: "invalid_empty_observation",
      duplicateOf: null,
      duplicateGroupId: null,
      stage: "observation-disposition",
      functionName: "buildObservationDispositionLedger",
    };
  }

  if (input.decision === "OTHER_SUBJECT") {
    return {
      disposition: "EXCLUDE_OTHER_SUBJECT",
      reasonCode: "subject_resolution:OTHER_SUBJECT",
      duplicateOf: null,
      duplicateGroupId: null,
      stage: "subject-resolution",
      functionName: "classifySubjectRelevance",
    };
  }

  // Duplicates keep provenance: non-primary members are EXCLUDE_DUPLICATE but
  // remain in the ledger with duplicateOf → primary.
  if (input.duplicate && input.duplicate.primaryRef !== input.ref) {
    return {
      disposition: "EXCLUDE_DUPLICATE",
      reasonCode: "composite_dedupe:secondary_in_group",
      duplicateOf: input.duplicate.primaryRef,
      duplicateGroupId: input.duplicate.groupId,
      stage: "composite-dataset",
      functionName: "buildAnalyticsCompositeDataset",
    };
  }

  if (input.decision === "AMBIGUOUS" || input.decision === "INSUFFICIENT_IDENTIFIERS") {
    return {
      disposition:
        input.decision === "AMBIGUOUS" ? "APPENDIX_AMBIGUOUS" : "APPENDIX_AMBIGUOUS",
      reasonCode:
        input.decision === "AMBIGUOUS"
          ? "subject_resolution:AMBIGUOUS_review"
          : "subject_resolution:INSUFFICIENT_IDENTIFIERS_review",
      duplicateOf: null,
      duplicateGroupId: input.duplicate?.groupId ?? null,
      stage: "subject-resolution",
      functionName: "classifySubjectRelevance",
    };
  }

  const p12 = input.findings.some(
    (f) => f.promotionPriority === "P1" || f.promotionPriority === "P2"
  );
  const inFinding = input.findings.length > 0;

  if (input.decision === "SUBJECT_MATCH") {
    if (p12 || (inFinding && input.material)) {
      return {
        disposition: "KEEP_PRIMARY",
        reasonCode: p12 ? "finding:P1_P2_primary_evidence" : "finding:subject_match_evidence",
        duplicateOf: null,
        duplicateGroupId: input.duplicate?.groupId ?? null,
        stage: "finding-synthesis",
        functionName: "synthesizeFindings",
      };
    }
    if (inFinding) {
      return {
        disposition: "KEEP_SUPPORTING",
        reasonCode: "finding:supporting_evidence",
        duplicateOf: null,
        duplicateGroupId: input.duplicate?.groupId ?? null,
        stage: "finding-synthesis",
        functionName: "synthesizeFindings",
      };
    }
    if (input.themes.length > 0) {
      return {
        disposition: "KEEP_SUPPORTING",
        reasonCode: "theme_assigned:supporting",
        duplicateOf: null,
        duplicateGroupId: input.duplicate?.groupId ?? null,
        stage: "finding-synthesis",
        functionName: "synthesizeFindings",
      };
    }
    // Uncategorized / no theme — still KEEP, never silent drop (Stage 1 rule 3).
    return {
      disposition: "KEEP_SUPPORTING",
      reasonCode: input.uncategorized
        ? "uncategorized:pending_theme_review"
        : input.material
          ? "material_adverse:held_for_review"
          : "subject_match:no_theme_supporting",
      duplicateOf: null,
      duplicateGroupId: input.duplicate?.groupId ?? null,
      stage: "finding-synthesis",
      functionName: "synthesizeFindings",
    };
  }

  // LIKELY_SUBJECT — visible supporting / appendix path, never subject KPI fact.
  if (input.decision === "LIKELY_SUBJECT") {
    if (input.material || inFinding) {
      return {
        disposition: "KEEP_SUPPORTING",
        reasonCode: inFinding
          ? "finding:likely_subject_supporting"
          : "likely_subject:material_supporting",
        duplicateOf: null,
        duplicateGroupId: input.duplicate?.groupId ?? null,
        stage: "finding-synthesis",
        functionName: "synthesizeFindings",
      };
    }
    return {
      disposition: "KEEP_SUPPORTING",
      reasonCode: input.uncategorized
        ? "uncategorized:likely_pending_theme"
        : "likely_subject:supporting",
      duplicateOf: null,
      duplicateGroupId: input.duplicate?.groupId ?? null,
      stage: "finding-synthesis",
      functionName: "synthesizeFindings",
    };
  }

  return {
    disposition: "KEEP_SUPPORTING",
    reasonCode: "fallback:accounted_supporting",
    duplicateOf: null,
    duplicateGroupId: input.duplicate?.groupId ?? null,
    stage: "observation-disposition",
    functionName: "buildObservationDispositionLedger",
  };
}

export function buildObservationDispositionLedger(
  input: DispositionLedgerBuildInput
): ObservationDispositionLedger {
  const cfg = resolveFindingThemesConfig();
  const adverseRe = cfg.adversePatterns;
  const { byRef: findingsByRef } = buildFindingIndex(input.synthesis);
  const uncatSet = new Set(input.synthesis.uncategorized.allEvidenceRefs);
  const dupGroups = buildDuplicateGroups(input.items, input.provenance);

  // Deterministic order: sort by inventoryId so shuffle of input items yields
  // the same ledger content (gates + dispositions).
  const sortedItems = [...input.items].sort((a, b) =>
    a.inventoryId.localeCompare(b.inventoryId)
  );

  const entries: ObservationDispositionEntry[] = [];
  let unreasoned = 0;
  let p1p2Silent = 0;
  let otherInKpi = 0;

  const kpiFindingIds = input.kpiFindingIds ?? new Set(
    input.synthesis.bundle.findings
      .filter(
        (f) =>
          f.subjectMatch === "SUBJECT_MATCH" &&
          !input.synthesis.bundle.excludedFindingIds.includes(f.findingId) &&
          (f.promotionPriority === "P1" || f.promotionPriority === "P2")
      )
      .map((f) => f.findingId)
  );

  for (const item of sortedItems) {
    const ref = refOf(item);
    const resolution = input.resolutionByRef.get(ref);
    const decision: SubjectRelevanceDecision = resolution?.decision ?? "INSUFFICIENT_IDENTIFIERS";
    const confidence = resolution?.confidence ?? 0;
    const themes = [...(input.synthesis.themeAssignments.get(ref) ?? [])].sort();
    const findings = findingsByRef.get(ref) ?? [];
    const signals = materialitySignalsFor(item, themes, adverseRe);
    const material = isPotentiallyMaterialAdverse(signals, themes);
    const invalid = !String(item.title ?? "").trim() && !String(item.snippet ?? "").trim();
    const dup = dupGroups.get(ref) ?? null;

    const decided = decideDisposition({
      ref,
      decision,
      themes,
      findings,
      uncategorized: uncatSet.has(ref),
      duplicate: dup,
      material,
      invalid,
    });

    if (!decided.reasonCode?.trim()) unreasoned += 1;

    // Gate: never exclude material P1/P2-class evidence for soft ranking reasons.
    if (
      (decided.disposition === "EXCLUDE_INVALID" ||
        decided.disposition === "EXCLUDE_DUPLICATE") &&
      material &&
      (findings.some((f) => f.promotionPriority === "P1" || f.promotionPriority === "P2") ||
        signals.includes("adverse_text")) &&
      FORBIDDEN_SILENT_EXCLUDE_REASONS.test(decided.reasonCode)
    ) {
      p1p2Silent += 1;
    }
    // Also count if material adverse SUBJECT_MATCH got EXCLUDE_INVALID for soft reasons.
    if (
      decided.disposition === "EXCLUDE_INVALID" &&
      material &&
      (decision === "SUBJECT_MATCH" || decision === "LIKELY_SUBJECT") &&
      !invalid
    ) {
      p1p2Silent += 1;
    }

    // OTHER_SUBJECT must not appear as evidence on KPI findings.
    if (decision === "OTHER_SUBJECT") {
      for (const f of findings) {
        if (kpiFindingIds.has(f.findingId)) {
          otherInKpi += 1;
        }
      }
    }

    const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
    entries.push({
      rawObservationId: ref,
      normalizedObservationId: compositeObservationKey(item),
      disposition: decided.disposition,
      reasonCode: decided.reasonCode,
      subjectDecision: decision,
      confidence,
      themeCandidates: themes,
      materialitySignals: signals,
      duplicateOf: decided.duplicateOf,
      duplicateGroupId: decided.duplicateGroupId,
      evidenceRefs: [ref, ...sourceEvidenceRefs(item)].filter(
        (v, i, a) => a.indexOf(v) === i
      ),
      provenance: {
        source: item.source,
        provider: item.provider,
        reportRunId: item.reportRunId,
        region: item.region,
        surface: String(meta.surface ?? item.evidenceType ?? ""),
        observationKey: compositeObservationKey(item),
        sourceEvidenceRefs: sourceEvidenceRefs(item),
      },
      originalTitle: String(item.title ?? ""),
      originalSnippet: String(item.snippet ?? ""),
      fullTextRef: fullTextRefOf(item),
      decidedBy: {
        stage: decided.stage,
        functionName: decided.functionName,
      },
    });
  }

  const accounting =
    input.items.length === 0
      ? 100
      : Math.round((entries.length / input.items.length) * 10000) / 100;

  const ledger: ObservationDispositionLedger = {
    schemaVersion: OBSERVATION_DISPOSITION_LEDGER_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: entries.map((e) => e.rawObservationId),
    inventoryReportRunId: input.inventoryReportRunId,
    rawObservationCount: input.items.length,
    entries,
    gates: {
      RAW_OBSERVATION_ACCOUNTING: accounting,
      UNREASONED_DROPS: unreasoned,
      P1_P2_SILENT_DROPS: p1p2Silent,
      OTHER_SUBJECT_IN_SUBJECT_KPI: otherInKpi,
    },
  };

  return ObservationDispositionLedgerSchema.parse(ledger);
}

export function buildDispositionSummary(
  ledger: ObservationDispositionLedger
): DispositionSummary {
  const byDisposition: Record<string, number> = {};
  const bySubjectDecision: Record<string, number> = {};
  const byReasonCode: Record<string, number> = {};
  const groups = new Set<string>();
  for (const e of ledger.entries) {
    byDisposition[e.disposition] = (byDisposition[e.disposition] ?? 0) + 1;
    bySubjectDecision[e.subjectDecision] =
      (bySubjectDecision[e.subjectDecision] ?? 0) + 1;
    byReasonCode[e.reasonCode] = (byReasonCode[e.reasonCode] ?? 0) + 1;
    if (e.duplicateGroupId) groups.add(e.duplicateGroupId);
  }
  const summary: DispositionSummary = {
    schemaVersion: DISPOSITION_SUMMARY_SCHEMA_VERSION,
    caseId: ledger.caseId,
    datasetId: ledger.datasetId,
    rawObservationCount: ledger.rawObservationCount,
    byDisposition,
    bySubjectDecision,
    byReasonCode,
    duplicateGroupCount: groups.size,
    gates: ledger.gates,
    generatedAt: new Date().toISOString(),
  };
  return DispositionSummarySchema.parse(summary);
}

/** Stable content fingerprint ignoring entry array order. */
export function ledgerContentFingerprint(ledger: ObservationDispositionLedger): string {
  const rows = [...ledger.entries]
    .map((e) =>
      [
        e.rawObservationId,
        e.disposition,
        e.reasonCode,
        e.subjectDecision,
        e.duplicateOf ?? "",
        e.duplicateGroupId ?? "",
        e.themeCandidates.join(","),
      ].join("|")
    )
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export function assertDispositionGatesPass(ledger: ObservationDispositionLedger): void {
  const g = ledger.gates;
  if (g.RAW_OBSERVATION_ACCOUNTING !== 100) {
    throw new Error(`RAW_OBSERVATION_ACCOUNTING=${g.RAW_OBSERVATION_ACCOUNTING}`);
  }
  if (ledger.entries.length !== ledger.rawObservationCount) {
    throw new Error(
      `entry count ${ledger.entries.length} != rawObservationCount ${ledger.rawObservationCount}`
    );
  }
  if (g.UNREASONED_DROPS !== 0) {
    throw new Error(`UNREASONED_DROPS=${g.UNREASONED_DROPS}`);
  }
  if (g.P1_P2_SILENT_DROPS !== 0) {
    throw new Error(`P1_P2_SILENT_DROPS=${g.P1_P2_SILENT_DROPS}`);
  }
  if (g.OTHER_SUBJECT_IN_SUBJECT_KPI !== 0) {
    throw new Error(`OTHER_SUBJECT_IN_SUBJECT_KPI=${g.OTHER_SUBJECT_IN_SUBJECT_KPI}`);
  }
}
