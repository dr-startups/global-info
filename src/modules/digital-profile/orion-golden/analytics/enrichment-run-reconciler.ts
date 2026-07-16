/**
 * Prompt 2 fix — fail-closed, lineage-safe enrichment-run reconciliation.
 *
 * The binding on disk may under-list CaseAgent enrichment runs (e.g. only the
 * suggest canary) or belong to a different case entirely. This reconciler:
 * - preserves the canonical baseReportRunId;
 * - includes every enrichment run PROVEN to belong to the same caseId and
 *   report lineage (explicit binding, in-lineage observations, provider
 *   tasks, or CaseAgent records with matching case + base);
 * - rejects stale/foreign run IDs with explicit reasons;
 * - emits explicit gaps for orphan runs instead of loose case-wide discovery;
 * - is deterministic and idempotent (pure function of its inputs).
 */

import type { ArsenkinReportBindingV2 } from "../classic/arsenkin-report-binding";

export type EnrichmentRunEvidence = {
  /** Distinct reportRunIds of enrichment observations inside this run's inventory. */
  observedRunIds: string[];
  /** reportRunIds referenced by provider tasks persisted for this run. */
  providerTaskRunIds?: string[];
  /** reportRunIds referenced by surface-coverage rows persisted for this run. */
  coverageRunIds?: string[];
};

export type CaseAgentRunRecord = {
  reportRunId: string;
  caseId: string;
  stage?: string;
  workflow?: string;
  sourceReportRunId?: string | null;
  subjectDisplayName?: string | null;
};

export type ReconciledRun = {
  reportRunId: string;
  source: "binding" | "observations" | "provider_tasks" | "case_agent_record";
  workflow: string | null;
  stage: string | null;
  proof: string[];
  /** True when enrichment observations live under the base run itself. */
  inRunEnrichment: boolean;
};

export type RejectedRun = {
  reportRunId: string;
  source: string;
  reason:
    | "FOREIGN_BINDING_CASE_MISMATCH"
    | "FOREIGN_CASE_ID"
    | "STALE_BASE_LINEAGE"
    | "SUBJECT_MISMATCH"
    | "NO_LINEAGE_PROOF";
  detail: string;
};

export type ReconciliationGap = {
  kind: "FOREIGN_BINDING" | "ORPHAN_ENRICHMENT_RUN" | "NO_BINDING_FOR_CASE";
  detail: string;
};

export type EnrichmentRunReconciliation = {
  schemaVersion: "enrichment-run-reconciliation-v1";
  caseId: string;
  baseReportRunId: string;
  /** Complete ordered list: binding order first, then proven extras (sorted). */
  enrichmentRunIds: string[];
  includedRuns: ReconciledRun[];
  rejectedRuns: RejectedRun[];
  gaps: ReconciliationGap[];
  diagnostics: {
    providerTaskRunCoverage: Record<string, boolean>;
    coverageRunCoverage: Record<string, boolean>;
  };
};

