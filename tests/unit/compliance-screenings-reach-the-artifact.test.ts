/**
 * Итоги скринингов доезжают до артефакта на боевом пути, а не только в фикстуре.
 *
 * Различие «проверено — совпадений нет» / «проверка не выполнялась» держится на
 * блоке `screenings` в `compliance-inventory.json`. Он собирается из
 * `dp_compliance_screening_runs`, но подводка живого пути была мертва: бандл
 * prisma для `runCanonicalReportPrepare` перечисляет делегаты поимённо, и
 * `complianceScreeningRun` в списке не было — на любом живом прогоне артефакт
 * писал `screenings: []`, хотя строки ранов в базе создаются (скрининг
 * OpenSanctions входит в unified-прогон).
 *
 * Здесь закрепляется и сам разбор ранов, и то, что делегат до подготовки
 * доезжает: без второго первое остаётся упражнением для юнитов.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  latestScreeningPerProvider,
  resolveComplianceScreenings,
  type ComplianceScreeningRunRow,
} from "@/modules/digital-profile/services/compliance-inventory-adapter";

function fakePrisma(rows: ComplianceScreeningRunRow[]) {
  return {
    complianceScreeningRun: {
      findMany: async () => rows,
    },
  };
}

describe("итоги скринингов для артефакта", () => {
  it("из prisma берётся последний ран каждой базы", async () => {
    const screenings = await resolveComplianceScreenings({
      caseId: "case-1",
      prisma: fakePrisma([
        {
          provider: "OPEN_SANCTIONS",
          status: "NOT_CONFIGURED",
          hitCount: 0,
          errorCode: "PROVIDER_NOT_CONFIGURED",
          startedAt: "2026-05-01T10:00:00.000Z",
          finishedAt: "2026-05-01T10:00:05.000Z",
        },
        {
          provider: "OPEN_SANCTIONS",
          status: "SUCCESS",
          hitCount: 2,
          startedAt: "2026-05-12T09:30:00.000Z",
          finishedAt: new Date("2026-05-12T09:30:12.000Z"),
        },
        {
          provider: "DOW_JONES",
          status: "PROVIDER_ERROR",
          hitCount: 0,
          errorCode: "PROVIDER_NOT_IMPLEMENTED",
          startedAt: "2026-05-12T09:31:00.000Z",
          finishedAt: "2026-05-12T09:31:01.000Z",
        },
      ]),
    });
    // Порядок фиксирован по имени базы: артефакт обязан быть воспроизводимым.
    expect(screenings.map((s) => s.provider)).toEqual(["DOW_JONES", "OPEN_SANCTIONS"]);
    const openSanctions = screenings.find((s) => s.provider === "OPEN_SANCTIONS")!;
    // Более ранняя неудача не отменяет успешной проверки, сделанной после неё.
    expect(openSanctions.status).toBe("SUCCESS");
    expect(openSanctions.hitCount).toBe(2);
    expect(openSanctions.finishedAt).toBe("2026-05-12T09:30:12.000Z");
    expect(screenings.find((s) => s.provider === "DOW_JONES")!.errorCode).toBe(
      "PROVIDER_NOT_IMPLEMENTED"
    );
  });

  it("фикстура сильнее базы, а отсутствие делегата — не отказ, а пустой список", async () => {
    const fromFixture = await resolveComplianceScreenings({
      caseId: "case-1",
      screenings: [{ provider: "dow_jones", status: "success", hitCount: 0, finishedAt: null }],
      prisma: fakePrisma([{ provider: "LEXISNEXIS", status: "SUCCESS", hitCount: 9 }]),
    });
    expect(fromFixture.map((s) => s.provider)).toEqual(["DOW_JONES"]);
    expect(fromFixture[0]!.status).toBe("SUCCESS");
    expect(await resolveComplianceScreenings({ caseId: "case-1" })).toEqual([]);
  });

  it("ран без даты завершения не вытесняет ран с датой", () => {
    const rows: ComplianceScreeningRunRow[] = [
      { provider: "OPEN_SANCTIONS", status: "SUCCESS", hitCount: 1, finishedAt: "2026-05-12T09:30:00.000Z" },
      { provider: "OPEN_SANCTIONS", status: "FAILED", hitCount: 0 },
    ];
    expect(latestScreeningPerProvider(rows)[0]!.status).toBe("SUCCESS");
  });

  it("живой путь передаёт делегат ранов в подготовку отчёта", () => {
    // Утверждение булево намеренно: содержимое файла в тексте расхождения
    // читать невозможно.
    const orchestrator = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts"
      ),
      "utf8"
    );
    expect(orchestrator.includes("complianceScreeningRun: preparePrisma.complianceScreeningRun")).toBe(
      true
    );
  });
});
