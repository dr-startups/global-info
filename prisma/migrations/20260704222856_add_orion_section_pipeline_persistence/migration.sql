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
CREATE TABLE "dp_orion_report_macro_sections" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "macroSectionKey" TEXT NOT NULL,
    "sectionNumber" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "titleRu" TEXT NOT NULL,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_report_macro_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_report_micro_stages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "macroSectionId" TEXT,
    "macroSectionKey" TEXT NOT NULL,
    "microStageKey" TEXT NOT NULL,
    "sectionNumber" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_report_micro_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_section_agent_runs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_section_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_raw_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_raw_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_normalized_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_normalized_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_selected_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_selected_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_excluded_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_excluded_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_evidence_files" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "status" TEXT,
    "orderIndex" INTEGER,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_evidence_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_section_evidence_packs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_section_evidence_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_section_analyses" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_section_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_section_slide_manifests" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "microStageId" TEXT NOT NULL,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_section_slide_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_section_deck_artifacts" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "macroSectionId" TEXT NOT NULL,
    "status" TEXT,
    "audience" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_section_deck_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_final_deck_manifests" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "status" TEXT,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_final_deck_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_report_json_versions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "status" TEXT,
    "audience" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "internalOnly" BOOLEAN NOT NULL DEFAULT false,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_report_json_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_orion_report_consistency_checks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "internalOnly" BOOLEAN NOT NULL DEFAULT true,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_orion_report_consistency_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_caseId_idx" ON "dp_orion_report_runs"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_reportVersionId_idx" ON "dp_orion_report_runs"("reportVersionId");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_status_idx" ON "dp_orion_report_runs"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_runs_createdAt_idx" ON "dp_orion_report_runs"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_caseId_idx" ON "dp_orion_report_macro_sections"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_reportRunId_idx" ON "dp_orion_report_macro_sections"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_macroSectionKey_idx" ON "dp_orion_report_macro_sections"("macroSectionKey");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_status_idx" ON "dp_orion_report_macro_sections"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_orderIndex_idx" ON "dp_orion_report_macro_sections"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_report_macro_sections_createdAt_idx" ON "dp_orion_report_macro_sections"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_caseId_idx" ON "dp_orion_report_micro_stages"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_reportRunId_idx" ON "dp_orion_report_micro_stages"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_macroSectionKey_idx" ON "dp_orion_report_micro_stages"("macroSectionKey");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_microStageKey_idx" ON "dp_orion_report_micro_stages"("microStageKey");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_status_idx" ON "dp_orion_report_micro_stages"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_orderIndex_idx" ON "dp_orion_report_micro_stages"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_report_micro_stages_createdAt_idx" ON "dp_orion_report_micro_stages"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_section_agent_runs_caseId_idx" ON "dp_orion_section_agent_runs"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_section_agent_runs_reportRunId_idx" ON "dp_orion_section_agent_runs"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_section_agent_runs_status_idx" ON "dp_orion_section_agent_runs"("status");

-- CreateIndex
CREATE INDEX "dp_orion_section_agent_runs_createdAt_idx" ON "dp_orion_section_agent_runs"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_raw_evidence_caseId_idx" ON "dp_orion_raw_evidence"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_raw_evidence_reportRunId_idx" ON "dp_orion_raw_evidence"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_raw_evidence_status_idx" ON "dp_orion_raw_evidence"("status");

-- CreateIndex
CREATE INDEX "dp_orion_raw_evidence_orderIndex_idx" ON "dp_orion_raw_evidence"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_raw_evidence_createdAt_idx" ON "dp_orion_raw_evidence"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_normalized_evidence_caseId_idx" ON "dp_orion_normalized_evidence"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_normalized_evidence_reportRunId_idx" ON "dp_orion_normalized_evidence"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_normalized_evidence_status_idx" ON "dp_orion_normalized_evidence"("status");

-- CreateIndex
CREATE INDEX "dp_orion_normalized_evidence_orderIndex_idx" ON "dp_orion_normalized_evidence"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_normalized_evidence_createdAt_idx" ON "dp_orion_normalized_evidence"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_selected_evidence_caseId_idx" ON "dp_orion_selected_evidence"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_selected_evidence_reportRunId_idx" ON "dp_orion_selected_evidence"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_selected_evidence_status_idx" ON "dp_orion_selected_evidence"("status");

