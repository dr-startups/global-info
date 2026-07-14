-- P0.5: run-scoped Arsenkin stage ledger
CREATE TABLE IF NOT EXISTS "dp_orion_arsenkin_stage_runs" (
    "id" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planDigest" TEXT,
    "leaseOwnerId" TEXT,
    "maxNewTasks" INTEGER,
    "maxEstimatedLimits" INTEGER,
    "estimatedLimitsTotal" INTEGER,
    "plannedNewTasks" INTEGER,
    "errorJson" JSONB,
    "metadataJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dp_orion_arsenkin_stage_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dp_orion_arsenkin_stage_unique"
  ON "dp_orion_arsenkin_stage_runs"("reportRunId", "stage");

CREATE INDEX IF NOT EXISTS "dp_orion_arsenkin_stage_runs_reportRunId_status_idx"
  ON "dp_orion_arsenkin_stage_runs"("reportRunId", "status");

CREATE INDEX IF NOT EXISTS "dp_orion_arsenkin_stage_runs_caseId_idx"
  ON "dp_orion_arsenkin_stage_runs"("caseId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dp_orion_arsenkin_stage_runs_reportRunId_fkey'
  ) THEN
    ALTER TABLE "dp_orion_arsenkin_stage_runs"
      ADD CONSTRAINT "dp_orion_arsenkin_stage_runs_reportRunId_fkey"
      FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
