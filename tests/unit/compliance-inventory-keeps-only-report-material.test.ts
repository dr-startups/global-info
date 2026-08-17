/**
 * Материал деки из комплаенс-строк отбирает один фильтр.
 *
 * Классический отчёт отбрасывал демо-строки (`hitSource: "MOCK"`, `importedBy`
 * с `mock:`) и мастер-документы импорта (гибридный отчёт LexisNexis, экспорт
 * страниц Dow Jones / World-Check), канонический адаптер инвентаря — только
 * DISMISSED/FALSE_POSITIVE. Пока поля записи на слайд не печатались, разница
 * была незаметной; как только карточка печатает поля дословно, мастер-строка
 * импортированного PDF превращается в «Совпадение по имени: Потенциальное
 * совпадение», а демо-строка — в синтетическое совпадение на реальном деле.
 *
 * Ответ на вопрос «какие строки — материал отчёта» должен быть один, и живёт
 * он в адаптере инвентаря.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adaptDatabaseProfileToInventoryItem,
  isComplianceReportMaterial,
  type DatabaseProfileHitInput,
} from "@/modules/digital-profile/services/compliance-inventory-adapter";

const BASE_ROW: DatabaseProfileHitInput = {
  id: "row-1",
  provider: "LEXISNEXIS",
  importMethod: "MANUAL",
  hitSource: "MANUAL",
  matchedName: "Johan Holmstrom",
  subjectName: "Johan Holmstrom",
  matchType: "ADVERSE_MEDIA",
  matchScore: 64,
  reviewStatus: "PENDING",
  riskTypes: ["ADVERSE_MEDIA"],
  summary: "Adverse media hit (fixture).",
  profileUrl: "https://example.com/lexisnexis/row-1",
};

function adapt(row: DatabaseProfileHitInput) {
  return adaptDatabaseProfileToInventoryItem({
    row,
    caseId: "case-1",
    reportRunId: "run-1",
  });
}

describe("отбор комплаенс-строк для деки", () => {
  it("обычная ручная запись становится инвентарной", () => {
    const item = adapt(BASE_ROW);
    expect(item).not.toBeNull();
    expect(item!.evidenceType).toBe("compliance_hit");
    expect(isComplianceReportMaterial(BASE_ROW)).toBe(true);
  });

  it("демо-строки до деки не доходят", () => {
    expect(adapt({ ...BASE_ROW, hitSource: "MOCK" })).toBeNull();
    expect(adapt({ ...BASE_ROW, importedBy: "mock:seed" })).toBeNull();
    expect(adapt({ ...BASE_ROW, rawMetadataSafe: { demo: true } })).toBeNull();
  });

  it("мастер-документы импорта не превращаются в совпадения", () => {
    expect(
      adapt({
        ...BASE_ROW,
        rawMetadataSafe: { lexisNexisHybrid: { kind: "lexisnexis_report" } },
      })
    ).toBeNull();
    expect(
      adapt({
        ...BASE_ROW,
        rawMetadataSafe: { complianceVisual: { kind: "dow_jones_report" } },
      })
    ).toBeNull();
    expect(
      adapt({
        ...BASE_ROW,
        rawMetadataSafe: { complianceVisual: { kind: "world_check_report" } },
      })
    ).toBeNull();
  });

  it("снятые с рассмотрения записи по-прежнему отсеиваются", () => {
    expect(adapt({ ...BASE_ROW, reviewStatus: "DISMISSED" })).toBeNull();
    expect(adapt({ ...BASE_ROW, reviewStatus: "FALSE_POSITIVE" })).toBeNull();
  });

  it("поля записи доезжают до артефакта", () => {
    const item = adapt({
      ...BASE_ROW,
      aliases: ["Holmstrom, Johan", "J. Holmström"],
      countries: ["Швеция"],
      datesOfBirth: ["1975-04-02"],
      confidence: "HIGH",
      profileId: "ln-88213",
    });
    const meta = item!.rawMetadata as Record<string, unknown>;
    expect(meta.aliases).toEqual(["Holmstrom, Johan", "J. Holmström"]);
    expect(meta.countries).toEqual(["Швеция"]);
    expect(meta.datesOfBirth).toEqual(["1975-04-02"]);
    expect(meta.confidence).toBe("HIGH");
    expect(meta.profileId).toBe("ln-88213");
    expect(meta.summary).toBe("Adverse media hit (fixture).");
  });

  it("ответ один: классический путь не держит собственных предикатов", () => {
    const service = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/compliance-providers/service.ts"),
      "utf8"
    );
    // Утверждения булевы намеренно: содержимое файла в тексте расхождения
    // читать невозможно.
    expect(service.includes("isComplianceReportMaterial")).toBe(true);
    expect(service.includes("function isLexisHybridMaster")).toBe(false);
    expect(service.includes("function isComplianceVisualMaster")).toBe(false);
  });
});
