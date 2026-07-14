/**
 * Fresh canary OrionReportRun lifecycle (status is free String in Prisma).
 *
 * ABSENT → PREPARED → RUNNING → DONE
 *                        ↘ FAILED
 */

export type CanaryRunStatus = "PREPARED" | "RUNNING" | "DONE" | "FAILED";

export type CanaryRunRow = {
  id: string;
  caseId: string;
  status: string;
  mode?: string | null;
  metadataJson?: unknown;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

export type FreshCanaryCounts = {
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
};

export type ValidateFreshCanaryRunInput = {
  caseId: string;
  reportRunId: string;
  run: CanaryRunRow | null;
  counts: FreshCanaryCounts;
  /** Default false — first canary must be clean PREPARED. */
  resumeExisting?: boolean;
  expectedMode?: string;
};

export type ValidateFreshCanaryRunResult = {
  ok: boolean;
  blockers: string[];
  lifecycle: "ABSENT" | CanaryRunStatus | "UNKNOWN";
};

export function canaryLifecycleOf(run: CanaryRunRow | null): ValidateFreshCanaryRunResult["lifecycle"] {
  if (!run) return "ABSENT";
  const s = String(run.status ?? "").toUpperCase();
  if (s === "PREPARED" || s === "RUNNING" || s === "DONE" || s === "FAILED") return s;
  return "UNKNOWN";
}

export function validateFreshCanaryRun(
  input: ValidateFreshCanaryRunInput
): ValidateFreshCanaryRunResult {
  const blockers: string[] = [];
  const lifecycle = canaryLifecycleOf(input.run);
  const resume = Boolean(input.resumeExisting);

  if (!input.run) {
    blockers.push("run-absent");
    return { ok: false, blockers, lifecycle };
  }
  if (input.run.id !== input.reportRunId) {
    blockers.push("run-id-mismatch");
  }
  if (input.run.caseId !== input.caseId) {
    blockers.push("run-caseId-mismatch");
  }

  if (!resume) {
    if (lifecycle !== "PREPARED") {
      blockers.push(`fresh-requires-PREPARED:got=${lifecycle}`);
    }
    if (input.counts.providerTaskCount !== 0) {
      blockers.push(`fresh-providerTask-not-empty:${input.counts.providerTaskCount}`);
    }
    if (input.counts.observationCount !== 0) {
      blockers.push(`fresh-observations-not-empty:${input.counts.observationCount}`);
    }
    if (input.counts.coverageCount !== 0) {
      blockers.push(`fresh-coverage-not-empty:${input.counts.coverageCount}`);
    }
  } else {
    if (lifecycle === "DONE") {
      blockers.push("resume-blocked-DONE");
    }
    if (lifecycle === "FAILED") {
      blockers.push("resume-blocked-FAILED");
    }
    if (lifecycle === "ABSENT" || lifecycle === "UNKNOWN") {
      blockers.push(`resume-invalid-lifecycle:${lifecycle}`);
    }
  }

  if (input.expectedMode && input.run.mode && input.run.mode !== input.expectedMode) {
    blockers.push(`run-mode-mismatch:expected=${input.expectedMode}:got=${input.run.mode}`);
  }

  return { ok: blockers.length === 0, blockers, lifecycle };
}

export type TransitionCanaryRunInput = {
  from: CanaryRunStatus | "ABSENT";
  to: CanaryRunStatus;
  currentStatus: string | null;
  ownerId?: string | null;
  expectedOwnerId?: string | null;
};

export type TransitionCanaryRunResult = {
  ok: boolean;
  blockers: string[];
  nextStatus: CanaryRunStatus | null;
};

const ALLOWED: Record<string, CanaryRunStatus[]> = {
  ABSENT: ["PREPARED"],
  PREPARED: ["RUNNING", "FAILED"],
  RUNNING: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

/** Pure transition rules + optional lease owner CAS check. */
export function transitionCanaryRun(input: TransitionCanaryRunInput): TransitionCanaryRunResult {
  const blockers: string[] = [];
  const from = input.from;
  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(input.to)) {
    blockers.push(`illegal-transition:${from}->${input.to}`);
  }
  if (from !== "ABSENT") {
    const cur = String(input.currentStatus ?? "").toUpperCase();
    if (cur !== from) {
      blockers.push(`current-status-mismatch:expected=${from}:got=${cur || "null"}`);
    }
  }
  if (input.to === "RUNNING" && input.expectedOwnerId != null) {
    // Claiming PREPARED→RUNNING: expectedOwner must be unset or match.
    if (input.ownerId && input.ownerId !== input.expectedOwnerId) {
      blockers.push("lease-owner-mismatch");
    }
  }
  if (from === "RUNNING" && input.expectedOwnerId && input.ownerId !== input.expectedOwnerId) {
    blockers.push("lease-owner-mismatch");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    nextStatus: blockers.length === 0 ? input.to : null,
  };
}

export type PrepareCanaryRunSpec = {
  id: string;
  caseId: string;
  mode: string;
  status: "PREPARED";
  internalOnly: true;
  startedAt: null;
  finishedAt: null;
  metadataJson: {
    canary: true;
    stage: string;
    preparedAt: string;
    leaseOwnerId: null;
  };
};

export function buildPrepareCanaryRunSpec(input: {
  reportRunId: string;
  caseId: string;
  stage: string;
  preparedAtIso: string;
}): PrepareCanaryRunSpec {
  return {
    id: input.reportRunId,
    caseId: input.caseId,
    mode: "classic_first36_canary",
    status: "PREPARED",
    internalOnly: true,
    startedAt: null,
    finishedAt: null,
    metadataJson: {
      canary: true,
      stage: input.stage,
      preparedAt: input.preparedAtIso,
      leaseOwnerId: null,
    },
  };
}
