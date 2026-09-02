-- CreateTable
-- Ворота выбора персоны: одна строка = одна сборка панели плюс, возможно,
-- решение по ней. Правка аддитивная — существующих таблиц и строк не касается,
-- поэтому pre-deploy на живой базе накатывает её обычным `migrate deploy`.
CREATE TABLE "dp_subject_persona_checks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "subjectInputHash" TEXT NOT NULL,
    "requestJson" JSONB,
    "personasJson" JSONB NOT NULL,
    "fetchStatus" TEXT NOT NULL,
    "errorCode" TEXT,
    "searchedBy" TEXT,
    "searchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" TEXT,
    "selectedPersonaJson" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "dp_subject_persona_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dp_subject_persona_checks_caseId_searchedAt_idx" ON "dp_subject_persona_checks"("caseId", "searchedAt");

-- AddForeignKey
ALTER TABLE "dp_subject_persona_checks" ADD CONSTRAINT "dp_subject_persona_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
