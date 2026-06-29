-- CreateEnum
CREATE TYPE "ComplianceReviewStatus" AS ENUM ('PENDING', 'MATCH_CONFIRMED', 'FALSE_POSITIVE', 'NEEDS_REVIEW', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ComplianceHitSource" AS ENUM ('MANUAL', 'OFFICIAL_API', 'MOCK');

-- CreateEnum
CREATE TYPE "ComplianceConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "dp_database_profiles" ADD COLUMN     "aliases" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "categories" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "confidence" "ComplianceConfidence",
ADD COLUMN     "countries" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "datesOfBirth" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "hitSource" "ComplianceHitSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "matchedName" TEXT,
ADD COLUMN     "profileId" TEXT,
ADD COLUMN     "profileUrl" TEXT,
ADD COLUMN     "rawMetadataSafe" JSONB,
ADD COLUMN     "reviewStatus" "ComplianceReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "riskFindingId" TEXT,
ADD COLUMN     "riskTypes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "screeningRunId" TEXT,
ADD COLUMN     "subjectName" TEXT,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "dp_compliance_screening_runs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "provider" "DatabaseProvider" NOT NULL,
    "status" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "runBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "dp_compliance_screening_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dp_compliance_screening_runs_caseId_provider_idx" ON "dp_compliance_screening_runs"("caseId", "provider");

-- CreateIndex
CREATE INDEX "dp_database_profiles_caseId_reviewStatus_idx" ON "dp_database_profiles"("caseId", "reviewStatus");

-- AddForeignKey
ALTER TABLE "dp_compliance_screening_runs" ADD CONSTRAINT "dp_compliance_screening_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_database_profiles" ADD CONSTRAINT "dp_database_profiles_screeningRunId_fkey" FOREIGN KEY ("screeningRunId") REFERENCES "dp_compliance_screening_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
