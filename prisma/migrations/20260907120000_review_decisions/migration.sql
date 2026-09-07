-- CreateTable
-- Решения аналитика по пунктам листа проверки: одна строка = одно решение по
-- паре «пункт + вопрос», прежнее гасится, а не переписывается. Правка
-- аддитивная — существующих таблиц и строк не касается, поэтому pre-deploy на
-- живой базе накатывает её обычным `migrate deploy`.
CREATE TABLE "dp_review_decisions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "decisionKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "previousDecisionId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'ui',
    "metadata" JSONB,

    CONSTRAINT "dp_review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dp_review_decisions_caseId_isActive_idx" ON "dp_review_decisions"("caseId", "isActive");

-- CreateIndex
CREATE INDEX "dp_review_decisions_caseId_itemKind_itemKey_idx" ON "dp_review_decisions"("caseId", "itemKind", "itemKey");

-- AddForeignKey
ALTER TABLE "dp_review_decisions" ADD CONSTRAINT "dp_review_decisions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
