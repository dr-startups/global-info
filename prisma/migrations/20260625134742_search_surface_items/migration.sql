-- CreateEnum
CREATE TYPE "SearchSurfaceType" AS ENUM ('ORGANIC_RESULT', 'SUGGESTION', 'RELATED_QUERY', 'IMAGE_RESULT', 'VIDEO_RESULT', 'KNOWLEDGE_BLOCK', 'SERP_SCREENSHOT', 'MANUAL_NOTE');

-- CreateEnum
CREATE TYPE "SearchSurfaceSource" AS ENUM ('MOCK', 'REAL_GOOGLE', 'REAL_YANDEX', 'REAL_WIKIPEDIA', 'MANUAL_IMPORT', 'SYNTHETIC_SNAPSHOT');

-- AlterEnum
ALTER TYPE "AgentName" ADD VALUE 'SEARCH_SURFACES';

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

-- AddForeignKey
ALTER TABLE "dp_search_surface_items" ADD CONSTRAINT "dp_search_surface_items_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
