import { describe, expect, it } from "vitest";
import { dialView, sourcesAnswered, themeRows, type ResultJson } from "@/modules/site/check/result-view";
import { personaTrailRows, PERSONA_SOURCE_ROWS } from "@/modules/site/check/persona-view";
import type { PersonaCardJson, PersonaSourceJson } from "@/modules/site/check/types";
import { nextStepsFor, thanksProgress } from "@/modules/site/check/next-view";
import { STAGE_TAGS, waitingView } from "@/modules/site/check/waiting-view";
import type { PublicStatusJson } from "@/modules/site/check/types";

/**
 * Проекции экранов мастера по макету раунда 4 (артефакт RVD7Zd8dXFQ2WzPxdkCQXM).
 *
 * Разметку эти тесты не проверяют — vitest проекта не собирает TSX. Они держат
 * то, что можно посчитать: куда смотрит стрелка показания, что написано в следе
 * поиска, какой длины полоса темы и сколько источников ответило.
 */

const result = (over: Partial<ResultJson>): ResultJson => ({
  verdict: "NEGATIVE_FOUND",
  riskLevel: "medium",
  materialsFound: 7,
  findingsTotal: 3,
  themes: [],
  partial: false,
  sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
  checkedAt: "2026-09-12T11:32:00.000Z",
  ...over,
});

const COURT = { id: "criminal_legal", label: "Суд и криминал", count: 4, level: "high" as const };
const DEBTS = { id: "financial_claims", label: "Финансовые претензии и долги", count: 2, level: "medium" as const };
const POLITICS = { id: "political_exposure", label: "Политика и публичность", count: 1, level: "low" as const };

describe("показание дугой", () => {
  it.each([
    ["low" as const, 1, 28.67],
    ["medium" as const, 2, 90],
    ["high" as const, 3, 151.33],
  ])("%s — горит дуг %i, стрелка на %f°", (riskLevel, filled, angle) => {
    const view = dialView(result({ riskLevel }));
    expect(view.filled).toBe(filled);
    expect(view.pointerAngle).toBeCloseTo(angle, 2);
    expect(view.levelIndex).toBe(filled - 1);
    expect(view.tone).toBe(riskLevel);
  });

  it("число материалов — внутри дуги, со склонением", () => {
    expect(dialView(result({ materialsFound: 7 }))).toMatchObject({ num: "7", unit: "материалов" });
    expect(dialView(result({ materialsFound: 1 }))).toMatchObject({ num: "1", unit: "материал" });
    expect(dialView(result({ materialsFound: 2 }))).toMatchObject({ num: "2", unit: "материала" });
  });

  it("чисто — ноль материалов и первая дуга", () => {
    const view = dialView(result({ verdict: "CLEAN", riskLevel: "low", materialsFound: 0, findingsTotal: 0 }));
    expect(view).toMatchObject({ num: "0", unit: "материалов", filled: 1 });
    expect(view.ariaLabel).toBe("Шкала риска: первый уровень из трёх. Негативных материалов не найдено");
  });

  it("данных недостаточно — дуги не горят, стрелки нет, вместо числа прочерк", () => {
    const view = dialView(result({ verdict: "INSUFFICIENT_DATA", riskLevel: null, materialsFound: 0 }));
    expect(view).toMatchObject({
      tone: "none",
      filled: 0,
      pointerAngle: null,
      num: "—",
      unit: "нет данных",
      levelIndex: -1,
      ariaLabel: "Шкала риска: уровень не определён",
    });
  });

  it("найдено — сколько материалов, сказано и в подписи для диктора", () => {
    expect(dialView(result({ riskLevel: "medium", materialsFound: 7 })).ariaLabel).toBe(
      "Шкала риска: второй уровень из трёх. Найдено 7 материалов"
    );
  });

  it("подписи ступеней — те же три слова, что у шкалы отчёта", () => {
    expect(dialView(result({})).labels).toEqual(["Низкий", "Средний", "Высокий"]);
  });
});

describe("темы раскрывающимися строками", () => {
  it("уровень словами, полоса — по числу материалов самой большой темы", () => {
    const rows = themeRows(result({ themes: [COURT, DEBTS, POLITICS] }));
    expect(rows).toMatchObject([
      { label: "Суд и криминал", levelText: "высокий уровень", tone: "high", countText: "4 материала", fraction: 1 },
      { label: "Финансовые претензии и долги", levelText: "средний уровень", tone: "medium", countText: "2 материала", fraction: 0.5 },
      { label: "Политика и публичность", levelText: "низкий уровень", tone: "low", countText: "1 материал", fraction: 0.25 },
    ]);
  });

  it("в теме столько скрытых заголовков, сколько материалов, и все они разные фразы", () => {
    const [court] = themeRows(result({ themes: [COURT] }));
    expect(court!.hidden).toHaveLength(4);
    expect(new Set(court!.hidden).size).toBe(4);
    expect(court!.hidden.every((line) => line.length > 0)).toBe(true);
  });

  it("строк не больше восьми — число материалов остаётся полным", () => {
    const [row] = themeRows(result({ materialsFound: 12, themes: [{ ...COURT, count: 12 }] }));
    expect(row!.hidden).toHaveLength(8);
    expect(row!.countText).toBe("12 материалов");
  });

  it("негатив без темы каталога — одна строка без выдуманного названия", () => {
    const rows = themeRows(result({ materialsFound: 3, findingsTotal: 0, themes: [] }));
    expect(rows).toMatchObject([{ label: "Материалы без темы", levelText: null, countText: "3 материала", fraction: 1 }]);
  });

  it("чисто и «данных недостаточно» тем не показывают", () => {
    expect(themeRows(result({ verdict: "CLEAN", riskLevel: "low", materialsFound: 0, themes: [] }))).toEqual([]);
    expect(themeRows(result({ verdict: "INSUFFICIENT_DATA", riskLevel: null, materialsFound: 0 }))).toEqual([]);
  });
});