export function reconcileEnrichmentRuns(input: {
  caseId: string;
  subjectDisplayName: string;
  inventoryReportRunId: string;
  binding: ArsenkinReportBindingV2 | null;
  evidence: EnrichmentRunEvidence;
  caseAgentRecords?: CaseAgentRunRecord[];
}): EnrichmentRunReconciliation {
  const included = new Map<string, ReconciledRun>();
  const rejected: RejectedRun[] = [];
  const gaps: ReconciliationGap[] = [];

  const observed = new Set(input.evidence.observedRunIds);
  const taskRuns = new Set(input.evidence.providerTaskRunIds ?? []);
  const coverageRuns = new Set(input.evidence.coverageRunIds ?? []);

  // --- Binding validation (fail-closed on case identity). ---
  const bindingIsSameCase = Boolean(input.binding && input.binding.caseId === input.caseId);
  if (input.binding && !bindingIsSameCase) {
    gaps.push({
      kind: "FOREIGN_BINDING",
      detail: `binding caseId=${input.binding.caseId} does not match case ${input.caseId}; binding ignored`,
    });
    for (const run of input.binding.enrichmentRuns ?? []) {
      rejected.push({
        reportRunId: run.reportRunId,
        source: "binding",
        reason: "FOREIGN_BINDING_CASE_MISMATCH",
        detail: `binding caseId=${input.binding.caseId}`,
      });
    }
  }

  // Canonical base: same-case binding may point at the true source run;
  // otherwise the inventory's own run is canonical.
  const baseReportRunId =
    bindingIsSameCase && input.binding?.sourceReportRunId
      ? input.binding.sourceReportRunId
      : input.inventoryReportRunId;

  const proveLineage = (runId: string): string[] => {
    const proof: string[] = [];
    if (observed.has(runId)) proof.push("observations_in_run_inventory");
    if (taskRuns.has(runId)) proof.push("provider_tasks_in_run");
    if (coverageRuns.has(runId)) proof.push("coverage_rows_in_run");
    return proof;
  };

  // --- 1. Explicitly bound runs (binding order preserved). ---
  if (bindingIsSameCase && input.binding) {
    for (const run of input.binding.enrichmentRuns ?? []) {
      const proof = ["explicit_binding_same_case", ...proveLineage(run.reportRunId)];
      included.set(run.reportRunId, {
        reportRunId: run.reportRunId,
        source: "binding",
        workflow: run.workflow ?? null,
        stage: run.stage ?? null,
        proof,
        inRunEnrichment: run.reportRunId === baseReportRunId,
      });
    }
  }

  // --- 2. Runs proven by in-lineage evidence (observations/tasks/coverage). ---
  const evidenceRunIds = [...new Set([...observed, ...taskRuns, ...coverageRuns])].sort();
  for (const runId of evidenceRunIds) {
    if (included.has(runId)) continue;
    const proof = proveLineage(runId);
    if (!proof.includes("observations_in_run_inventory")) {
      // Tasks/coverage referencing a run with zero observations in this
      // inventory: not enough on its own — explicit gap, not inclusion.
      gaps.push({
        kind: "ORPHAN_ENRICHMENT_RUN",
        detail: `run ${runId} referenced by ${proof.join("+") || "nothing"} but has no observations in run inventory; not bound`,
      });
      continue;
    }
    included.set(runId, {
      reportRunId: runId,
      source: "observations",
      workflow: null,
      stage: null,
      proof,
      inRunEnrichment: runId === baseReportRunId || runId === input.inventoryReportRunId,
    });
  }

  // --- 3. CaseAgent records: strict case + lineage proof required. ---
  for (const record of input.caseAgentRecords ?? []) {
    if (included.has(record.reportRunId)) {
      const entry = included.get(record.reportRunId)!;
      entry.proof.push("case_agent_record");
      if (!entry.workflow && record.workflow) entry.workflow = record.workflow;
      if (!entry.stage && record.stage) entry.stage = record.stage;
      continue;
    }
    if (record.caseId !== input.caseId) {
      rejected.push({
        reportRunId: record.reportRunId,
        source: "case_agent_record",
        reason: "FOREIGN_CASE_ID",
        detail: `record caseId=${record.caseId}`,
      });
      continue;
    }
    if (
      record.subjectDisplayName &&
      record.subjectDisplayName.trim() !== "" &&
      record.subjectDisplayName.trim().toLowerCase() !==
        input.subjectDisplayName.trim().toLowerCase()
    ) {
      rejected.push({
        reportRunId: record.reportRunId,
        source: "case_agent_record",
        reason: "SUBJECT_MISMATCH",
        detail: `record subject=${record.subjectDisplayName}`,
      });
      continue;
    }
    const lineageOk =
      record.sourceReportRunId == null ||
      record.sourceReportRunId === baseReportRunId ||
      record.sourceReportRunId === input.inventoryReportRunId;
    if (!lineageOk) {
      rejected.push({
        reportRunId: record.reportRunId,
        source: "case_agent_record",
        reason: "STALE_BASE_LINEAGE",
        detail: `record sourceReportRunId=${record.sourceReportRunId} != base ${baseReportRunId}`,
      });
      continue;
    }
    const proof = proveLineage(record.reportRunId);
    if (proof.length === 0 && record.sourceReportRunId == null) {
      // Same case, but nothing ties the run to THIS report lineage.
      rejected.push({
        reportRunId: record.reportRunId,
        source: "case_agent_record",
        reason: "NO_LINEAGE_PROOF",
        detail: "record has neither sourceReportRunId nor in-run evidence",
      });
      continue;
    }
    included.set(record.reportRunId, {
      reportRunId: record.reportRunId,
      source: "case_agent_record",
      workflow: record.workflow ?? null,
      stage: record.stage ?? null,
      proof: ["case_agent_record_same_case_lineage", ...proof],
      inRunEnrichment: record.reportRunId === baseReportRunId,
    });
  }

  if (!input.binding) {
    gaps.push({
      kind: "NO_BINDING_FOR_CASE",
      detail: `no arsenkin-report-binding.json for case ${input.caseId}; runs proven from in-lineage evidence only`,
    });
  }

  // Deterministic order: binding-listed first (binding order), then the rest sorted.
  const bindingOrder =
    bindingIsSameCase && input.binding
      ? (input.binding.enrichmentRuns ?? []).map((r) => r.reportRunId)
      : [];
  const rest = [...included.keys()].filter((id) => !bindingOrder.includes(id)).sort();
  const enrichmentRunIds = [...bindingOrder.filter((id) => included.has(id)), ...rest];

  return {
    schemaVersion: "enrichment-run-reconciliation-v1",
    caseId: input.caseId,
    baseReportRunId,
    enrichmentRunIds,
    includedRuns: enrichmentRunIds.map((id) => included.get(id)!),
    rejectedRuns: rejected.sort((a, b) => a.reportRunId.localeCompare(b.reportRunId)),
    gaps,
    diagnostics: {
      providerTaskRunCoverage: Object.fromEntries(
        [...taskRuns].sort().map((id) => [id, enrichmentRunIds.includes(id)])
      ),
      coverageRunCoverage: Object.fromEntries(
        [...coverageRuns].sort().map((id) => [id, enrichmentRunIds.includes(id)])
      ),
    },
  };
}

/**
 * Acceptance-binding style check: every reconciled enrichment run must be
 * known to the acceptance composite binding, otherwise the gate would pass an
 * incomplete enrichment list (the "under-list" defect).
 */
export function checkAcceptanceEnrichmentCoverage(input: {
  acceptanceEnrichmentRunIds: string[];
  reconciledEnrichmentRunIds: string[];
  baseReportRunId: string;
}): { ok: boolean; missingFromAcceptance: string[] } {
  const known = new Set([...input.acceptanceEnrichmentRunIds, input.baseReportRunId]);
  const missing = input.reconciledEnrichmentRunIds.filter((id) => !known.has(id));
  return { ok: missing.length === 0, missingFromAcceptance: missing };
}