-- CreateIndex
CREATE INDEX "dp_orion_selected_evidence_orderIndex_idx" ON "dp_orion_selected_evidence"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_selected_evidence_createdAt_idx" ON "dp_orion_selected_evidence"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_excluded_evidence_caseId_idx" ON "dp_orion_excluded_evidence"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_excluded_evidence_reportRunId_idx" ON "dp_orion_excluded_evidence"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_excluded_evidence_status_idx" ON "dp_orion_excluded_evidence"("status");

-- CreateIndex
CREATE INDEX "dp_orion_excluded_evidence_orderIndex_idx" ON "dp_orion_excluded_evidence"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_excluded_evidence_createdAt_idx" ON "dp_orion_excluded_evidence"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_evidence_files_caseId_idx" ON "dp_orion_evidence_files"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_evidence_files_reportRunId_idx" ON "dp_orion_evidence_files"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_evidence_files_status_idx" ON "dp_orion_evidence_files"("status");

-- CreateIndex
CREATE INDEX "dp_orion_evidence_files_orderIndex_idx" ON "dp_orion_evidence_files"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_evidence_files_createdAt_idx" ON "dp_orion_evidence_files"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_section_evidence_packs_caseId_idx" ON "dp_orion_section_evidence_packs"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_section_evidence_packs_reportRunId_idx" ON "dp_orion_section_evidence_packs"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_section_evidence_packs_status_idx" ON "dp_orion_section_evidence_packs"("status");

-- CreateIndex
CREATE INDEX "dp_orion_section_evidence_packs_createdAt_idx" ON "dp_orion_section_evidence_packs"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_section_analyses_caseId_idx" ON "dp_orion_section_analyses"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_section_analyses_reportRunId_idx" ON "dp_orion_section_analyses"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_section_analyses_status_idx" ON "dp_orion_section_analyses"("status");

-- CreateIndex
CREATE INDEX "dp_orion_section_analyses_createdAt_idx" ON "dp_orion_section_analyses"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_section_slide_manifests_caseId_idx" ON "dp_orion_section_slide_manifests"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_section_slide_manifests_reportRunId_idx" ON "dp_orion_section_slide_manifests"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_section_slide_manifests_status_idx" ON "dp_orion_section_slide_manifests"("status");

-- CreateIndex
CREATE INDEX "dp_orion_section_slide_manifests_createdAt_idx" ON "dp_orion_section_slide_manifests"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_section_deck_artifacts_caseId_idx" ON "dp_orion_section_deck_artifacts"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_section_deck_artifacts_reportRunId_idx" ON "dp_orion_section_deck_artifacts"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_section_deck_artifacts_status_idx" ON "dp_orion_section_deck_artifacts"("status");

-- CreateIndex
CREATE INDEX "dp_orion_section_deck_artifacts_orderIndex_idx" ON "dp_orion_section_deck_artifacts"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_section_deck_artifacts_createdAt_idx" ON "dp_orion_section_deck_artifacts"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_final_deck_manifests_caseId_idx" ON "dp_orion_final_deck_manifests"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_final_deck_manifests_reportRunId_idx" ON "dp_orion_final_deck_manifests"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_final_deck_manifests_status_idx" ON "dp_orion_final_deck_manifests"("status");

-- CreateIndex
CREATE INDEX "dp_orion_final_deck_manifests_createdAt_idx" ON "dp_orion_final_deck_manifests"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_report_json_versions_caseId_idx" ON "dp_orion_report_json_versions"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_json_versions_reportRunId_idx" ON "dp_orion_report_json_versions"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_report_json_versions_status_idx" ON "dp_orion_report_json_versions"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_json_versions_orderIndex_idx" ON "dp_orion_report_json_versions"("orderIndex");

-- CreateIndex
CREATE INDEX "dp_orion_report_json_versions_createdAt_idx" ON "dp_orion_report_json_versions"("createdAt");

-- CreateIndex
CREATE INDEX "dp_orion_report_consistency_checks_caseId_idx" ON "dp_orion_report_consistency_checks"("caseId");

-- CreateIndex
CREATE INDEX "dp_orion_report_consistency_checks_reportRunId_idx" ON "dp_orion_report_consistency_checks"("reportRunId");