describe("сколько источников ответило", () => {
  it("все четыре — ход доски полный", () => {
    expect(sourcesAnswered(["search", "surfaces", "open_sources", "sanctions"])).toEqual({
      answered: 4,
      total: 4,
      fraction: 1,
    });
  });

  it("половина — половина хода; чужие имена не считаются", () => {
    expect(sourcesAnswered(["open_sources", "sanctions", "unknown_group"])).toEqual({
      answered: 2,
      total: 4,
      fraction: 0.5,
    });
  });

  it("никто — ход пустой", () => {
    expect(sourcesAnswered([])).toEqual({ answered: 0, total: 4, fraction: 0 });
  });
});

describe("след поиска: где искали совпадения", () => {
  const card = (over: Partial<PersonaCardJson>): PersonaCardJson => ({
    cardId: "card-1",
    source: "wikipedia",
    title: "Проверкин, Тест Этапович",
    description: null,
    imageUrl: null,
    url: null,
    birthDates: [],
    birthDateMatches: false,
    ...over,
  });
  const sources = (...list: Array<[PersonaSourceJson["source"], PersonaSourceJson["status"]]>): PersonaSourceJson[] =>
    list.map(([source, status]) => ({ source, status }));

  it("ответил и дал карточки — число совпадений на чернилах", () => {
    const rows = personaTrailRows(sources(["wikipedia", "ok"]), [card({}), card({ cardId: "card-2" })]);
    expect(rows).toEqual([
      { source: "wikipedia", name: "Открытые источники", state: "ответ получен", mark: "2", tone: "hit" },
    ]);
  });

  it("ответил без совпадений — ноль, и это не тревога", () => {
    expect(personaTrailRows(sources(["knowledge_graph", "ok"]), [])).toEqual([
      { source: "knowledge_graph", name: "Панель знаний Google", state: "совпадений нет", mark: "0", tone: "none" },
    ]);
  });

  it("не ответил вовремя — восклицательный знак и те же слова, что в панели", () => {
    expect(personaTrailRows(sources(["opensanctions", "timeout"]), [])).toEqual([
      {
        source: "opensanctions",
        name: "Санкционные списки",
        state: "ответ не пришёл вовремя — проверка всё равно продолжится",
        mark: "!",
        tone: "warn",
      },
    ]);
  });

  it("источник не подключён — прочерк, а не ноль: ноль значил бы «искали и не нашли»", () => {
    expect(personaTrailRows(sources(["knowledge_graph", "not_configured"]), [])).toEqual([
      {
        source: "knowledge_graph",
        name: "Панель знаний Google",
        state: "не подключена в этой проверке",
        mark: "—",
        tone: "off",
      },
    ]);
  });

  it("порядок источников постоянный, как в макете", () => {
    const rows = personaTrailRows(sources(["opensanctions", "ok"], ["knowledge_graph", "ok"], ["wikipedia", "ok"]), []);
    expect(rows.map((row) => row.source)).toEqual(["wikipedia", "knowledge_graph", "opensanctions"]);
  });

  it("панель поиска знает те же три источника — их видно до первого ответа", () => {
    expect(PERSONA_SOURCE_ROWS).toEqual([
      { source: "wikipedia", name: "Открытые источники" },
      { source: "knowledge_graph", name: "Панель знаний Google" },
      { source: "opensanctions", name: "Санкционные списки" },
    ]);
  });
});

describe("ожидание: что входит в стадию", () => {
  it("состав стадии — ярлыками, а не одной строкой", () => {
    expect(STAGE_TAGS.collecting).toEqual([
      "Первые страницы выдачи",
      "Картинки, видео и подсказки",
      "Энциклопедии и справочники",
      "Санкционные и PEP-списки",
    ]);
    expect(STAGE_TAGS.verdict).toEqual(["Темы находок", "Уровень риска"]);
  });

  it("стадия несёт свои ярлыки", () => {
    const view = waitingView(
      { stage: "collecting", stageLabel: "Сбор", progress: 0.42, nextPollMs: 7000, startedAt: null },
      Date.now()
    );
    expect(view.stages[0]!.tags).toEqual(STAGE_TAGS.collecting);
    expect(view.percent).toBe(42);
  });
});

describe("спасибо: ход заявки", () => {
  const status = (over: Partial<PublicStatusJson>): PublicStatusJson => ({
    publicId: "abc",
    status: "DONE",
    createdAt: "2026-09-12T11:00:00.000Z",
    expiresAt: "2026-10-12T11:00:00.000Z",
    subject: { fullName: "Проверкин Тест Этапович", birthDate: "1985-03-12" },
    persona: { decided: true, cardsCount: 0 },
    run: null,
    result: null,
    lead: { submitted: true, at: "2026-09-12T11:40:00.000Z" },
    blocked: null,
    ...over,
  });

  it("принятая заявка — первый шаг из всех, что обещаны", () => {
    const steps = nextStepsFor(status({ result: { ...result({}), themes: [COURT] } }));
    expect(thanksProgress(steps)).toEqual({ step: 1, total: steps.length + 1, fraction: 1 / (steps.length + 1) });
  });

  it("прервавшаяся проверка обещает ручную — шагов столько же, сколько строк списка", () => {
    const steps = nextStepsFor(status({ status: "FAILED", result: null }));
    expect(steps).toHaveLength(3);
    expect(thanksProgress(steps)).toEqual({ step: 1, total: 4, fraction: 0.25 });
  });
});
