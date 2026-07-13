-- Run-scoped provider task idempotency, leases, and provider provenance.
DROP INDEX IF EXISTS "dp_provider_tasks_provider_requestHash_key";
CREATE UNIQUE INDEX IF NOT EXISTS "dp_provider_tasks_reportRunId_provider_requestHash_key"
ON "dp_provider_tasks"("reportRunId", "provider", "requestHash");

ALTER TABLE "dp_provider_tasks"
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "limitsBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "limitsAfter" INTEGER;

ALTER TABLE "dp_serp_observations"
  ADD COLUMN IF NOT EXISTS "providerTaskId" TEXT,
  ADD COLUMN IF NOT EXISTS "parentQueryId" TEXT,
  ADD COLUMN IF NOT EXISTS "device" TEXT NOT NULL DEFAULT 'DESKTOP';

DROP INDEX IF EXISTS "serp_obs_run_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "serp_obs_run_unique"
ON "dp_serp_observations" ("auditRunId", "provider", "engine", "region", "language", "device", "surface", "queryId", "rank", "url");
CREATE INDEX IF NOT EXISTS "dp_serp_observations_providerTaskId_idx"
ON "dp_serp_observations" ("providerTaskId");

DO $$ BEGIN
  ALTER TABLE "dp_serp_observations"
    ADD CONSTRAINT "dp_serp_observations_providerTaskId_fkey"
    FOREIGN KEY ("providerTaskId") REFERENCES "dp_provider_tasks"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "dp_surface_collection_coverage" (
  "id" TEXT NOT NULL,
  "reportRunId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "providerTaskId" TEXT,
  "queryId" TEXT NOT NULL,
  "queryText" TEXT NOT NULL,
  "engine" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "device" TEXT NOT NULL DEFAULT 'DESKTOP',
  "surface" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "resultCount" INTEGER NOT NULL,
  "errorCode" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dp_surface_collection_coverage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "dp_surface_collection_coverage_reportRunId_idx"
ON "dp_surface_collection_coverage" ("reportRunId");
CREATE INDEX IF NOT EXISTS "dp_surface_collection_coverage_reportRunId_surface_idx"
ON "dp_surface_collection_coverage" ("reportRunId", "surface");
CREATE INDEX IF NOT EXISTS "dp_surface_collection_coverage_providerTaskId_idx"
ON "dp_surface_collection_coverage" ("providerTaskId");

DO $$ BEGIN
  ALTER TABLE "dp_surface_collection_coverage"
    ADD CONSTRAINT "dp_surface_collection_coverage_reportRunId_fkey"
    FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "dp_surface_collection_coverage"
    ADD CONSTRAINT "dp_surface_collection_coverage_providerTaskId_fkey"
    FOREIGN KEY ("providerTaskId") REFERENCES "dp_provider_tasks"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "dp_provider_account_limiter" (
  "id" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "inFlight" INTEGER NOT NULL DEFAULT 0,
  "maxConcurrent" INTEGER NOT NULL,
  "maxRpm" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dp_provider_account_limiter_pkey" PRIMARY KEY ("id")
);
