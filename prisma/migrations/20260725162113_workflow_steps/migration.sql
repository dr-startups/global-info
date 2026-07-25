-- AlterTable
ALTER TABLE "dp_orion_arsenkin_stage_runs" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "dp_workflow_steps" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 40,
    "nextRunAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "inputHash" TEXT,
    "outputRef" TEXT,
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dp_workflow_steps_state_nextRunAt_idx" ON "dp_workflow_steps"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "dp_workflow_steps_caseId_position_idx" ON "dp_workflow_steps"("caseId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "dp_workflow_steps_jobId_name_key" ON "dp_workflow_steps"("jobId", "name");

-- AddForeignKey
ALTER TABLE "dp_workflow_steps" ADD CONSTRAINT "dp_workflow_steps_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "dp_serp_captures_reportRunId_queryHash_engine_region_device_cap" RENAME TO "dp_serp_captures_reportRunId_queryHash_engine_region_device_idx";

-- RenameIndex
ALTER INDEX "dp_serp_synthetic_asset_observations_syntheticAssetId_observati" RENAME TO "dp_serp_synthetic_asset_observations_syntheticAssetId_obser_key";
