import { describe, expect, it } from "vitest";
import { CLIENT_RISK_LABELS } from "@/modules/digital-profile/orion-golden/client/risk-scale";
import { resultView, scaleView, type ResultJson } from "@/modules/site/check/result-view";
import { formatBirthDate, formatCheckDate, formatDay, materialsText, themesInText } from "@/modules/site/check/format";

/**
 * Экран результата печатает только то, что отдала ручка, и не приписывает
 * материалам тем, о которых ручка не знает.
 *
 * `materialsFound` — различные негативные материалы; счёт темы — материалы темы.
 * Материал бывает в двух темах и без темы (решение владельца 15.09: негатив без
 * темы каталога — тоже «негатив найден»). Макет пишет «4 материала в 2 темах»;
 * это правда, только когда темы покрывают все материалы.
 */

const TZ = "Europe/Moscow";
const text = (parts: Array<{ text: string }>) => parts.map((p) => p.text).join("");
const strong = (parts: Array<{ text: string; strong?: boolean }>) => parts.filter((p) => p.strong).map((p) => p.text);

const result = (over: Partial<ResultJson>): ResultJson => ({
  verdict: "NEGATIVE_FOUND",
  riskLevel: "medium",
  materialsFound: 4,
  findingsTotal: 2,
  themes: [],
  partial: false,
  sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
  checkedAt: "2026-09-12T11:32:00.000Z",
  ...over,
});

const COURT = { id: "criminal_legal", label: "Суд и криминал", count: 3, level: "medium" as const };
const DEBTS = { id: "financial_claims", label: "Финансовые претензии и долги", count: 1, level: "low" as const };

describe("шкала — три ступени шкалы отчёта", () => {
  it("подписи — слова risk-scale.ts снизу вверх", () => {
    expect(scaleView("low").labels).toEqual([...CLIENT_RISK_LABELS].reverse());
    expect(scaleView("low").labels).toHaveLength(3);
  });

  it.each([
    ["low", 1, "Низкий", "Шкала риска: первый уровень из трёх"],
    ["medium", 2, "Средний", "Шкала риска: второй уровень из трёх"],
    ["high", 3, "Высокий", "Шкала риска: третий уровень из трёх"],
  ] as const)("%s — делений %i", (level, filled, word, aria) => {
    expect(scaleView(level)).toMatchObject({ tone: level, filled, word, ariaLabel: aria });
  });

  it("без уровня — пустая шкала, слова нет", () => {
    expect(scaleView(null)).toMatchObject({
      tone: "none",
      filled: 0,
      word: null,
      ariaLabel: "Шкала риска: уровень не определён",
    });
  });
});

describe("негатив найден", () => {
  it("темы покрывают все материалы — «N материалов в K темах», как в макете", () => {
    const view = resultView(result({ themes: [COURT, DEBTS] }), { timeZone: TZ });
    expect(text(view.summary)).toBe("Найдены материалы, которые могут нанести ущерб репутации: 4 материала в 2 темах.");
    expect(strong(view.summary)).toEqual(["4 материала", "2 темах"]);
    expect(view.title).toEqual({ word: "Средний", text: "уровень риска" });
    expect(view.groups).toEqual([
      { label: "Суд и криминал", countText: "3 материала", bars: 3 },
      { label: "Финансовые претензии и долги", countText: "1 материал", bars: 1 },
    ]);
    expect(view.ledger).toEqual([]);
  });

  it("часть материалов без темы — не пишет, что все они в темах", () => {
    const view = resultView(result({ materialsFound: 5, themes: [{ ...COURT, count: 2 }] }), { timeZone: TZ });
    expect(text(view.summary)).toBe(
      "Найдены материалы, которые могут нанести ущерб репутации: 5 материалов; темы определены не для всех."
    );
    expect(view.groups).toEqual([{ label: "Суд и криминал", countText: "2 материала", bars: 2 }]);
  });

  it("тем нет вовсе — число материалов без названия темы и одна группа плашек", () => {
    const view = resultView(result({ riskLevel: "low", materialsFound: 3, findingsTotal: 0, themes: [] }), {
      timeZone: TZ,
    });
    expect(view.verdict).toBe("NEGATIVE_FOUND");
    expect(text(view.summary)).toBe(
      "Найдены материалы, которые могут нанести ущерб репутации: 3 материала; тему для них определить не удалось."
    );
    expect(view.groups).toEqual([{ label: null, countText: "3 материала", bars: 3 }]);
    expect(view.title).toEqual({ word: "Низкий", text: "уровень риска" });
    expect(view.scale.filled).toBe(1);
  });

  it("плашек не больше восьми — число пишется словами полностью", () => {
    const view = resultView(result({ materialsFound: 12, themes: [{ ...COURT, count: 12 }] }), { timeZone: TZ });
    expect(view.groups[0]).toEqual({ label: "Суд и криминал", countText: "12 материалов", bars: 8 });
  });

  it("неполный сбор — заметка с тем, что проверено", () => {
    const view = resultView(
      result({ themes: [COURT, DEBTS], partial: true, sourcesChecked: ["search", "open_sources", "sanctions"] }),
      { timeZone: TZ }
    );
    expect(view.partialNote).toBe(
      "Часть источников не ответила. Проверены: поисковая выдача, открытые источники, санкционные и PEP-списки."
    );
  });
});