-- CreateIndex
CREATE INDEX "dp_orion_report_consistency_checks_status_idx" ON "dp_orion_report_consistency_checks"("status");

-- CreateIndex
CREATE INDEX "dp_orion_report_consistency_checks_createdAt_idx" ON "dp_orion_report_consistency_checks"("createdAt");

-- AddForeignKey
ALTER TABLE "dp_orion_report_runs" ADD CONSTRAINT "dp_orion_report_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_macro_sections" ADD CONSTRAINT "dp_orion_report_macro_sections_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_macro_sections" ADD CONSTRAINT "dp_orion_report_macro_sections_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_micro_stages" ADD CONSTRAINT "dp_orion_report_micro_stages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_micro_stages" ADD CONSTRAINT "dp_orion_report_micro_stages_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_micro_stages" ADD CONSTRAINT "dp_orion_report_micro_stages_macroSectionId_fkey" FOREIGN KEY ("macroSectionId") REFERENCES "dp_orion_report_macro_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_agent_runs" ADD CONSTRAINT "dp_orion_section_agent_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_agent_runs" ADD CONSTRAINT "dp_orion_section_agent_runs_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_agent_runs" ADD CONSTRAINT "dp_orion_section_agent_runs_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_raw_evidence" ADD CONSTRAINT "dp_orion_raw_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_raw_evidence" ADD CONSTRAINT "dp_orion_raw_evidence_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_raw_evidence" ADD CONSTRAINT "dp_orion_raw_evidence_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_normalized_evidence" ADD CONSTRAINT "dp_orion_normalized_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_normalized_evidence" ADD CONSTRAINT "dp_orion_normalized_evidence_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_normalized_evidence" ADD CONSTRAINT "dp_orion_normalized_evidence_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_selected_evidence" ADD CONSTRAINT "dp_orion_selected_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_selected_evidence" ADD CONSTRAINT "dp_orion_selected_evidence_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_selected_evidence" ADD CONSTRAINT "dp_orion_selected_evidence_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_excluded_evidence" ADD CONSTRAINT "dp_orion_excluded_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_excluded_evidence" ADD CONSTRAINT "dp_orion_excluded_evidence_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_excluded_evidence" ADD CONSTRAINT "dp_orion_excluded_evidence_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_evidence_files" ADD CONSTRAINT "dp_orion_evidence_files_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_evidence_files" ADD CONSTRAINT "dp_orion_evidence_files_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_evidence_files" ADD CONSTRAINT "dp_orion_evidence_files_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_evidence_packs" ADD CONSTRAINT "dp_orion_section_evidence_packs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_evidence_packs" ADD CONSTRAINT "dp_orion_section_evidence_packs_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_evidence_packs" ADD CONSTRAINT "dp_orion_section_evidence_packs_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_analyses" ADD CONSTRAINT "dp_orion_section_analyses_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_analyses" ADD CONSTRAINT "dp_orion_section_analyses_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_analyses" ADD CONSTRAINT "dp_orion_section_analyses_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_slide_manifests" ADD CONSTRAINT "dp_orion_section_slide_manifests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_slide_manifests" ADD CONSTRAINT "dp_orion_section_slide_manifests_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_slide_manifests" ADD CONSTRAINT "dp_orion_section_slide_manifests_microStageId_fkey" FOREIGN KEY ("microStageId") REFERENCES "dp_orion_report_micro_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_deck_artifacts" ADD CONSTRAINT "dp_orion_section_deck_artifacts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_deck_artifacts" ADD CONSTRAINT "dp_orion_section_deck_artifacts_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_section_deck_artifacts" ADD CONSTRAINT "dp_orion_section_deck_artifacts_macroSectionId_fkey" FOREIGN KEY ("macroSectionId") REFERENCES "dp_orion_report_macro_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_final_deck_manifests" ADD CONSTRAINT "dp_orion_final_deck_manifests_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_final_deck_manifests" ADD CONSTRAINT "dp_orion_final_deck_manifests_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_json_versions" ADD CONSTRAINT "dp_orion_report_json_versions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_json_versions" ADD CONSTRAINT "dp_orion_report_json_versions_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_consistency_checks" ADD CONSTRAINT "dp_orion_report_consistency_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_orion_report_consistency_checks" ADD CONSTRAINT "dp_orion_report_consistency_checks_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "dp_orion_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
