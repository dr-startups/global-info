import { describe, expect, it } from "vitest";
import { lightVerdict, type LightVerdictInput } from "@/modules/self-check/verdict";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  ALL_ANSWERED,
  BUSINESS,
  COURT_BANKRUPTCY,
  CRIMINAL,
  NEUTRAL,
  POLITICS,
  SCREENED,
  UNTHEMED_ADVERSE,
  complianceItem,
  observation,
  serpItems,
  wikipediaAbsentItem,
} from "../support/light-run-fixtures";

/**
 * Вердикт сайта отвечает на «негатив ли это» тем же ответом, что и отчёт.
 *
 * Решение владельца 15.09.2026. ТЗ 3.7 строило вердикт на сводке аудита, а та
 * ставит средний уровень каждому, у кого нет статьи в Википедии и есть хоть
 * одна находка — и отсутствие статьи само заводит находку. Почти каждый
 * посетитель получил бы «мы нашли материалы» при нуле материалов. Теперь
 * негатив строки — `resolveRowAdverse`, тема — каталог тем отчёта, уровень
 * темы — правило отчёта; сайт и отчёт по одному делу не расходятся.
 *
 * Материалы построены адаптерами подготовки отчёта, а не руками.
 */

function input(items: RawInventoryItem[], over: Partial<LightVerdictInput> = {}): LightVerdictInput {
  return { items, providers: ALL_ANSWERED, screenings: SCREENED, ...over };
}

function withStatus(providerId: string, status: string) {
  return ALL_ANSWERED.map((p) => (p.providerId === providerId ? { ...p, status } : p));
}

describe("данных недостаточно", () => {
  it("нет ни одного материала выдачи — ни уровня, ни тем", () => {
    expect(lightVerdict(input([wikipediaAbsentItem()]))).toMatchObject({
      verdict: "INSUFFICIENT_DATA",
      riskLevel: null,
      themes: [],
      materialsFound: 0,
      findingsTotal: 0,
    });
  });

  it("ни один поисковик не ответил — вывода нет, даже если что-то собрано", () => {
    const silent = ALL_ANSWERED.map((p) =>
      ["yandex", "google", "orion_profile"].includes(p.providerId) ? { ...p, status: "unavailable" } : p
    );
    expect(lightVerdict(input(serpItems(CRIMINAL), { providers: silent })).verdict).toBe("INSUFFICIENT_DATA");
  });

  it("заметки о возможностях провайдера — не материалы выдачи: вывода нет", () => {
    // Найдено приёмкой на стенде 15.09: агент поверхностей пишет заметки «что
    // умеет провайдер» без адреса, слияние пропускает их как наблюдения, и
    // «чисто» выходило при нуле настоящих материалов.
    const note = {
      key: "note|google|imageSearch",
      kind: "other" as const,
      title: "GOOGLE · imageSearch: NOT_SUPPORTED",
      providers: ["serper"],
      primaryProvider: "serper",
      evidenceRefs: ["searchSurfaceItem:ss-note-1"],
    };
    expect(lightVerdict(input(serpItems(note))).verdict).toBe("INSUFFICIENT_DATA");
  });

  it("демо-агент поисковика ответом о человеке не считается", () => {
    const demo = ALL_ANSWERED.map((p) => {
      if (p.providerId === "yandex" || p.providerId === "google") return { ...p, runtime: "mock" };
      if (p.providerId === "orion_profile") return { ...p, status: "unavailable" };
      return p;
    });
    expect(lightVerdict(input(serpItems(NEUTRAL), { providers: demo })).verdict).toBe("INSUFFICIENT_DATA");
  });

  it("ответил хотя бы один поисковик — вывод есть, но сбор частичный", () => {
    const out = lightVerdict(input(serpItems(NEUTRAL), { providers: withStatus("yandex", "unavailable") }));
    expect(out.verdict).toBe("CLEAN");
    expect(out.partial).toBe(true);
  });
});

