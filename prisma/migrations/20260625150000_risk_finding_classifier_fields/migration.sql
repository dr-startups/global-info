-- Stage I: Risk Classifier v1 structured fields on risk findings.
ALTER TABLE "dp_risk_findings"
  ADD COLUMN "signalType" TEXT,
  ADD COLUMN "riskTheme" TEXT,
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "rationale" TEXT,
  ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dedupHash" TEXT;

-- Idempotency key for the deterministic classifier. Existing rows have NULL
-- dedupHash; Postgres treats multiple NULLs as distinct so this is safe.
CREATE UNIQUE INDEX "dp_risk_findings_caseId_dedupHash_key"
  ON "dp_risk_findings"("caseId", "dedupHash");
