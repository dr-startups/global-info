/**
 * Журнал ровно однократного приёма — отдельно от прогресса (шаг 12.4f).
 *
 * Он жил внутри блоба `arsenkinEnrichmentState` рядом с тем, какие агенты
 * запланированы и завершены. Это смешивало разное по природе: прогресс
 * выводится из строк `ProviderTask` и потому был дублем, а журнал не выводится
 * ниоткуда — это единственная запись о том, какие нагрузки уже приняты.
 * Пока они лежали вместе, нельзя было убрать дубль, не тронув то, что дублем
 * не является.
 *
 * Здесь журнал — самостоятельная величина. Чтение и запись в БД отделены от
 * решения: решение принимает чистая функция приёма, а этот модуль отвечает
 * только за то, где журнал лежит.
 */

import type { PrismaClient } from "@prisma/client";

/** Журнал в форме, удобной решению: то же, что лежало в блобе. */
export type ArsenkinIngestLedger = {
  /** Полные sha256 принятых нагрузок. */
  ingestedResultHashes: string[];
  /** Нагрузка → идентификаторы её наблюдений (разбор происхождения). */
  resultHashToObservationIds: Record<string, string[]>;
  /** Задача провайдера → принятая от неё нагрузка (основа проверки подмены). */
  externalTaskIdToResultHash: Record<string, string>;
};

export const EMPTY_INGEST_LEDGER: ArsenkinIngestLedger = {
  ingestedResultHashes: [],
  resultHashToObservationIds: {},
  externalTaskIdToResultHash: {},
};

/** Строка таблицы в том объёме, в каком нужна журналу. */
export type LedgerRow = {
  externalTaskId: string | null;
  resultHash: string;
  observationIds: unknown;
};

/** Строки таблицы → журнал. */
export function ledgerFromRows(rows: readonly LedgerRow[]): ArsenkinIngestLedger {
  const ledger: ArsenkinIngestLedger = {
    ingestedResultHashes: [],
    resultHashToObservationIds: {},
    externalTaskIdToResultHash: {},
  };
  for (const row of rows) {
    const hash = String(row.resultHash ?? "").trim();
    if (!hash) continue;
    if (!ledger.ingestedResultHashes.includes(hash)) ledger.ingestedResultHashes.push(hash);
    ledger.resultHashToObservationIds[hash] = Array.isArray(row.observationIds)
      ? row.observationIds.map((v) => String(v))
      : [];
    const ext = String(row.externalTaskId ?? "").trim();
    if (ext) ledger.externalTaskIdToResultHash[ext] = hash;
  }
  return ledger;
}

/** Журнал → строки для записи. */
export function rowsFromLedger(
  ledger: ArsenkinIngestLedger,
  scope: { caseId: string; unifiedJobId: string }
): Array<{
  caseId: string;
  unifiedJobId: string;
  externalTaskId: string | null;
  resultHash: string;
  observationIds: string[];
}> {
  const hashToTask = new Map<string, string>();
  for (const [ext, hash] of Object.entries(ledger.externalTaskIdToResultHash)) {
    hashToTask.set(hash, ext);
  }
  return ledger.ingestedResultHashes.map((hash) => ({
    caseId: scope.caseId,
    unifiedJobId: scope.unifiedJobId,
    externalTaskId: hashToTask.get(hash) ?? null,
    resultHash: hash,
    observationIds: ledger.resultHashToObservationIds[hash] ?? [],
  }));
}

/** Пуст ли журнал — переносить нечего. */
export function ledgerIsEmpty(ledger: ArsenkinIngestLedger | null | undefined): boolean {
  return !ledger || ledger.ingestedResultHashes.length === 0;
}

/**
 * Читает журнал прогона.
 *
 * Если в таблице пусто, а в блобе что-то есть — переносит: прогоны, начатые до
 * этой правки, не должны потерять запись о принятых нагрузках, иначе повторный
 * приём той же нагрузки пройдёт как новый. Перенос односторонний и по месту:
 * после него источник один.
 */
export async function loadIngestLedger(input: {
  caseId: string;
  unifiedJobId: string;
  /** Журнал из блоба — только как источник переноса. */
  fromBlob?: ArsenkinIngestLedger | null;
  prisma?: PrismaClient;
}): Promise<ArsenkinIngestLedger> {
  const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
  const rows = await prisma.arsenkinIngestLedgerEntry.findMany({
    where: { unifiedJobId: input.unifiedJobId },
    select: { externalTaskId: true, resultHash: true, observationIds: true },
  });
  if (rows.length > 0) return ledgerFromRows(rows);

  if (ledgerIsEmpty(input.fromBlob)) return { ...EMPTY_INGEST_LEDGER };
  await saveIngestLedger({
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    ledger: input.fromBlob!,
    prisma,
  });
  return input.fromBlob!;
}

/**
 * Записывает журнал.
 *
 * Строки только добавляются: принятая нагрузка не перестаёт быть принятой.
 * Повторная запись той же нагрузки молча пропускается — так запись остаётся
 * безопасной при повторе тика.
 */
export async function saveIngestLedger(input: {
  caseId: string;
  unifiedJobId: string;
  ledger: ArsenkinIngestLedger;
  prisma?: PrismaClient;
}): Promise<void> {
  const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
  const rows = rowsFromLedger(input.ledger, {
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
  });
  if (rows.length === 0) return;
  await prisma.arsenkinIngestLedgerEntry.createMany({ data: rows, skipDuplicates: true });
}