describe("чисто", () => {
  it("что проверено — четыре группы источников", () => {
    const view = resultView(result({ verdict: "CLEAN", riskLevel: "low", materialsFound: 0, findingsTotal: 0 }), {
      timeZone: TZ,
    });
    expect(text(view.summary)).toBe("Негативных материалов не найдено ни в одном из проверенных источников.");
    expect(view.title).toEqual({ word: "Низкий", text: "уровень риска" });
    expect(view.groups).toEqual([]);
    expect(view.partialNote).toBeNull();
    expect(view.ledger).toEqual([
      { name: "Поисковая выдача", value: "первые страницы", tone: "ok" },
      { name: "Картинки, видео и подсказки", value: null, tone: "ok" },
      { name: "Открытые источники", value: "энциклопедии, справочники, публичные профили", tone: "ok" },
      { name: "Санкционные и PEP-списки", value: "совпадений нет", tone: "ok" },
    ]);
  });

  it("не ответившая группа — «нет ответа», и заметка о неполном сборе", () => {
    const view = resultView(
      result({
        verdict: "CLEAN",
        riskLevel: "low",
        materialsFound: 0,
        partial: true,
        sourcesChecked: ["search", "open_sources", "sanctions"],
      }),
      { timeZone: TZ }
    );
    expect(view.ledger[1]).toEqual({ name: "Картинки, видео и подсказки", value: "нет ответа", tone: "warn" });
    expect(view.partialNote).toMatch(/^Часть источников не ответила\./u);
  });
});

describe("данных недостаточно", () => {
  it("поиск не ответил — так и сказано, шкала пустая", () => {
    const view = resultView(
      result({ verdict: "INSUFFICIENT_DATA", riskLevel: null, materialsFound: 0, sourcesChecked: ["open_sources", "sanctions"] }),
      { timeZone: TZ }
    );
    expect(view.title).toEqual({ word: null, text: "Уровень риска не определён" });
    expect(view.scale.tone).toBe("none");
    expect(text(view.summary)).toBe(
      "Недостаточно данных для заключения: не ответила поисковая выдача — основной источник проверки."
    );
    expect(view.ledger).toEqual([
      { name: "Поисковая выдача", value: "нет ответа — это основной источник проверки", tone: "warn" },
      { name: "Картинки, видео и подсказки", value: "нет ответа", tone: "warn" },
      { name: "Открытые источники", value: "ответ получен", tone: "ok" },
      { name: "Санкционные и PEP-списки", value: "ответ получен", tone: "ok" },
    ]);
    expect(view.partialNote).toBeNull();
  });

  it("поиск ответил, но без материалов — причина другая", () => {
    const view = resultView(
      result({ verdict: "INSUFFICIENT_DATA", riskLevel: null, materialsFound: 0, sourcesChecked: ["search", "surfaces"] }),
      { timeZone: TZ }
    );
    expect(text(view.summary)).toBe(
      "Недостаточно данных для заключения: поисковая выдача не вернула материалов по этому имени."
    );
  });
});

describe("слова и даты", () => {
  it("склонение числа материалов и тем", () => {
    expect([1, 2, 5, 11, 21, 22, 112].map(materialsText)).toEqual([
      "1 материал",
      "2 материала",
      "5 материалов",
      "11 материалов",
      "21 материал",
      "22 материала",
      "112 материалов",
    ]);
    expect([1, 2, 5, 11, 21].map(themesInText)).toEqual(["1 теме", "2 темах", "5 темах", "11 темах", "21 теме"]);
  });

  it("даты — по-русски, в часовом поясе посетителя", () => {
    expect(formatCheckDate("2026-09-12T11:32:00.000Z", TZ)).toBe("12 сентября 2026, 14:32");
    expect(formatDay("2026-10-12T11:32:00.000Z", TZ)).toBe("12 октября 2026");
    expect(formatBirthDate("1985-03-12")).toBe("12.03.1985");
    expect(resultView(result({ themes: [COURT, DEBTS] }), { timeZone: TZ }).checkedAtText).toBe(
      "Проверка от 12 сентября 2026, 14:32"
    );
  });
});
