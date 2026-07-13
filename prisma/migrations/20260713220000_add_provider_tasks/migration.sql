-- ProviderTask for async Arsenkin / external SERP tool jobs
CREATE TABLE IF NOT EXISTS "dp_provider_tasks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "reportRunId" TEXT,
    "provider" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "externalTaskId" TEXT,
    "requestHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "limitsSpent" INTEGER,
    "requestJson" JSONB NOT NULL,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "dp_provider_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dp_provider_tasks_provider_requestHash_key"
ON "dp_provider_tasks"("provider", "requestHash");

CREATE INDEX IF NOT EXISTS "dp_provider_tasks_state_nextPollAt_idx"
ON "dp_provider_tasks"("state", "nextPollAt");

CREATE INDEX IF NOT EXISTS "dp_provider_tasks_reportRunId_idx"
ON "dp_provider_tasks"("reportRunId");

CREATE INDEX IF NOT EXISTS "dp_provider_tasks_caseId_idx"
ON "dp_provider_tasks"("caseId");

CREATE INDEX IF NOT EXISTS "dp_provider_tasks_externalTaskId_idx"
ON "dp_provider_tasks"("externalTaskId");

DO $$ BEGIN
  ALTER TABLE "dp_provider_tasks"
    ADD CONSTRAINT "dp_provider_tasks_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dp_provider_tasks"
    ADD CONSTRAINT "dp_provider_tasks_reportRunId_fkey"
    FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