describe("чисто", () => {
  it("нейтральная выдача и деловой профиль — чисто, низкий уровень, тем нет", () => {
    expect(lightVerdict(input(serpItems(NEUTRAL, BUSINESS)))).toMatchObject({
      verdict: "CLEAN",
      riskLevel: "low",
      themes: [],
      materialsFound: 0,
      findingsTotal: 0,
      partial: false,
      sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
      source: "light-verdict-v1",
    });
  });

  it("отсутствие статьи в Википедии негативом не является", () => {
    // Ровно здесь сводка аудита давала средний уровень всем подряд.
    expect(lightVerdict(input([...serpItems(NEUTRAL), wikipediaAbsentItem()])).verdict).toBe("CLEAN");
  });

  it("материал в теме, но без негатива — чисто: тема сама по себе не приговор", () => {
    // Добавлено после мутационной проверки: «каждый материал негативен» оставалась
    // зелёной — ни один случай «чисто» не держал материал в показываемой теме.
    const elected = observation("Иванов Иван Иванович избран депутатом городской думы", "https://tverigrad.ru/1");
    expect(lightVerdict(input(serpItems(elected)))).toMatchObject({ verdict: "CLEAN", themes: [] });
  });

  it("совпадение комплаенса без санкционного или PEP-типа риска вердикт не меняет", () => {
    const other = complianceItem({ riskTypes: ["OTHER"], profileUrl: null });
    expect(lightVerdict(input([...serpItems(NEUTRAL), other])).verdict).toBe("CLEAN");
  });

  it("запись комплаенса судится типом риска, а не площадкой реестра", () => {
    // Для строки выдачи площадка санкционного реестра — негатив сама по себе, но
    // совпадение по комплаенсу не подтверждается автоматически: без санкционного или
    // PEP-типа запись вердикта не меняет, даже если её адрес — на такой площадке.
    const other = complianceItem({ riskTypes: ["OTHER"] });
    expect(lightVerdict(input([...serpItems(NEUTRAL), other])).verdict).toBe("CLEAN");
  });
});

describe("негатив найден", () => {
  it("негативный материал без темы — тоже негатив, только без названия темы", () => {
    // Решение владельца после приёмки 15.09: строку, которую отчёт отмечает
    // негативной, сайт чистой не называет. Темы нет — уровень по правилу отчёта для
    // темы без базового уровня, низкий.
    expect(lightVerdict(input(serpItems(NEUTRAL, UNTHEMED_ADVERSE)))).toMatchObject({
      verdict: "NEGATIVE_FOUND",
      materialsFound: 1,
      findingsTotal: 0,
      themes: [],
      riskLevel: "low",
    });
  });

  it("негатив в деловом профиле — негатив, но тема «Деловой профиль» не показывается", () => {
    // Добавлено после мутационной проверки: фильтр темы без базового уровня ничем
    // не держался — негативного материала делового профиля в тестах не было.
    const detained = observation(
      "Предприниматель Иванов задержан по делу о мошенничестве",
      "https://ria.ru/20250314/ivanov.html"
    );
    const out = lightVerdict(input(serpItems(detained)));
    expect(out.verdict).toBe("NEGATIVE_FOUND");
    expect(out.themes.map((t) => t.id)).not.toContain("business_profile");
  });

  it("уголовное дело — тема «Суд и криминал» с уровнем отчёта", () => {
    expect(lightVerdict(input(serpItems(NEUTRAL, CRIMINAL)))).toMatchObject({
      verdict: "NEGATIVE_FOUND",
      materialsFound: 1,
      findingsTotal: 1,
      // Тема высокого базового уровня, где негативна больше чем половина
      // материалов, — «critical» по правилу отчёта; ступенью печати это «высокий».
      riskLevel: "critical",
      themes: [{ id: "criminal_legal", label: "Суд и криминал", count: 1, level: "critical" }],
    });
  });

  it("материал в двух темах считается одним материалом", () => {
    const out = lightVerdict(input(serpItems(COURT_BANKRUPTCY)));
    expect(out.verdict).toBe("NEGATIVE_FOUND");
    expect(out.materialsFound).toBe(1);
    expect(out.themes.map((t) => [t.id, t.label, t.count])).toEqual([
      ["criminal_legal", "Суд и криминал", 1],
      ["financial_claims", "Финансовые претензии и долги", 1],
    ]);
  });

  it("одна ссылка из двух запросов — один материал", () => {
    const again = observation(CRIMINAL.title!, CRIMINAL.url!, { query: "Иванов уголовное дело" });
    const out = lightVerdict(input(serpItems(CRIMINAL, again)));
    expect(out.materialsFound).toBe(1);
    expect(out.themes[0]).toMatchObject({ id: "criminal_legal", count: 1 });
  });

  it("описательная тема с негативом показывается: «Политика и публичность»", () => {
    const out = lightVerdict(input(serpItems(POLITICS)));
    expect(out.verdict).toBe("NEGATIVE_FOUND");
    expect(out.themes.map((t) => [t.id, t.label])).toEqual([["political_exposure", "Политика и публичность"]]);
  });

  it("запись в санкционном списке — тема «Санкционные и PEP-списки»", () => {
    const out = lightVerdict(input([...serpItems(NEUTRAL), complianceItem()]));
    expect(out.verdict).toBe("NEGATIVE_FOUND");
    expect(out.themes).toEqual([
      { id: "pep_rca_watchlist", label: "Санкционные и PEP-списки", count: 1, level: "medium" },
    ]);
  });

  it("темы идут от более высокого уровня к более низкому", () => {
    const out = lightVerdict(input(serpItems(POLITICS, CRIMINAL)));
    expect(out.themes.map((t) => t.id)).toEqual(["criminal_legal", "political_exposure"]);
    expect(out.riskLevel).toBe("critical");
  });
});

