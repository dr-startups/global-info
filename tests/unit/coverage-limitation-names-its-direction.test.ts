/**
 * Ограничение покрытия называет направление, а не только причину.
 *
 * Стр. 4 живого отчёта 91: «Ограничения покрытия: поверхность не собрана в
 * текущем прогоне; часть сигналов не верифицирована первоисточниками». Что
 * именно не собрано — не сказано, хотя пробел это знает: в
 * `executive-summary-input.json` лежит `{area: "проверка URL и индексации",
 * detail: "поверхность не собрана в текущем прогоне"}`. Имя снимала склейка
 * клиентских строк, оставлявшая один `detail`.
 *
 * Причина, по которой имя когда-то сняли, остаётся в силе: четыре пробела с
 * одной причиной давали в резюме одну и ту же фразу подряд. Поэтому строки
 * сводятся по причине, а направления перечисляются в одной строке.
 *
 * Вторая половина проверки — про то, о чём резюме молчало вовсе: отказавший
 * скрининг комплаенса не попадал в пробелы покрытия ни при каком исходе,
 * потому что ячейки покрытия строились только из наблюдений выдачи, а
 * скрининг наблюдений не оставляет.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { clientCoverageLimitationLines } from "@/modules/digital-profile/orion-golden/executive-summary/coverage-limitation-lines";
import { composeExecutiveSummaryDeterministic } from "@/modules/digital-profile/orion-golden/executive-summary/deterministic-composer";
import type { ComplianceScreeningRunRow } from "@/modules/digital-profile/services/compliance-inventory-adapter";
import { complianceCoverageCells } from "@/modules/digital-profile/services/compliance-inventory-adapter";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

const NOT_COLLECTED = "поверхность не собрана в текущем прогоне";
const UNVERIFIED = "часть сигналов не верифицирована первоисточниками";

describe("клиентская строка ограничения", () => {
  it("называет направление и причину", () => {
    expect(
      clientCoverageLimitationLines([{ area: "проверка URL и индексации", detail: NOT_COLLECTED }])
    ).toEqual([`проверка URL и индексации — ${NOT_COLLECTED}`]);
  });

  it("два направления с одной причиной дают одну строку, а не две одинаковых фразы", () => {
    expect(
      clientCoverageLimitationLines([
        { area: "проверка URL и индексации", detail: NOT_COLLECTED },
        { area: "комплаенс-базы", detail: NOT_COLLECTED },
      ])
    ).toEqual([`проверка URL и индексации, комплаенс-базы — ${NOT_COLLECTED}`]);
  });

  it("разные причины остаются разными строками в порядке пробелов", () => {
    expect(
      clientCoverageLimitationLines([
        { area: "проверка URL и индексации", detail: NOT_COLLECTED },
        { area: "Криминальные / судебные материалы", detail: UNVERIFIED },
      ])
    ).toEqual([
      `проверка URL и индексации — ${NOT_COLLECTED}`,
      `Криминальные / судебные материалы — ${UNVERIFIED}`,
    ]);
  });

  it("повтор одного и того же пробела направление не удваивает", () => {
    expect(
      clientCoverageLimitationLines([
        { area: "комплаенс-базы", detail: NOT_COLLECTED },
        { area: "комплаенс-базы", detail: NOT_COLLECTED },
      ])
    ).toEqual([`комплаенс-базы — ${NOT_COLLECTED}`]);
  });

  it("пустой список пробелов строк не даёт", () => {
    expect(clientCoverageLimitationLines([])).toEqual([]);
  });
});

/** Каталог артефактов на прогон подготовки. */
function artifactsDir(): string {
  return mkdtempSync(join(tmpdir(), "coverage-limitation-"));
}

function screening(status: string, errorCode: string | null): ComplianceScreeningRunRow {
  return {
    provider: "OPEN_SANCTIONS",
    status,
    hitCount: 0,
    errorCode,
    startedAt: "2026-08-31T09:00:00.000Z",
    finishedAt: "2026-08-31T09:00:01.000Z",
  };
}

async function prepareWith(screenings: ComplianceScreeningRunRow[]) {
  const dir = artifactsDir();
  await runCanonicalReportPrepare(await tinyPrepareInput(dir, { complianceScreenings: screenings }));
  const read = (name: string) =>
    JSON.parse(readFileSync(join(dir, "analytics", name), "utf8")) as Record<string, unknown>;
  return {
    dataGaps: (read("executive-summary-input.json").dataGaps ?? []) as Array<{
      area: string;
      detail: string;
    }>,
    limitations: (
      (read("client-summary-pack.json").scope as { coverageLimitations?: string[] })
        ?.coverageLimitations ?? []
    ) as string[],
  };
}

