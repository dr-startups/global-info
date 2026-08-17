/**
 * Классическая сводка не объявляет разобранные записи отсутствующими.
 *
 * Единый фильтр материала отчёта отсекает FALSE_POSITIVE и DISMISSED до
 * подсчёта. Из-за этого счётчик `falsePositives` стал структурно нулевым, а
 * дело, где все записи разобраны аналитиком как ложные срабатывания,
 * получало предупреждение «Ручные compliance-записи не добавлены. Реальные
 * провайдеры не настроены»: оба утверждения неверны — записи добавлялись и
 * разбор был.
 *
 * Отбор материала отчёта не меняется; меняется то, по каким строкам считаются
 * счётчики разбора и выбирается предупреждение.
 */

import { describe, expect, it } from "vitest";
import { summarizeComplianceHitRows } from "@/modules/digital-profile/compliance-providers/service";

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  provider: "LEXISNEXIS",
  matchedName: "Johan Holmstrom",
  matchScore: 64,
  confidence: "HIGH",
  reviewStatus: "PENDING",
  riskTypes: ["ADVERSE_MEDIA"],
  hitSource: "MANUAL",
  importedBy: "analyst:1",
  rawMetadataSafe: null,
  ...over,
});

describe("счётчики классической комплаенс-сводки", () => {
  it("разобранные как ложные срабатывания записи считаются и не объявляются недобавленными", () => {
    const summary = summarizeComplianceHitRows(
      [row({ id: "a", reviewStatus: "FALSE_POSITIVE" }), row({ id: "b", reviewStatus: "DISMISSED" })],
      { locale: "ru" }
    );
    expect(summary.totalHits).toBe(0);
    expect(summary.falsePositives).toBe(1);
    expect(summary.dataQualityWarnings.join(" ")).not.toMatch(
      /Ручные compliance-записи не добавлены/u
    );
    expect(summary.dataQualityWarnings.join(" ")).toMatch(/разобран/u);
  });

  it("записей по делу нет вовсе — так и говорит", () => {
    expect(summarizeComplianceHitRows([], { locale: "ru" }).dataQualityWarnings).toEqual([
      "Комплаенс-скрининг не выполнен.",
    ]);
  });

  it("в деле только демо-строки — предупреждение про ненастроенных провайдеров остаётся", () => {
    const summary = summarizeComplianceHitRows([row({ hitSource: "MOCK" })], { locale: "ru" });
    expect(summary.totalHits).toBe(0);
    expect(summary.dataQualityWarnings.join(" ")).toMatch(/Ручные compliance-записи не добавлены/u);
  });

  it("активные записи считаются по-прежнему", () => {
    const summary = summarizeComplianceHitRows(
      [
        row({ id: "a", reviewStatus: "PENDING" }),
        row({ id: "b", reviewStatus: "MATCH_CONFIRMED" }),
        row({ id: "c", reviewStatus: "FALSE_POSITIVE" }),
        row({ id: "d", rawMetadataSafe: { lexisNexisHybrid: { kind: "lexisnexis_report" } } }),
      ],
      { locale: "ru" }
    );
    expect(summary.totalHits).toBe(2);
    expect(summary.pendingHits).toBe(1);
    expect(summary.confirmedHits).toBe(1);
    expect(summary.falsePositives).toBe(1);
    expect(summary.byRiskType).toEqual({ ADVERSE_MEDIA: 2 });
    expect(summary.topHits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(summary.dataQualityWarnings.join(" ")).toMatch(/требуют проверки аналитиком/u);
  });
});
