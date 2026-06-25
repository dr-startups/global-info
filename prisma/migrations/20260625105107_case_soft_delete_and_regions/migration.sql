-- AlterTable
ALTER TABLE "dp_cases" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "targetRegions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "dp_cases_deletedAt_idx" ON "dp_cases"("deletedAt");
