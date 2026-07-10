-- Stage S2: LIVE browser SERP captures bound to OrionReportRun
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

CREATE INDEX "dp_serp_captures_caseId_idx" ON "dp_serp_captures"("caseId");

CREATE INDEX "dp_serp_captures_reportRunId_queryHash_engine_region_device_captureStatus_idx" ON "dp_serp_captures"("reportRunId", "queryHash", "engine", "region", "device", "captureStatus");

ALTER TABLE "dp_serp_captures" ADD CONSTRAINT "dp_serp_captures_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dp_serp_captures" ADD CONSTRAINT "dp_serp_captures_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
