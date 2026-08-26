/**
 * Запись комплаенса доезжает из инвентаря до индекса деки целиком.
 *
 * Построитель печатает в колонке «Совпадение по имени» только `matchedName`
 * записи, а при его отсутствии — прочерк. Само поле кладёт в индекс загрузчик:
 * пока он его не клал, у построителя не было данных, чтобы отличить запись без
 * имени от записи, названной именем субъекта, — `title` инвентаря к этому
 * моменту уже содержит подстановку.
 *
 * Проверка отдельная и на настоящем артефакте: юниты построителя кладут индекс
 * руками и эту проводку не видят вовсе. Соседние проводки того же блока держит
 * этот же тест, и не для симметрии: снятые разом `matchCategory`,
 * `reviewStatus`, `url` и `confidence` оставляли весь прогон зелёным, а на
 * клиентской странице у каждой записи вставали «—» в типе совпадения,
 * «Не подтверждено» в статусе и исчезала ссылка на карточку. Поэтому запись
 * сверяется **целиком**: поле, выпавшее из блока, обязано назвать себя само.
 *
 * В приёмке этот блок не исполняется ни разу — в замороженных артефактах
 * эталона 72 файла `compliance-inventory.json` нет вовсе.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";

const REF_NAMED = "inventory:db-named";
const REF_NAMELESS = "inventory:db-nameless";

function analyticsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-compliance-name-"));
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  write("verified-finding-bundle.json", { findings: [] });
  write("ambiguous-findings.json", []);
  write("surface-analysis.json", {});
  write("executive-summary.json", {});
  write("report-data-binding.json", {
    baseReportRunId: "run-1",
    datasetId: "ds-1",
    caseId: "case-1",
  });
  write("provider-delta.json", { baseCount: 2, arsenkinObservationCount: 0 });
  write("composite-serp-observations.json", { observations: [], baseCount: 0, compositeCount: 0 });
  write("subject-resolution.json", { items: [] });
  // Инвентарь пишет адаптер: `title` — уже результат подстановки, `matchedName`
  // — то, что действительно лежит в записи базы.
  write("compliance-inventory.json", {
    version: "compliance-inventory-v1",
    caseId: "case-1",
    count: 2,
    items: [
      {
        inventoryId: "db-named",
        evidenceType: "compliance_hit",
        title: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
        rawMetadata: {
          provider: "OPEN_SANCTIONS",
          matchCategory: "SANCTION_LINKED",
          matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
          matchScore: 100,
          reviewStatus: "PENDING",
          confidence: "HIGH",
          aliases: ["Кулебакин К. С."],
          countries: ["ru"],
          datesOfBirth: ["1975-04-02"],
          profileId: "ru-inn-504309044808",
          summary: "темы: связь с санкционным лицом; источника в записи: 2",
          profileUrl: "https://www.opensanctions.org/entities/ru-inn-504309044808/",
        },
      },
      {
        inventoryId: "db-nameless",
        evidenceType: "compliance_hit",
        // Своего имени у записи нет, и в заголовок подставлено имя субъекта.
        title: "Умар Назарович Кремлев",
        rawMetadata: { provider: "WORLD_CHECK", matchType: "SANCTIONS", reviewStatus: "PENDING" },
      },
    ],
    // Итоги скринингов лежат в том же файле и тем же блоком читаются: по ним
    // страница базы отличает «проверено, совпадений нет» от «проверка не
    // выполнялась». Строка без провайдера отбрасывается — назвать базу нечем.
    screenings: [
      { provider: "OPEN_SANCTIONS", status: "SUCCESS", hitCount: 2, finishedAt: "2026-08-25T08:15:06.000Z" },
      { status: "SUCCESS", hitCount: 0 },
    ],
  });
  return dir;
}

describe("запись комплаенса в индексе доказательств", () => {
  it("собственное имя записи попадает в индекс отдельным полем", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir());
    expect(inputs.evidenceIndex[REF_NAMED]?.matchedName).toBe("КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН");
  });

  it("у записи без своего имени поля нет, а не имя субъекта", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir());
    const entry = inputs.evidenceIndex[REF_NAMELESS];
    expect(entry?.title).toBe("Умар Назарович Кремлев");
    expect(entry?.matchedName).toBeUndefined();
  });

  /**
   * Сверка целиком, а не по одному полю: дефект этого блока — не «поле читается
   * неверно», а «поле перестали читать». Выпавшую проводку видно только
   * сравнением всей записи.
   */
  it("поля записи доезжают все до одного", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir());
    expect(inputs.evidenceIndex[REF_NAMED]).toEqual({
      kind: "compliance_hit",
      title: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
      matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
      providerLabel: "OPEN_SANCTIONS",
      matchCategory: "SANCTION_LINKED",
      matchScore: 100,
      reviewStatus: "PENDING",
      confidence: "HIGH",
      aliases: ["Кулебакин К. С."],
      countries: ["ru"],
      datesOfBirth: ["1975-04-02"],
      profileId: "ru-inn-504309044808",
      summary: "темы: связь с санкционным лицом; источника в записи: 2",
      url: "https://www.opensanctions.org/entities/ru-inn-504309044808/",
    });
  });

  /**
   * Категория читается из `matchCategory`, а при его отсутствии — из
   * `matchType`: у строк прошлых прогонов заполнено только второе.
   */
  it("категория берётся из matchType, когда своего поля нет", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir());
    expect(inputs.evidenceIndex[REF_NAMELESS]?.matchCategory).toBe("SANCTIONS");
  });

  it("итоги скринингов доезжают, а строка без базы отбрасывается", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir());
    expect(inputs.complianceScreenings).toEqual([
      {
        provider: "OPEN_SANCTIONS",
        status: "SUCCESS",
        hitCount: 2,
        finishedAt: "2026-08-25T08:15:06.000Z",
      },
    ]);
  });
});