describe("полнота сбора и ответившие источники", () => {
  it("отказ провайдера делает сбор частичным, но группа остаётся, если ответил другой", () => {
    const out = lightVerdict(input(serpItems(NEUTRAL), { providers: withStatus("google", "failed") }));
    expect(out.partial).toBe(true);
    expect(out.sourcesChecked).toContain("search");
  });

  it("скрининг не выполнен — сбор частичный, санкционных списков среди проверенных нет", () => {
    const out = lightVerdict(
      input(serpItems(NEUTRAL), { screenings: [{ provider: "OPENSANCTIONS", status: "NOT_CONFIGURED" }] })
    );
    expect(out.partial).toBe(true);
    expect(out.sourcesChecked).not.toContain("sanctions");
  });

  it("поверхности не ответили — их нет среди проверенных", () => {
    const silent = ALL_ANSWERED.map((p) =>
      ["surfaces", "orion_google_surfaces"].includes(p.providerId) ? { ...p, status: "unavailable" } : p
    );
    expect(lightVerdict(input(serpItems(NEUTRAL), { providers: silent })).sourcesChecked).toEqual([
      "search",
      "open_sources",
      "sanctions",
    ]);
  });

  it("картинки, видео и подсказки проверены поиском поверхностей, а не заметками о возможностях", () => {
    // Агент `surfaces` в сеть не ходит — он записывает, что умеют провайдеры.
    // Его «завершился» не значит, что поверхности кто-то искал.
    const notesOnly = ALL_ANSWERED.map((p) =>
      p.providerId === "orion_google_surfaces" ? { ...p, status: "unavailable" } : p
    );
    expect(lightVerdict(input(serpItems(NEUTRAL), { providers: notesOnly })).sourcesChecked).not.toContain(
      "surfaces"
    );
  });

  it("не запланированный лёгким прогоном зарубежный контур неполнотой не считается", () => {
    const providers = [...ALL_ANSWERED, { providerId: "orion_uae_international", status: "skipped" }];
    expect(lightVerdict(input(serpItems(NEUTRAL), { providers })).partial).toBe(false);
  });
});
