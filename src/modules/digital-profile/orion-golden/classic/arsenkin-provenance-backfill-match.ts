/**
 * Pure helpers for Arsenkin provenance backfill (no DB / no API).
 * Fail-closed: exact normalized query match only; no substring matching.
 */

import { createHash } from "node:crypto";

export type BackfillTaskTip = {
  tool: string;
  engine: string;
  region: string;
  queryText?: string;
};

export type BackfillTaskCandidate = {
  id: string;
  toolName: string;
  engine: string | null;
  region: string | null;
  queries: string[];
  reportRunId?: string | null;
  state?: string;
  hasResponseJson?: boolean;
  hasExternalTaskId?: boolean;
};

export type ProposedBackfillLink = {
  kind: "observation" | "coverage";
  id: string;
  providerTaskId: string;
};

export type AmbiguousBackfill = {
  kind: "observation" | "coverage" | string;
  id: string;
  candidateIds: string[];
  reason?: string;
};

export type UnmatchedBackfill = {
  kind: "observation" | "coverage" | string;
  id: string;
  tip: unknown;
  reason?: string;
};

/** Canonical query normalization for exact provenance matching. */
export function normalizeBackfillQuery(raw: string, locale = "ru"): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase(locale);
}

export function queriesMatchExact(a: string, b: string, locale = "ru"): boolean {
  return normalizeBackfillQuery(a, locale) === normalizeBackfillQuery(b, locale);
}

export function isEligibleBackfillTask(
  task: Pick<
    BackfillTaskCandidate,
    "reportRunId" | "state" | "hasResponseJson" | "hasExternalTaskId"
  >,
  reportRunId: string
): boolean {
  if (!reportRunId.trim()) return false;
  if (task.reportRunId != null && task.reportRunId !== reportRunId) return false;
  if (task.state != null && !/^DONE$/i.test(task.state)) return false;
  if (task.hasResponseJson === false) return false;
  if (task.hasExternalTaskId === false) return false;
  return true;
}

export function classifyBackfillMatch(
  tip: BackfillTaskTip,
  candidates: BackfillTaskCandidate[],
  options?: { reportRunId?: string; locale?: string }
): { kind: "unique" | "ambiguous" | "unmatched"; ids: string[]; reason?: string } {
  const locale = options?.locale ?? "ru";
  const reportRunId = options?.reportRunId;
  const matched = candidates.filter((task) => {
    if (reportRunId && !isEligibleBackfillTask(task, reportRunId)) return false;
    if (task.toolName !== tip.tool) return false;
    if (task.engine && task.engine.toUpperCase() !== tip.engine.toUpperCase()) return false;
    const tipRegion = tip.region.toUpperCase();
    if (task.region && task.region.toUpperCase() !== tipRegion) return false;
    if (tip.queryText && tip.queryText.trim()) {
      if (!task.queries.length) return false;
      // Exact equality after normalization only — never substring.
      if (!task.queries.some((q) => queriesMatchExact(q, tip.queryText!, locale))) return false;
    }
    return true;
  });
  if (matched.length === 1) return { kind: "unique", ids: [matched[0]!.id] };
  if (matched.length > 1) {
    return {
      kind: "ambiguous",
      ids: matched.map((m) => m.id).sort(),
      reason: `ambiguous:${matched.length}-candidates`,
    };
  }
  return { kind: "unmatched", ids: [], reason: "no-exact-match" };
}

export function sortProposedBackfillLinks(proposed: ProposedBackfillLink[]): ProposedBackfillLink[] {
  return [...proposed].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return a.providerTaskId.localeCompare(b.providerTaskId);
  });
}

/** Stable plan digest — no timestamps/paths. */
export function computeBackfillPlanDigest(input: {
  reportRunId: string;
  proposed: ProposedBackfillLink[];
  ambiguous: AmbiguousBackfill[];
  unmatched: UnmatchedBackfill[];
  allowUnmatched: boolean;
}): string {
  const payload = {
    reportRunId: input.reportRunId,
    allowUnmatched: input.allowUnmatched,
    proposed: sortProposedBackfillLinks(input.proposed),
    ambiguous: [...input.ambiguous]
      .map((a) => ({
        kind: a.kind,
        id: a.id,
        candidateIds: [...a.candidateIds].sort(),
      }))
      .sort((a, b) => (a.kind !== b.kind ? a.kind.localeCompare(b.kind) : a.id.localeCompare(b.id))),
    unmatched: [...input.unmatched]
      .map((u) => ({ kind: u.kind, id: u.id }))
      .sort((a, b) => (a.kind !== b.kind ? a.kind.localeCompare(b.kind) : a.id.localeCompare(b.id))),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type BackfillApplyGateInput = {
  reportRunId: string;
  mode: "dry-run" | "apply";
  proposed: ProposedBackfillLink[];
  ambiguous: AmbiguousBackfill[];
  unmatched: UnmatchedBackfill[];
  allowUnmatched: boolean;
  confirmPlanDigest?: string | null;
  expectObservations?: number | null;
  expectCoverage?: number | null;
  /** Recomputed digest of current plan (required for apply). */
  planDigest?: string | null;
};

export type BackfillApplyGateResult = {
  ok: boolean;
  blockers: string[];
  proposedObservationCount: number;
  proposedCoverageCount: number;
};

export function evaluateBackfillApplyGate(input: BackfillApplyGateInput): BackfillApplyGateResult {
  const blockers: string[] = [];
  const proposedObservationCount = input.proposed.filter((p) => p.kind === "observation").length;
  const proposedCoverageCount = input.proposed.filter((p) => p.kind === "coverage").length;

  if (!input.reportRunId.trim()) {
    blockers.push("empty-reportRunId");
  }
  if (input.ambiguous.length > 0) {
    blockers.push(`ambiguous=${input.ambiguous.length}`);
  }
  if (input.unmatched.length > 0 && !input.allowUnmatched) {
    blockers.push(`unmatched=${input.unmatched.length}-need-allow-unmatched`);
  }

  if (input.mode === "apply") {
    if (input.expectObservations == null || !Number.isFinite(input.expectObservations) || input.expectObservations < 0) {
      blockers.push("missing-expect-observations");
    } else if (proposedObservationCount !== input.expectObservations) {
      blockers.push(
        `expect-observations-mismatch:expected=${input.expectObservations}:actual=${proposedObservationCount}`
      );
    }
    if (input.expectCoverage == null || !Number.isFinite(input.expectCoverage) || input.expectCoverage < 0) {
      blockers.push("missing-expect-coverage");
    } else if (proposedCoverageCount !== input.expectCoverage) {
      blockers.push(`expect-coverage-mismatch:expected=${input.expectCoverage}:actual=${proposedCoverageCount}`);
    }
    if (!input.confirmPlanDigest?.trim()) {
      blockers.push("missing-confirm-plan-digest");
    }
    if (!input.planDigest?.trim()) {
      blockers.push("missing-plan-digest");
    } else if (input.confirmPlanDigest && input.confirmPlanDigest !== input.planDigest) {
      blockers.push(`plan-digest-mismatch:confirmed=${input.confirmPlanDigest}:current=${input.planDigest}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    proposedObservationCount,
    proposedCoverageCount,
  };
}