describe("ограничение покрытия называется одинаково во всех местах отчёта", () => {
  it("сводка резюме печатает те же строки, что и клиентский пакет", () => {
    /*
     * `dataLimitations` резюме и `coverageLimitations` пакета строятся из одних
     * и тех же пробелов и обе едут клиенту. Пока их собирали два разных места,
     * они отвечали на один вопрос по-разному — и разошлись бы молча.
     */
    const gaps = [
      { area: "проверка URL и индексации", detail: NOT_COLLECTED },
      { area: "комплаенс-базы", detail: NOT_COLLECTED },
    ];
    const summary = composeExecutiveSummaryDeterministic(
      {
        caseId: "case-limitations",
        datasetId: "dataset-limitations",
        subject: { displayName: "Субъект" },
        coverage: [],
        regionalMetrics: [],
        verifiedFindings: { findings: [], excludedFindingIds: [] },
        ambiguousFindings: [],
        identityPollution: { otherSubjectCount: 0, ambiguousCount: 0, notes: [] },
        dataGaps: gaps,
        sourceQuality: [],
        recommendedActions: [],
      } as unknown as Parameters<typeof composeExecutiveSummaryDeterministic>[0],
      "hash-limitations"
    );
    expect(summary.dataLimitations).toEqual(clientCoverageLimitationLines(gaps));
  });
});

describe("отказавший скрининг комплаенса назван в ограничениях покрытия", () => {
  it("401 единственной работающей базы доезжает до клиентской строки", async () => {
    const { dataGaps, limitations } = await prepareWith([
      screening("PROVIDER_ERROR", "PROVIDER_UNAUTHORIZED"),
    ]);
    expect(dataGaps.map((g) => g.area)).toContain("комплаенс-базы");
    expect(limitations.join(" | ")).toContain("комплаенс-базы");
    /*
     * У базы данных нет «поверхности», которую можно собрать, — причина
     * названа своими словами. Одна формулировка на все направления читалась бы
     * клиенту как ошибка отчёта.
     */
    const gap = dataGaps.find((g) => g.area === "комплаенс-базы")!;
    expect(gap.detail).toBe("проверка по базам в этом прогоне не выполнена");
    expect(limitations.join(" | ")).not.toContain("комплаенс-базы — поверхность");
  });

  it("состоявшаяся проверка пробела не создаёт", async () => {
    const { dataGaps, limitations } = await prepareWith([screening("SUCCESS", null)]);
    expect(dataGaps.map((g) => g.area)).not.toContain("комплаенс-базы");
    expect(limitations.join(" | ")).not.toContain("комплаенс-базы");
  });

  it("успех одной базы гасит пробел, объявленный отказом другой", async () => {
    // Пробел покрытия — это поверхность, а не провайдер: сказать «комплаенс-базы
    // не собраны», когда одна база проверена, значит соврать в резюме.
    const { dataGaps } = await prepareWith([
      screening("PROVIDER_ERROR", "PROVIDER_UNAUTHORIZED"),
      { ...screening("SUCCESS", null), provider: "DOW_JONES" },
    ]);
    expect(dataGaps.map((g) => g.area)).not.toContain("комплаенс-базы");
  });
});

describe("ячейка покрытия называет отказ так же, как соседний поставщик", () => {
  it("ответ провайдера ошибкой — ERROR, ненастроенность — NOT_COLLECTED", () => {
    /*
     * `genAnswerCoverageCells` рядом различает эти два исхода, и вопрос «как
     * назвать отказ» у двух соседних поставщиков ячеек обязан иметь один
     * ответ. Для пробела покрытия разницы нет — обе величины не-`OK`, — но
     * артефакт покрытия читает и оператор.
     */
    const cells = complianceCoverageCells([
      { provider: "OPEN_SANCTIONS", status: "PROVIDER_ERROR", hitCount: 0, errorCode: "PROVIDER_UNAUTHORIZED" },
      { provider: "DOW_JONES", status: "NOT_CONFIGURED", hitCount: 0, errorCode: null },
      { provider: "LEXISNEXIS", status: "SUCCESS", hitCount: 0, errorCode: null },
    ]);
    expect(cells.map((c) => `${c.engine}:${c.status}`)).toEqual([
      "OPEN_SANCTIONS:ERROR",
      "DOW_JONES:NOT_COLLECTED",
      "LEXISNEXIS:OK",
    ]);
    // Поверхность и регион у проверки по базам не зависят от исхода.
    expect(new Set(cells.map((c) => `${c.region}|${c.surface}`))).toEqual(
      new Set(["MIXED|compliance"])
    );
  });
});
