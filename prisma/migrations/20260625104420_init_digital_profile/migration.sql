-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('DRAFT', 'COLLECTING', 'REVIEW', 'REPORT_READY', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'OBTAINED', 'REFUSED');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST', 'PUBLIC_INTEREST', 'VITAL_INTEREST');

-- CreateEnum
CREATE TYPE "AgentName" AS ENUM ('GOOGLE_SEARCH', 'YANDEX_SEARCH', 'WIKIPEDIA', 'AI_PROFILE', 'COMPLIANCE_DATABASE', 'RISK_CLASSIFIER', 'REPORT_SYNTHESIS');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SearchEngine" AS ENUM ('GOOGLE', 'YANDEX', 'BING', 'OTHER');

-- CreateEnum
CREATE TYPE "QuerySource" AS ENUM ('MANUAL', 'GENERATED');

-- CreateEnum
CREATE TYPE "ResultClassification" AS ENUM ('UNCLASSIFIED', 'RELEVANT', 'IRRELEVANT', 'ADVERSE_MEDIA', 'SOCIAL_PROFILE', 'CORPORATE', 'LEGAL', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('URL', 'SCREENSHOT', 'IMPORTED_FILE', 'DATABASE_RECORD');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "DatabaseProvider" AS ENUM ('LEXISNEXIS', 'DOW_JONES', 'WORLD_CHECK', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportMethod" AS ENUM ('OFFICIAL_API', 'MANUAL_IMPORT');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'FINAL');

-- CreateTable
CREATE TABLE "dp_cases" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'DRAFT',
    "lawfulBasis" "LawfulBasis",
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_subjects" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dateOfBirth" TIMESTAMP(3),
    "nationality" TEXT,
    "country" TEXT,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identifiers" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_agent_runs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "agentName" "AgentName" NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "itemsSaved" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_search_queries" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "engine" "SearchEngine" NOT NULL,
    "queryText" TEXT NOT NULL,
    "source" "QuerySource" NOT NULL DEFAULT 'GENERATED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_search_results" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "queryId" TEXT,
    "engine" "SearchEngine" NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "dedupHash" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "rank" INTEGER,
    "classification" "ResultClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_search_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_screenshots" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "resultId" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "sourceUrl" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "dp_screenshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_risk_findings" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_risk_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_database_profiles" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "provider" "DatabaseProvider" NOT NULL,
    "importMethod" "ImportMethod" NOT NULL,
    "matchType" TEXT,
    "matchScore" DOUBLE PRECISION,
    "rawPayload" JSONB,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "importedBy" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_database_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_wikipedia_checks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "exists" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "language" TEXT DEFAULT 'en',
    "pageTitle" TEXT,
    "snapshot" JSONB,
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT,

    CONSTRAINT "dp_wikipedia_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_ai_profiles" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "summary" TEXT,
    "classifications" JSONB,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "disclaimer" TEXT NOT NULL DEFAULT 'AI-generated summary based on collected evidence. Not a source of fact.',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "dp_ai_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_report_versions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "reportJson" JSONB NOT NULL,
    "pptxUrl" TEXT,
    "pdfUrl" TEXT,
    "watermark" TEXT DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_report_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_audit_logs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dp_cases_caseNumber_key" ON "dp_cases"("caseNumber");

-- CreateIndex
CREATE INDEX "dp_cases_status_idx" ON "dp_cases"("status");

-- CreateIndex
CREATE INDEX "dp_subjects_caseId_idx" ON "dp_subjects"("caseId");

-- CreateIndex
CREATE INDEX "dp_agent_runs_caseId_agentName_idx" ON "dp_agent_runs"("caseId", "agentName");

-- CreateIndex
CREATE INDEX "dp_search_queries_caseId_idx" ON "dp_search_queries"("caseId");

-- CreateIndex
CREATE INDEX "dp_search_results_caseId_classification_idx" ON "dp_search_results"("caseId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "dp_search_results_caseId_dedupHash_key" ON "dp_search_results"("caseId", "dedupHash");

-- CreateIndex
CREATE INDEX "dp_screenshots_caseId_idx" ON "dp_screenshots"("caseId");

-- CreateIndex
CREATE INDEX "dp_risk_findings_caseId_severity_idx" ON "dp_risk_findings"("caseId", "severity");

-- CreateIndex
CREATE INDEX "dp_database_profiles_caseId_provider_idx" ON "dp_database_profiles"("caseId", "provider");

-- CreateIndex
CREATE INDEX "dp_wikipedia_checks_caseId_idx" ON "dp_wikipedia_checks"("caseId");

-- CreateIndex
CREATE INDEX "dp_ai_profiles_caseId_idx" ON "dp_ai_profiles"("caseId");

-- CreateIndex
CREATE INDEX "dp_report_versions_caseId_idx" ON "dp_report_versions"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_report_versions_caseId_version_key" ON "dp_report_versions"("caseId", "version");

-- CreateIndex
CREATE INDEX "dp_audit_logs_caseId_idx" ON "dp_audit_logs"("caseId");

-- CreateIndex
CREATE INDEX "dp_audit_logs_actorId_idx" ON "dp_audit_logs"("actorId");

-- AddForeignKey
ALTER TABLE "dp_subjects" ADD CONSTRAINT "dp_subjects_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_agent_runs" ADD CONSTRAINT "dp_agent_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_search_queries" ADD CONSTRAINT "dp_search_queries_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_search_results" ADD CONSTRAINT "dp_search_results_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_search_results" ADD CONSTRAINT "dp_search_results_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "dp_search_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_screenshots" ADD CONSTRAINT "dp_screenshots_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_screenshots" ADD CONSTRAINT "dp_screenshots_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "dp_search_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_risk_findings" ADD CONSTRAINT "dp_risk_findings_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_database_profiles" ADD CONSTRAINT "dp_database_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_wikipedia_checks" ADD CONSTRAINT "dp_wikipedia_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_ai_profiles" ADD CONSTRAINT "dp_ai_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_report_versions" ADD CONSTRAINT "dp_report_versions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_audit_logs" ADD CONSTRAINT "dp_audit_logs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
