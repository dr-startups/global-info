/**
 * Case-scoped Arsenkin → ORION report binding.
 * Single source of truth for effectiveReportRunId after "Передать результаты в ORION".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../evidence/admin-review-decision-store";
import { writeJsonAtomic } from "../../providers/arsenkin/arsenkin-db-readiness";
import type { ArsenkinWorkflow } from "./arsenkin-stage-ledger";

export type ArsenkinTransferStatus =
  | "READY_TO_TRANSFER"
  | "TRANSFERRING"
  | "TRANSFERRED"
  | "TRANSFER_FAILED"
  | "REPORT_BOUND";

export type ArsenkinReportBinding = {
  caseId: string;
  sourceReportRunId: string;
  effectiveReportRunId: string;
  provider: "arsenkin";
  workflow: ArsenkinWorkflow;
  stage: string;
  status: ArsenkinTransferStatus;
  transferredAt: string;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  lastError?: string | null;
};

export const ARSENKIN_REPORT_BINDING_FILENAME = "arsenkin-report-binding.json";

export function arsenkinReportBindingPath(caseId: string): string {
  return join(
    caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    ARSENKIN_REPORT_BINDING_FILENAME
  );
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function loadArsenkinReportBinding(caseId: string): ArsenkinReportBinding | null {
  const raw = readJson<ArsenkinReportBinding>(arsenkinReportBindingPath(caseId));
  if (!raw || raw.caseId !== caseId) return null;
  if (raw.provider !== "arsenkin") return null;
  if (!raw.effectiveReportRunId || !raw.sourceReportRunId) return null;
  return raw;
}

export function saveArsenkinReportBinding(binding: ArsenkinReportBinding): void {
  writeJsonAtomic(arsenkinReportBindingPath(binding.caseId), binding);
}

export function isArsenkinTransferActive(
  binding: ArsenkinReportBinding | null
): binding is ArsenkinReportBinding {
  return Boolean(
    binding &&
      (binding.status === "TRANSFERRED" ||
        binding.status === "REPORT_BOUND" ||
        binding.status === "TRANSFERRING")
  );
}

/** Prefer transferred Arsenkin effective run; otherwise inventory/fallback. */
export function resolveEffectiveReportRunIdForCase(
  caseId: string,
  fallbackReportRunId: string
): { reportRunId: string; fromArsenkinBinding: boolean; binding: ArsenkinReportBinding | null } {
  const binding = loadArsenkinReportBinding(caseId);
  if (
    binding &&
    (binding.status === "TRANSFERRED" || binding.status === "REPORT_BOUND") &&
    binding.effectiveReportRunId
  ) {
    return {
      reportRunId: binding.effectiveReportRunId,
      fromArsenkinBinding: true,
      binding,
    };
  }
  return {
    reportRunId: fallbackReportRunId,
    fromArsenkinBinding: false,
    binding,
  };
}

export type ArsenkinRenderBindingIssue = {
  code:
    | "ARSENKIN_REPORT_BINDING_MISMATCH"
    | "ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH"
    | "ARSENKIN_OBSERVATIONS_MISSING"
    | "ARSENKIN_PROVIDER_TASK_PROVENANCE_MISSING"
    | "ARSENKIN_COVERAGE_MISSING"
    | "ARSENKIN_SUGGESTION_ASSETS_MISSING";
  detail: string;
};

export class ArsenkinReportBindingError extends Error {
  readonly code: ArsenkinRenderBindingIssue["code"];
  readonly issues: ArsenkinRenderBindingIssue[];

  constructor(issues: ArsenkinRenderBindingIssue[]) {
    const primary = issues[0];
    super(primary ? `${primary.code}: ${primary.detail}` : "ARSENKIN_REPORT_BINDING_MISMATCH");
    this.name = "ArsenkinReportBindingError";
    this.code = primary?.code ?? "ARSENKIN_REPORT_BINDING_MISMATCH";
    this.issues = issues;
  }
}

/**
 * Fail-closed checks when case has TRANSFERRED/REPORT_BOUND Arsenkin binding.
 * Call before heavy PDF work. Does not contact Arsenkin network.
 * Returns skipped=true when no active transfer (legacy ORION path).
 */
export function assertArsenkinTransferredClientContent(input: {
  caseId: string;
  clientContentReportRunId: string;
  binding?: ArsenkinReportBinding | null;
  observationCount?: number;
  providerTaskCount?: number;
  coverageCount?: number;
  requireCanarySuggestions?: boolean;
  hasYandexRuAutocomplete?: boolean;
  hasGoogleRuAutocomplete?: boolean;
}):
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; binding: ArsenkinReportBinding }
  | { ok: false; issues: ArsenkinRenderBindingIssue[] } {
  const binding = input.binding ?? loadArsenkinReportBinding(input.caseId);
  if (!binding || (binding.status !== "TRANSFERRED" && binding.status !== "REPORT_BOUND")) {
    return { ok: true, skipped: true };
  }

  const issues: ArsenkinRenderBindingIssue[] = [];
  const expected = binding.effectiveReportRunId;
  if (input.clientContentReportRunId !== expected) {
    issues.push({
      code: "ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH",
      detail: `clientContent.reportRunId=${input.clientContentReportRunId} expected=${expected}`,
    });
  }
  if (typeof input.observationCount === "number" && input.observationCount <= 0) {
    issues.push({
      code: "ARSENKIN_OBSERVATIONS_MISSING",
      detail: "SerpObservation provider=arsenkin count is 0 for effective run",
    });
  }
  if (typeof input.providerTaskCount === "number" && input.providerTaskCount <= 0) {
    issues.push({
      code: "ARSENKIN_PROVIDER_TASK_PROVENANCE_MISSING",
      detail: "ProviderTask count is 0 for effective run",
    });
  }
  if (typeof input.coverageCount === "number" && input.coverageCount <= 0) {
    issues.push({
      code: "ARSENKIN_COVERAGE_MISSING",
      detail: "SurfaceCollectionCoverage count is 0 for effective run",
    });
  }
  if (input.requireCanarySuggestions) {
    if (!input.hasYandexRuAutocomplete || !input.hasGoogleRuAutocomplete) {
      issues.push({
        code: "ARSENKIN_SUGGESTION_ASSETS_MISSING",
        detail: "Canary requires Yandex RU + Google RU autocomplete observations",
      });
    }
  }
  if (issues.length) {
    return { ok: false, issues };
  }
  return { ok: true, skipped: false, binding };
}
