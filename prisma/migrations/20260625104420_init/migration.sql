-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('DRAFT', 'COLLECTING', 'REVIEW', 'REPORT_READY', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'OBTAINED', 'REFUSED');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST', 'PUBLIC_INTEREST', 'VITAL_INTEREST');

-- CreateEnum
CREATE TYPE "AgentName" AS ENUM ('GOOGLE_SEARCH', 'YANDEX_SEARCH', 'WIKIPEDIA', 'AI_PROFILE', 'COMPLIANCE_DATABASE', 'RISK_CLASSIFIER', 'REPORT_SYNTHESIS', 'SEARCH_SURFACES', 'ARSENKIN_SEARCH_TOP_REAL', 'ARSENKIN_SUGGESTIONS_REAL', 'ARSENKIN_PAA_REAL', 'ARSENKIN_AI_SEARCH_REAL', 'ARSENKIN_URL_AUDIT_REAL');

-- CreateEnum
CREATE TYPE "SearchSurfaceType" AS ENUM ('ORGANIC_RESULT', 'SUGGESTION', 'RELATED_QUERY', 'IMAGE_RESULT', 'VIDEO_RESULT', 'KNOWLEDGE_BLOCK', 'SERP_SCREENSHOT', 'MANUAL_NOTE');

-- CreateEnum
CREATE TYPE "SearchSurfaceSource" AS ENUM ('MOCK', 'REAL_GOOGLE', 'REAL_YANDEX', 'REAL_WIKIPEDIA', 'MANUAL_IMPORT', 'SYNTHETIC_SNAPSHOT');

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
CREATE TYPE "DatabaseProvider" AS ENUM ('LEXISNEXIS', 'DOW_JONES', 'WORLD_CHECK', 'OPEN_SANCTIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportMethod" AS ENUM ('OFFICIAL_API', 'MANUAL_IMPORT');

-- CreateEnum
CREATE TYPE "ComplianceReviewStatus" AS ENUM ('PENDING', 'MATCH_CONFIRMED', 'FALSE_POSITIVE', 'NEEDS_REVIEW', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ComplianceHitSource" AS ENUM ('MANUAL', 'OFFICIAL_API', 'MOCK');

-- CreateEnum
CREATE TYPE "ComplianceConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'FINAL');

-- CreateEnum
CREATE TYPE "DpRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'CLIENT_VIEWER');

-- CreateEnum
CREATE TYPE "DpAccessLevel" AS ENUM ('OWNER', 'EDITOR', 'REVIEWER', 'VIEWER');

-- CreateTable
CREATE TABLE "dp_cases" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'DRAFT',
    "lawfulBasis" "LawfulBasis",
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "targetRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "isFixture" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "dp_arsenkin_ingest_ledger" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "unifiedJobId" TEXT NOT NULL,
    "externalTaskId" TEXT,
    "resultHash" TEXT NOT NULL,
    "observationIds" JSONB NOT NULL DEFAULT '[]',
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_arsenkin_ingest_ledger_pkey" PRIMARY KEY ("id")
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
    "source" TEXT,
    "rawMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_search_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_search_surface_items" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" "SearchSurfaceType" NOT NULL,
    "provider" TEXT,
    "source" "SearchSurfaceSource" NOT NULL,
    "query" TEXT,
    "region" TEXT,
    "language" TEXT,
    "title" TEXT,
    "snippet" TEXT,
    "url" TEXT,
    "domain" TEXT,
    "imageUrl" TEXT,
    "thumbnailUrl" TEXT,
    "videoUrl" TEXT,
    "rank" INTEGER,
    "classification" TEXT,
    "riskTheme" TEXT,
    "rawMetadata" JSONB,
    "dedupHash" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_search_surface_items_pkey" PRIMARY KEY ("id")
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
    "signalType" TEXT,
    "riskTheme" TEXT,
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "dedupHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_risk_findings_pkey" PRIMARY KEY ("id")
);

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
    "screeningRunId" TEXT,
    "hitSource" "ComplianceHitSource" NOT NULL DEFAULT 'MANUAL',
    "subjectName" TEXT,
    "matchedName" TEXT,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "riskTypes" JSONB NOT NULL DEFAULT '[]',
    "countries" JSONB NOT NULL DEFAULT '[]',
    "datesOfBirth" JSONB NOT NULL DEFAULT '[]',
    "confidence" "ComplianceConfidence",
    "profileId" TEXT,
    "profileUrl" TEXT,
    "summary" TEXT,
    "reviewStatus" "ComplianceReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "riskFindingId" TEXT,
    "rawMetadataSafe" JSONB,

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
    "pptxStorageKey" TEXT,
    "pdfStorageKey" TEXT,
    "renderedAt" TIMESTAMP(3),
    "templateVersion" TEXT,
    "renderWarnings" JSONB,
    "watermark" TEXT DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_report_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_unified_collection_jobs" (
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

-- CreateTable
CREATE TABLE "dp_orion_report_runs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportVersionId" TEXT,
    "mode" TEXT NOT NULL,
    "storeMode" TEXT NOT NULL DEFAULT 'file',
    "status" TEXT NOT NULL,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB,
    "warningsJson" JSONB,
    "errorsJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_arsenkin_stage_runs" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_arsenkin_stage_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_provider_tasks" (
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
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "limitsBefore" INTEGER,
    "limitsAfter" INTEGER,
    "requestJson" JSONB NOT NULL,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "dp_provider_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_search_documents" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "domain" TEXT,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_serp_observations" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "parentQueryId" TEXT,
    "provider" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT 'DESKTOP',
    "surface" TEXT NOT NULL DEFAULT 'organic',
    "region" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "domain" TEXT,
    "searchDocumentId" TEXT,
    "providerTaskId" TEXT,
    "providerStatus" TEXT NOT NULL DEFAULT 'OK',
    "rawPayloadJson" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_serp_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_surface_collection_coverage" (
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

-- CreateTable
CREATE TABLE "dp_provider_account_limiter" (
    "id" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inFlight" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrent" INTEGER NOT NULL,
    "maxRpm" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_provider_account_limiter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_provider_account_request_leases" (
    "id" TEXT NOT NULL,
    "limiterId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "dp_provider_account_request_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_serp_synthetic_assets" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'organic',
    "region" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "width" INTEGER,
    "height" INTEGER,
    "caption" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_serp_synthetic_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_serp_synthetic_asset_observations" (
    "id" TEXT NOT NULL,
    "syntheticAssetId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "dp_serp_synthetic_asset_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_serp_captures" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT 'DESKTOP',
    "captureStatus" TEXT NOT NULL,
    "geoStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "connectionMode" TEXT NOT NULL DEFAULT 'DIRECT',
    "storageKey" TEXT,
    "sha256" TEXT,
    "sourceUrl" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "capturedAt" TIMESTAMP(3),
    "capturedBy" TEXT,
    "metadataJson" JSONB,
    "errorJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_serp_captures_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "dp_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "DpRole" NOT NULL DEFAULT 'ANALYST',
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_case_access" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessLevel" "DpAccessLevel" NOT NULL DEFAULT 'VIEWER',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_case_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dp_cases_caseNumber_key" ON "dp_cases"("caseNumber");

-- CreateIndex
CREATE INDEX "dp_cases_status_idx" ON "dp_cases"("status");

-- CreateIndex
CREATE INDEX "dp_cases_deletedAt_idx" ON "dp_cases"("deletedAt");

-- CreateIndex
CREATE INDEX "dp_cases_isFixture_idx" ON "dp_cases"("isFixture");

-- CreateIndex
CREATE INDEX "dp_subjects_caseId_idx" ON "dp_subjects"("caseId");

-- CreateIndex
CREATE INDEX "dp_agent_runs_caseId_agentName_idx" ON "dp_agent_runs"("caseId", "agentName");

-- CreateIndex
CREATE INDEX "dp_arsenkin_ingest_ledger_unifiedJobId_externalTaskId_idx" ON "dp_arsenkin_ingest_ledger"("unifiedJobId", "externalTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_arsenkin_ingest_ledger_unifiedJobId_resultHash_key" ON "dp_arsenkin_ingest_ledger"("unifiedJobId", "resultHash");

-- CreateIndex
CREATE INDEX "dp_search_queries_caseId_idx" ON "dp_search_queries"("caseId");

-- CreateIndex
CREATE INDEX "dp_search_results_caseId_classification_idx" ON "dp_search_results"("caseId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "dp_search_results_caseId_dedupHash_key" ON "dp_search_results"("caseId", "dedupHash");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_caseId_idx" ON "dp_search_surface_items"("caseId");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_type_idx" ON "dp_search_surface_items"("type");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_provider_idx" ON "dp_search_surface_items"("provider");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_source_idx" ON "dp_search_surface_items"("source");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_caseId_type_idx" ON "dp_search_surface_items"("caseId", "type");

-- CreateIndex
CREATE INDEX "dp_search_surface_items_caseId_provider_idx" ON "dp_search_surface_items"("caseId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "dp_search_surface_items_caseId_dedupHash_key" ON "dp_search_surface_items"("caseId", "dedupHash");

-- CreateIndex
CREATE INDEX "dp_screenshots_caseId_idx" ON "dp_screenshots"("caseId");

-- CreateIndex
CREATE INDEX "dp_risk_findings_caseId_severity_idx" ON "dp_risk_findings"("caseId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "dp_risk_findings_caseId_dedupHash_key" ON "dp_risk_findings"("caseId", "dedupHash");

-- CreateIndex
CREATE INDEX "dp_compliance_screening_runs_caseId_provider_idx" ON "dp_compliance_screening_runs"("caseId", "provider");

-- CreateIndex
CREATE INDEX "dp_database_profiles_caseId_provider_idx" ON "dp_database_profiles"("caseId", "provider");

-- CreateIndex
CREATE INDEX "dp_database_profiles_caseId_reviewStatus_idx" ON "dp_database_profiles"("caseId", "reviewStatus");

-- CreateIndex
CREATE INDEX "dp_wikipedia_checks_caseId_idx" ON "dp_wikipedia_checks"("caseId");

-- CreateIndex
CREATE INDEX "dp_ai_profiles_caseId_idx" ON "dp_ai_profiles"("caseId");

-- CreateIndex
CREATE INDEX "dp_report_versions_caseId_idx" ON "dp_report_versions"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_report_versions_caseId_version_key" ON "dp_report_versions"("caseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "dp_unified_collection_jobs_caseId_key" ON "dp_unified_collection_jobs"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_unified_collection_jobs_jobId_key" ON "dp_unified_collection_jobs"("jobId");

-- CreateIndex
CREATE INDEX "dp_unified_collection_jobs_status_stage_idx" ON "dp_unified_collection_jobs"("status", "stage");

-- CreateIndex
CREATE INDEX "dp_unified_collection_jobs_leaseUntil_idx" ON "dp_unified_collection_jobs"("leaseUntil");

-- CreateIndex
CREATE INDEX "dp_workflow_steps_state_nextRunAt_idx" ON "dp_workflow_steps"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "dp_workflow_steps_caseId_position_idx" ON "dp_workflow_steps"("caseId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "dp_workflow_steps_jobId_name_key" ON "dp_workflow_steps"("jobId", "name");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_caseId_idx" ON "dp_orion_report_runs"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_reportVersionId_idx" ON "dp_orion_report_runs"("reportVersionId");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_status_idx" ON "dp_orion_report_runs"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_createdAt_idx" ON "dp_orion_report_runs"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_arsenkin_stage_runs_reportRunId_status_idx" ON "dp_orion_arsenkin_stage_runs"("reportRunId", "status");

-- CreateIndex
CREATE INDEX "dp_orion_arsenkin_stage_runs_caseId_idx" ON "dp_orion_arsenkin_stage_runs"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_orion_arsenkin_stage_unique" ON "dp_orion_arsenkin_stage_runs"("reportRunId", "stage");

-- CreateIndex
CREATE INDEX "dp_provider_tasks_state_nextPollAt_idx" ON "dp_provider_tasks"("state", "nextPollAt");

-- CreateIndex
CREATE INDEX "dp_provider_tasks_reportRunId_idx" ON "dp_provider_tasks"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_provider_tasks_caseId_idx" ON "dp_provider_tasks"("caseId");

-- CreateIndex
CREATE INDEX "dp_provider_tasks_externalTaskId_idx" ON "dp_provider_tasks"("externalTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_provider_tasks_reportRunId_provider_requestHash_key" ON "dp_provider_tasks"("reportRunId", "provider", "requestHash");

-- CreateIndex
CREATE INDEX "dp_search_documents_caseId_idx" ON "dp_search_documents"("caseId");

-- CreateIndex
CREATE INDEX "dp_search_documents_domain_idx" ON "dp_search_documents"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "dp_search_documents_caseId_url_key" ON "dp_search_documents"("caseId", "url");

-- CreateIndex
CREATE INDEX "dp_serp_observations_caseId_idx" ON "dp_serp_observations"("caseId");

-- CreateIndex
CREATE INDEX "dp_serp_observations_auditRunId_idx" ON "dp_serp_observations"("auditRunId");

-- CreateIndex
CREATE INDEX "dp_serp_observations_queryId_idx" ON "dp_serp_observations"("queryId");

-- CreateIndex
CREATE INDEX "dp_serp_observations_providerTaskId_idx" ON "dp_serp_observations"("providerTaskId");

-- CreateIndex
CREATE INDEX "dp_serp_observations_provider_engine_surface_idx" ON "dp_serp_observations"("provider", "engine", "surface");

-- CreateIndex
CREATE INDEX "dp_serp_observations_url_idx" ON "dp_serp_observations"("url");

-- CreateIndex
CREATE INDEX "dp_serp_observations_capturedAt_idx" ON "dp_serp_observations"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "serp_obs_run_unique" ON "dp_serp_observations"("auditRunId", "provider", "engine", "region", "language", "device", "surface", "queryId", "rank", "url");

-- CreateIndex
CREATE INDEX "dp_surface_collection_coverage_reportRunId_idx" ON "dp_surface_collection_coverage"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_surface_collection_coverage_reportRunId_surface_idx" ON "dp_surface_collection_coverage"("reportRunId", "surface");

-- CreateIndex
CREATE INDEX "dp_surface_collection_coverage_providerTaskId_idx" ON "dp_surface_collection_coverage"("providerTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_surface_coverage_biz_unique" ON "dp_surface_collection_coverage"("reportRunId", "provider", "tool", "queryId", "surface", "engine", "region", "language", "device");

-- CreateIndex
CREATE INDEX "dp_provider_account_request_leases_limiterId_createdAt_idx" ON "dp_provider_account_request_leases"("limiterId", "createdAt");

-- CreateIndex
CREATE INDEX "dp_provider_account_request_leases_limiterId_expiresAt_idx" ON "dp_provider_account_request_leases"("limiterId", "expiresAt");

-- CreateIndex
CREATE INDEX "dp_serp_synthetic_assets_caseId_idx" ON "dp_serp_synthetic_assets"("caseId");

-- CreateIndex
CREATE INDEX "dp_serp_synthetic_assets_auditRunId_idx" ON "dp_serp_synthetic_assets"("auditRunId");

-- CreateIndex
CREATE INDEX "dp_serp_synthetic_assets_queryId_idx" ON "dp_serp_synthetic_assets"("queryId");

-- CreateIndex
CREATE INDEX "dp_serp_synthetic_assets_sha256_idx" ON "dp_serp_synthetic_assets"("sha256");

-- CreateIndex
CREATE INDEX "dp_serp_synthetic_asset_observations_observationId_idx" ON "dp_serp_synthetic_asset_observations"("observationId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_serp_synthetic_asset_observations_syntheticAssetId_obser_key" ON "dp_serp_synthetic_asset_observations"("syntheticAssetId", "observationId");

-- CreateIndex
CREATE INDEX "dp_serp_captures_caseId_idx" ON "dp_serp_captures"("caseId");

-- CreateIndex
CREATE INDEX "dp_serp_captures_reportRunId_queryHash_engine_region_device_idx" ON "dp_serp_captures"("reportRunId", "queryHash", "engine", "region", "device", "captureStatus");

-- CreateIndex
CREATE INDEX "dp_audit_logs_caseId_idx" ON "dp_audit_logs"("caseId");

-- CreateIndex
CREATE INDEX "dp_audit_logs_actorId_idx" ON "dp_audit_logs"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_users_email_key" ON "dp_users"("email");

-- CreateIndex
CREATE INDEX "dp_users_role_idx" ON "dp_users"("role");

-- CreateIndex
CREATE INDEX "dp_case_access_userId_idx" ON "dp_case_access"("userId");

-- CreateIndex
CREATE INDEX "dp_case_access_caseId_idx" ON "dp_case_access"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_case_access_caseId_userId_key" ON "dp_case_access"("caseId", "userId");

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
ALTER TABLE "dp_search_surface_items" ADD CONSTRAINT "dp_search_surface_items_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_screenshots" ADD CONSTRAINT "dp_screenshots_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_screenshots" ADD CONSTRAINT "dp_screenshots_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "dp_search_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_risk_findings" ADD CONSTRAINT "dp_risk_findings_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_compliance_screening_runs" ADD CONSTRAINT "dp_compliance_screening_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_database_profiles" ADD CONSTRAINT "dp_database_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_database_profiles" ADD CONSTRAINT "dp_database_profiles_screeningRunId_fkey" FOREIGN KEY ("screeningRunId") REFERENCES "dp_compliance_screening_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_wikipedia_checks" ADD CONSTRAINT "dp_wikipedia_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_ai_profiles" ADD CONSTRAINT "dp_ai_profiles_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_report_versions" ADD CONSTRAINT "dp_report_versions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_unified_collection_jobs" ADD CONSTRAINT "dp_unified_collection_jobs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_workflow_steps" ADD CONSTRAINT "dp_workflow_steps_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_runs" ADD CONSTRAINT "dp_orion_report_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_arsenkin_stage_runs" ADD CONSTRAINT "dp_orion_arsenkin_stage_runs_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_arsenkin_stage_runs" ADD CONSTRAINT "dp_orion_arsenkin_stage_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_provider_tasks" ADD CONSTRAINT "dp_provider_tasks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_provider_tasks" ADD CONSTRAINT "dp_provider_tasks_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_search_documents" ADD CONSTRAINT "dp_search_documents_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_searchDocumentId_fkey" FOREIGN KEY ("searchDocumentId") REFERENCES "dp_search_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_providerTaskId_fkey" FOREIGN KEY ("providerTaskId") REFERENCES "dp_provider_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_surface_collection_coverage" ADD CONSTRAINT "dp_surface_collection_coverage_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_surface_collection_coverage" ADD CONSTRAINT "dp_surface_collection_coverage_providerTaskId_fkey" FOREIGN KEY ("providerTaskId") REFERENCES "dp_provider_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_synthetic_assets" ADD CONSTRAINT "dp_serp_synthetic_assets_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_synthetic_assets" ADD CONSTRAINT "dp_serp_synthetic_assets_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_synthetic_asset_observations" ADD CONSTRAINT "dp_serp_synthetic_asset_observations_syntheticAssetId_fkey" FOREIGN KEY ("syntheticAssetId") REFERENCES "dp_serp_synthetic_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_synthetic_asset_observations" ADD CONSTRAINT "dp_serp_synthetic_asset_observations_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "dp_serp_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_captures" ADD CONSTRAINT "dp_serp_captures_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_serp_captures" ADD CONSTRAINT "dp_serp_captures_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_audit_logs" ADD CONSTRAINT "dp_audit_logs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_case_access" ADD CONSTRAINT "dp_case_access_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_case_access" ADD CONSTRAINT "dp_case_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "dp_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

