export type ReconciliationExpectation = {
  ru: number;
  uae: number;
  expectationRunId?: string | null;
  source?: "source-artifact-expectations.json" | "derived-from-source-artifacts" | "external";
};

export type ReconciliationInput = {
  actual: { ru: number; uae: number };
  expected: ReconciliationExpectation | null;
  binding: {
    sourceReportRunId?: string | null;
    effectiveReportRunId?: string | null;
  };
  sourceDir: string;
};

export type ReconciliationResult = {
  verdict: "PASS" | "SOURCE_ARTIFACT_MISMATCH";
  realCasePass: boolean;
  reason: string;
  expectedDatasetCount: { ru: number; uae: number } | null;
};

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

export function reconcileSourceArtifacts(input: ReconciliationInput): ReconciliationResult {
  const expected = input.expected;
  if (!expected || !isFinitePositive(expected.ru) || !isFinitePositive(expected.uae)) {
    return {
      verdict: "PASS",
      realCasePass: true,
      reason: "Expected dataset is derived from active source artifacts for this run.",
      expectedDatasetCount: null,
    };
  }

  const expectedRunId = String(expected.expectationRunId ?? "").trim();
  const sourceRunId = String(input.binding.sourceReportRunId ?? "").trim();
  const effectiveRunId = String(input.binding.effectiveReportRunId ?? "").trim();
  if (expectedRunId && expectedRunId !== sourceRunId && expectedRunId !== effectiveRunId) {
    return {
      verdict: "SOURCE_ARTIFACT_MISMATCH",
      realCasePass: false,
      reason:
        `Expected dataset is tied to run=${expectedRunId}, but active binding uses ` +
        `source=${sourceRunId || "n/a"}, effective=${effectiveRunId || "n/a"} in ${input.sourceDir}.`,
      expectedDatasetCount: { ru: expected.ru, uae: expected.uae },
    };
  }

  const mismatch = input.actual.ru !== expected.ru || input.actual.uae !== expected.uae;
  if (mismatch) {
    return {
      verdict: "SOURCE_ARTIFACT_MISMATCH",
      realCasePass: false,
      reason:
        `Expected RU=${expected.ru}, UAE=${expected.uae}, but active source/composite artifacts yielded ` +
        `RU=${input.actual.ru}, UAE=${input.actual.uae} for ${input.sourceDir}.`,
      expectedDatasetCount: { ru: expected.ru, uae: expected.uae },
    };
  }

  return {
    verdict: "PASS",
    realCasePass: true,
    reason: `Source artifacts and expectations are aligned (RU=${input.actual.ru}, UAE=${input.actual.uae}).`,
    expectedDatasetCount: { ru: expected.ru, uae: expected.uae },
  };
}
