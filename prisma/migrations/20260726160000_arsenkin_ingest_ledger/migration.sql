-- Журнал ровно однократного приёма выносится из блоба состояния (шаг 12.4f).
--
-- Он лежал внутри `arsenkinEnrichmentState` рядом с прогрессом, хотя отвечает
-- на другой вопрос: прогресс выводится из строк задач, а журнал не выводится
-- ниоткуда — это единственная запись о принятых нагрузках. Смешение мешало
-- убрать дубль прогресса, не тронув то, что дублем не является.
--
-- Существующие прогоны переносят свой журнал в таблицу при первом чтении:
-- обратная засыпка по месту, без второй правды.

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

CREATE UNIQUE INDEX "dp_arsenkin_ingest_ledger_unifiedJobId_resultHash_key"
    ON "dp_arsenkin_ingest_ledger"("unifiedJobId", "resultHash");

CREATE INDEX "dp_arsenkin_ingest_ledger_unifiedJobId_externalTaskId_idx"
    ON "dp_arsenkin_ingest_ledger"("unifiedJobId", "externalTaskId");
