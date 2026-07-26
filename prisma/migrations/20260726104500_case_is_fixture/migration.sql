-- Кейс-фикстура смока отделяется от работы оператора (шаг 13, B6).
--
-- Смоки заводят кейсы-заглушки через scripts/lib/ensure-smoke-case.ts, и они
-- лежали в общем списке кейсов рядом с настоящими проверками. Признак хранится
-- в записи, а не выводится из префикса номера: номер — это текст, и совпадение
-- с ним не должно скрывать кейс оператора.

ALTER TABLE "dp_cases" ADD COLUMN "isFixture" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "dp_cases_isFixture_idx" ON "dp_cases"("isFixture");

-- Обратная засыпка ровно тех строк, которые создаёт помощник смоков: он
-- проставляет createdBy = 'smoke' и номер вида SMOKE-<id>. Совпадение обоих
-- признаков исключает попадание настоящего кейса.
UPDATE "dp_cases"
SET "isFixture" = true
WHERE "createdBy" = 'smoke' AND "caseNumber" LIKE 'SMOKE-%';
