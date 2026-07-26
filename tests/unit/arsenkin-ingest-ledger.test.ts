import { describe, expect, it } from "vitest";
import {
  EMPTY_INGEST_LEDGER,
  ledgerFromRows,
  ledgerIsEmpty,
  rowsFromLedger,
} from "../../src/modules/digital-profile/services/arsenkin-ingest-ledger";
import { applyExactlyOnceIngest } from "../../src/modules/digital-profile/services/arsenkin-exactly-once-ingest";

/**
 * Шаг 12.4f (docs/rework/12-durable-step-execution.md).
 *
 * Журнал ровно однократного приёма лежал внутри блоба `arsenkinEnrichmentState`
 * рядом с прогрессом. Прогресс выводится из строк задач и потому был дублем;
 * журнал не выводится ниоткуда — это единственная запись о принятых нагрузках.
 * Пока они лежали вместе, нельзя было убрать дубль, не тронув то, что дублем
 * не является.
 */

const obs = (over: Record<string, unknown> = {}) => ({
  externalTaskId: "task-1",
  resultHash: "hash-1",
  url: "https://example.com/a",
  ...over,
});

describe("журнал переживает переход в таблицу", () => {
  it("строки таблицы превращаются в журнал", () => {
    const ledger = ledgerFromRows([
      { externalTaskId: "task-1", resultHash: "h1", observationIds: ["obs:1"] },
      { externalTaskId: null, resultHash: "h2", observationIds: [] },
    ]);
    expect(ledger.ingestedResultHashes).toEqual(["h1", "h2"]);
    expect(ledger.externalTaskIdToResultHash).toEqual({ "task-1": "h1" });
    expect(ledger.resultHashToObservationIds.h1).toEqual(["obs:1"]);
  });

  it("нагрузка без задачи journal не ломает", () => {
    // `externalTaskIdToResultHash` заполняется только когда задача известна.
    const ledger = ledgerFromRows([{ externalTaskId: "", resultHash: "h", observationIds: null }]);
    expect(ledger.ingestedResultHashes).toEqual(["h"]);
    expect(ledger.externalTaskIdToResultHash).toEqual({});
  });

  it("обратное превращение сохраняет связь задачи и нагрузки", () => {
    const rows = rowsFromLedger(
      {
        ingestedResultHashes: ["h1", "h2"],
        resultHashToObservationIds: { h1: ["obs:1"] },
        externalTaskIdToResultHash: { "task-1": "h1" },
      },
      { caseId: "c", unifiedJobId: "j" }
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ resultHash: "h1", externalTaskId: "task-1" });
    expect(rows[1]).toMatchObject({ resultHash: "h2", externalTaskId: null });
  });

  it("пустой журнал переносить нечего", () => {
    expect(ledgerIsEmpty(EMPTY_INGEST_LEDGER)).toBe(true);
    expect(ledgerIsEmpty(null)).toBe(true);
    expect(ledgerIsEmpty(ledgerFromRows([{ externalTaskId: "t", resultHash: "h", observationIds: [] }]))).toBe(
      false
    );
  });
});

describe("приём опирается на переданный журнал", () => {
  const scope = { caseId: "c", unifiedJobId: "j" };

  it("нагрузка из журнала повторно не принимается", () => {
    const ledger = ledgerFromRows([
      { externalTaskId: "task-1", resultHash: "hash-1", observationIds: ["obs:hash-1:0"] },
    ]);
    const r = applyExactlyOnceIngest({
      ...scope,
      ledger,
      previousObservations: [obs() as never],
      candidates: [obs() as never],
    });
    expect(r.conflict).toBe(false);
    expect(r.newlyIngestedCount).toBe(0);
    expect(r.skippedDuplicateCount).toBe(1);
  });

  it("другая нагрузка от той же задачи останавливает приём", () => {
    // Молча принять вторую версию значило бы подменить доказательства.
    const ledger = ledgerFromRows([
      { externalTaskId: "task-1", resultHash: "hash-1", observationIds: [] },
    ]);
    const r = applyExactlyOnceIngest({
      ...scope,
      ledger,
      candidates: [obs({ resultHash: "hash-2" }) as never],
    });
    expect(r.conflict).toBe(true);
    expect(r.conflictCode).toBe("EXTERNAL_TASK_HASH_CONFLICT");
  });

  it("итог приёма отдаёт журнал для записи", () => {
    const r = applyExactlyOnceIngest({
      ...scope,
      ledger: { ...EMPTY_INGEST_LEDGER },
      candidates: [obs() as never],
    });
    expect(r.ledger.ingestedResultHashes).toEqual(["hash-1"]);
    expect(r.ledger.externalTaskIdToResultHash).toEqual({ "task-1": "hash-1" });
  });

  it("отказ при конфликте тоже отдаёт журнал", () => {
    // Иначе вызывающий потерял бы уже накопленные записи.
    const ledger = ledgerFromRows([
      { externalTaskId: "task-1", resultHash: "hash-1", observationIds: [] },
    ]);
    const r = applyExactlyOnceIngest({
      ...scope,
      ledger,
      candidates: [obs({ resultHash: "hash-2" }) as never],
    });
    expect(r.ledger.ingestedResultHashes).toContain("hash-1");
  });

  it("без журнала поведение прежнее — берётся из блоба", () => {
    // Совместимость: вызывающие, ещё не передающие журнал, работают как раньше.
    const r = applyExactlyOnceIngest({
      ...scope,
      previousState: {
        ingestedResultHashes: ["hash-1"],
        resultHashToObservationIds: {},
        externalTaskIdToResultHash: { "task-1": "hash-1" },
      } as never,
      candidates: [obs({ resultHash: "hash-2" }) as never],
    });
    expect(r.conflict).toBe(true);
  });
});
