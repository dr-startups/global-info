import { describe, expect, it } from "vitest";
import {
  buildOrionQueryPlanDetailed,
  type OrionQuerySpec,
} from "../../src/modules/digital-profile/search-surfaces/orion-query-plan";

/**
 * Шаг 10 плана.
 *
 * Поверхности выдачи запрашивались текстовым поиском по названию поверхности:
 * в Google уходил буквальный запрос «Павел Валерьевич Дуров похожие запросы».
 * Это осмысленно ровно настолько же, насколько запрос «Иван Иванов список
 * файлов»: платный вызов тратится, а в корпус доказательств попадает выдача по
 * бессмысленной строке. Настоящие подсказки и похожие запросы приходят полями
 * ответа на обычный запрос.
 */

const SUBJECT = {
  fullName: "Дуров Павел Валерьевич",
  aliases: ["Pavel Durov"],
  targetRegions: ["RU", "UAE", "INTERNATIONAL"],
  location: "Abu Dhabi",
};

function plan(): OrionQuerySpec[] {
  return buildOrionQueryPlanDetailed(SUBJECT, { includeRiskProbes: true }).plan;
}

/** Названия технических поверхностей — не поисковые термины. */
const SURFACE_TOKENS = [
  "подсказки",
  "похожие запросы",
  "autocomplete",
  "related queries",
  "related searches",
  "suggestions",
];

describe("матрица запросов: служебные токены", () => {
  it("ни один запрос не содержит названия поверхности", () => {
    const offenders = plan()
      .map((q) => q.normalizedQuery)
      .filter((q) => SURFACE_TOKENS.some((t) => q.includes(t)));
    expect(offenders).toEqual([]);
  });

  it("ни один запрос не содержит кода региона отдельным словом", () => {
    const codes = /(^|\s)(ru|rus|uae|ae|intl|international|global|eu|us|usa)(\s|$)/u;
    const offenders = plan()
      .map((q) => q.normalizedQuery)
      .filter((q) => codes.test(q));
    expect(offenders).toEqual([]);
  });

  it("план не порождает строк за поверхностями", () => {
    const surfacePurposes = new Set([
      "suggestion_lookup",
      "related_lookup",
      "image_lookup",
      "video_lookup",
    ]);
    expect(plan().filter((q) => surfacePurposes.has(q.purpose))).toEqual([]);
  });

  it("осмысленный географический контекст в запросе остаётся", () => {
    // «Pavel Durov abu dhabi» — настоящий запрос с другой выдачей, в отличие
    // от «Pavel Durov UAE», где код региона задаётся параметром gl.
    const hinted = plan().filter((q) => q.normalizedQuery.includes("abu dhabi"));
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.every((q) => q.internalReason === "intl_region_hint_variant")).toBe(true);
  });

  it("код региона не вытесняет географический контекст из подсказок", () => {
    // Прежняя реализация брала первые два хинта из [...targetRegions, location]
    // и до location — единственного осмысленного — очередь не доходила.
    const built = buildOrionQueryPlanDetailed(SUBJECT, {});
    expect(built.regionHintCount).toBe(1);
    expect(built.warnings).not.toContain("region_hints_missing");
  });

  it("субъект без географии не получает хинтов и честно об этом сообщает", () => {
    const built = buildOrionQueryPlanDetailed(
      { fullName: "Дуров Павел Валерьевич", targetRegions: ["RU", "UAE"] },
      {}
    );
    expect(built.regionHintCount).toBe(0);
    expect(built.warnings).toContain("region_hints_missing");
  });

  it("содержательные поисковые термины сохранены", () => {
    const queries = plan().map((q) => q.normalizedQuery);
    expect(queries.some((q) => q.includes("интервью"))).toBe(true);
    expect(queries.some((q) => q.includes("биография wikipedia"))).toBe(true);
    expect(queries.some((q) => q.includes("interview"))).toBe(true);
    expect(queries.some((q) => q.includes("biography wikipedia"))).toBe(true);
  });

  it("назначения, по которым идёт сбор, остались в плане", () => {
    const purposes = new Set(plan().map((q) => q.purpose));
    for (const p of ["subject_lookup", "media_lookup", "business_lookup", "adverse_lookup", "wikipedia_lookup"]) {
      expect(purposes.has(p as OrionQuerySpec["purpose"])).toBe(true);
    }
  });

  it("сбор поверхностей укладывается в бюджет платных вызовов", () => {
    // runRegionSurfaces тратит четыре вызова Serper на каждую такую строку
    // (organic + images + videos + autocomplete). Замер на этом же субъекте:
    // до шага 10 — 36 строк, 144 вызова; после — 18 строк, 72 вызова.
    // Бюджет ниже держит границу, не фиксируя точное число жёстко.
    const swept = plan().filter(
      (q) => q.purpose === "subject_lookup" || q.purpose === "media_lookup"
    );
    expect(swept.length).toBeLessThanOrEqual(20);
  });

  it("план остаётся детерминированным", () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });
});
