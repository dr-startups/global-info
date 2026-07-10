-- Run-scoped SERP observations (provider-first; no URL dedupe across queries/ranks)
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

CREATE UNIQUE INDEX "dp_search_documents_caseId_url_key" ON "dp_search_documents"("caseId", "url");
CREATE INDEX "dp_search_documents_caseId_idx" ON "dp_search_documents"("caseId");
CREATE INDEX "dp_search_documents_domain_idx" ON "dp_search_documents"("domain");

ALTER TABLE "dp_search_documents" ADD CONSTRAINT "dp_search_documents_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dp_serp_observations" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'organic',
    "region" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "domain" TEXT,
    "searchDocumentId" TEXT,
    "providerStatus" TEXT NOT NULL DEFAULT 'OK',
    "rawPayloadJson" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_serp_observations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dp_serp_observations_caseId_idx" ON "dp_serp_observations"("caseId");
CREATE INDEX "dp_serp_observations_auditRunId_idx" ON "dp_serp_observations"("auditRunId");
CREATE INDEX "dp_serp_observations_queryId_idx" ON "dp_serp_observations"("queryId");
CREATE INDEX "dp_serp_observations_provider_engine_surface_idx" ON "dp_serp_observations"("provider", "engine", "surface");
CREATE INDEX "dp_serp_observations_url_idx" ON "dp_serp_observations"("url");
CREATE INDEX "dp_serp_observations_capturedAt_idx" ON "dp_serp_observations"("capturedAt");

ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dp_serp_observations" ADD CONSTRAINT "dp_serp_observations_searchDocumentId_fkey" FOREIGN KEY ("searchDocumentId") REFERENCES "dp_search_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

CREATE INDEX "dp_serp_synthetic_assets_caseId_idx" ON "dp_serp_synthetic_assets"("caseId");
CREATE INDEX "dp_serp_synthetic_assets_auditRunId_idx" ON "dp_serp_synthetic_assets"("auditRunId");
CREATE INDEX "dp_serp_synthetic_assets_queryId_idx" ON "dp_serp_synthetic_assets"("queryId");
CREATE INDEX "dp_serp_synthetic_assets_sha256_idx" ON "dp_serp_synthetic_assets"("sha256");

ALTER TABLE "dp_serp_synthetic_assets" ADD CONSTRAINT "dp_serp_synthetic_assets_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dp_serp_synthetic_assets" ADD CONSTRAINT "dp_serp_synthetic_assets_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dp_serp_synthetic_asset_observations" (
    "id" TEXT NOT NULL,
    "syntheticAssetId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "dp_serp_synthetic_asset_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dp_serp_synthetic_asset_observations_syntheticAssetId_observationId_key" ON "dp_serp_synthetic_asset_observations"("syntheticAssetId", "observationId");
CREATE INDEX "dp_serp_synthetic_asset_observations_observationId_idx" ON "dp_serp_synthetic_asset_observations"("observationId");

ALTER TABLE "dp_serp_synthetic_asset_observations" ADD CONSTRAINT "dp_serp_synthetic_asset_observations_syntheticAssetId_fkey" FOREIGN KEY ("syntheticAssetId") REFERENCES "dp_serp_synthetic_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dp_serp_synthetic_asset_observations" ADD CONSTRAINT "dp_serp_synthetic_asset_observations_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "dp_serp_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
