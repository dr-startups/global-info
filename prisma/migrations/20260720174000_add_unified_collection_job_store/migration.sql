-- REMEDIATION §9.4: Postgres-backed unified collection job store (atomic lease CAS).
-- Artifacts remain on disk; this table stores job metadata + storage keys.

CREATE TABLE IF NOT EXISTS "dp_unified_collection_jobs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "unifiedJobId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "versionNum" INTEGER NOT NULL DEFAULT 0,
    "leaseOwnerId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "requestedBy" TEXT NOT NULL,
    "arsenkinMode" TEXT,
    "baseReportRunId" TEXT,
    "arsenkinReportRunId" TEXT,
    "compositeDatasetId" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "resumeCheckpoint" TEXT,
    "nextPollAt" TIMESTAMP(3),
    "pollAttempt" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "artifactKeys" JSONB NOT NULL DEFAULT '{}',
    "reportLinkKeys" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "dp_unified_collection_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dp_unified_collection_jobs_caseId_key"
  ON "dp_unified_collection_jobs"("caseId");

CREATE UNIQUE INDEX IF NOT EXISTS "dp_unified_collection_jobs_jobId_key"
  ON "dp_unified_collection_jobs"("jobId");

CREATE INDEX IF NOT EXISTS "dp_unified_collection_jobs_status_stage_idx"
  ON "dp_unified_collection_jobs"("status", "stage");

CREATE INDEX IF NOT EXISTS "dp_unified_collection_jobs_leaseUntil_idx"
  ON "dp_unified_collection_jobs"("leaseUntil");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dp_unified_collection_jobs_caseId_fkey'
  ) THEN
    ALTER TABLE "dp_unified_collection_jobs"
      ADD CONSTRAINT "dp_unified_collection_jobs_caseId_fkey"
      FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
