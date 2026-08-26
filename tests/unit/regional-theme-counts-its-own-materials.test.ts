/**
 * Счёт материалов темы на региональной странице сходится с её цитатами.
 *
 * Блок темы на региональной странице пересобирается из свидетельств этого
 * региона, а строка «Всего по теме: N материалов» переносилась из глобального
 * утверждения дословно. На стр. 52 отчёта Кремлёва так вышло «Всего по теме:
 * 2 материала» над одной цитатой: вторая опора темы — российская, и на странице
 * ОАЭ её нет.
 *
 * Там же — вторая половина той же находки: единственной цитатой темы
 * «Финансовые претензии / долговые споры» стал пост о партнёрстве, взятый со
 * страницы, которую прочитали и признали нейтральной. Защита от этого была, но
 * применялась только к темам не ниже среднего уровня. Причина защиты («тему
 * назначил словарь по заголовку, а страницу прочитали») от уровня риска не
 * зависит ни в чём.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

function scopedFor(region: string, evidenceIndex: Record<string, unknown>): ScopedFragmentInput {
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex,
    scope: { regions: [region] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function uaeScoped(evidenceIndex: Record<string, unknown>): ScopedFragmentInput {
  return scopedFor("UAE", evidenceIndex);
}

describe("строка счёта на региональной странице — региональная", () => {
  const FINDING = {
    findingId: "finding-criminal_legal-subject_match-count",
    theme: "Криминальные / судебные материалы",
    claim:
      "Найдены публикации по теме:\n" +
      "«Суд по иску о взыскании 72 млн рублей с предпринимателя» — источник dzen.ru\n" +
      "Всего по теме: 2 материала.",
    riskLevel: "high",
    regions: ["RU", "UAE"],
    evidenceRefs: ["ev-ru", "ev-uae"],
    sourceDomains: ["dzen.ru", "gulfnews.com"],
  } as unknown as Finding;

  it("на два региона по материалу — на странице ОАЭ «1 материал»", () => {
    const claim = localizedThemedClaim(
      FINDING,
      uaeScoped({
        "ev-ru": {
          title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
          domain: "dzen.ru",
          region: "RU",
        },
        "ev-uae": {
          title: "Court filings link the subject to a Dubai ownership dispute",
          domain: "gulfnews.com",
          region: "UAE",
        },
      })
    );
    expect(claim).toContain("Всего по теме: 1 материал, с негативным контекстом — 1.");
    expect(claim).not.toContain("2 материала");
  });

  it("одна страница, найденная двумя запросами, — один материал", () => {
    const twoObservations = {
      ...FINDING,
      evidenceRefs: ["ev-uae-q1", "ev-uae-q2"],
    } as unknown as Finding;
    const material = {
      title: "Court filings link the subject to a Dubai ownership dispute",
      domain: "gulfnews.com",
      region: "UAE",
    };
    const claim = localizedThemedClaim(
      twoObservations,
      uaeScoped({
        "ev-uae-q1": { ...material, url: "https://gulfnews.com/a?q=1" },
        "ev-uae-q2": { ...material, url: "https://gulfnews.com/a?q=2" },
      })
    );
    expect(claim).toContain("Всего по теме: 1 материал, с негативным контекстом — 1.");
  });

  it("два разных материала региона — «2 материала»", () => {
    // Проверка без этого случая не отличала бы «свёл по материалу» от «свёл
    // всё»: на счёте «1 материал» обе ошибки выглядят одинаково.
    const threeRefs = {
      ...FINDING,
      evidenceRefs: ["ev-ru", "ev-uae-1", "ev-uae-2"],
    } as unknown as Finding;
    const claim = localizedThemedClaim(
      threeRefs,
      uaeScoped({
        "ev-ru": {
          title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
          domain: "dzen.ru",
          region: "RU",
        },
        "ev-uae-1": {
          title: "Court filings link the subject to a Dubai ownership dispute",
          domain: "gulfnews.com",
          url: "https://gulfnews.com/a",
          region: "UAE",
        },
        "ev-uae-2": {
          title: "Arbitration over a Jebel Ali warehouse lease reaches the court",
          domain: "thenationalnews.ae",
          url: "https://thenationalnews.ae/b",
          region: "UAE",
        },
      })
    );
    expect(claim).toContain("Всего по теме: 2 материала, с негативным контекстом — 2.");
  });

  it("хвост негатива считает решение аналитика", () => {
    /*
     * Явное решение человека — первый источник того же предиката, которым
     * считается хвост «с негативным контекстом». Пока оно не доезжало до деки,
     * дашборд рисков печатал «— 1» по тому же корпусу, по которому
     * региональная страница печатала «3 материала» без хвоста.
     */
    const threeRefs = {
      ...FINDING,
      claim:
        "Найдены публикации по теме:\n" +
        "«Профиль основателя Nordkap Capital» — источник finansbladet.se\n" +
        "Всего по теме: 3 материала.",
      evidenceRefs: ["ev-uae-1", "ev-uae-2", "ev-uae-3"],
    } as unknown as Finding;
    const claim = localizedThemedClaim(
      threeRefs,
      uaeScoped({
        "ev-uae-1": {
          title: "Nordkap Capital opens a Dubai office",
          domain: "gulfnews.com",
          url: "https://gulfnews.com/a",
          region: "UAE",
          analystDecision: "ADVERSE",
        },
        "ev-uae-2": {
          title: "Business profile of the founder",
          domain: "finansbladet.se",
          url: "https://finansbladet.se/b",
          region: "UAE",
        },
        "ev-uae-3": {
          title: "Logistics contract signed in Jebel Ali",
          domain: "thenationalnews.ae",
          url: "https://thenationalnews.ae/c",
          region: "UAE",
        },
      })
    );
    expect(claim).toContain("Всего по теме: 3 материала, с негативным контекстом — 1.");
  });

  it("материал без региона не считается ни в одном регионе", () => {
    /*
     * Записи комплаенс-базы региона не имеют вовсе, и условие «регион чужой —
     * пропускаем» их пропускало в каждый регион: сумма региональных счётов
     * выходила больше глобального, а запись, ни к какому региону не
     * отнесённая, была подана клиенту как найденная здесь.
     */
    const withDatabaseHits = {
      ...FINDING,
      claim:
        "Найдены публикации по теме:\n" +
        "«Суд по иску о взыскании 72 млн рублей с предпринимателя» — источник dzen.ru\n" +
        "Всего по теме: 4 материала.",
      evidenceRefs: ["ev-ru", "ev-uae", "ev-dowjones", "ev-lexis"],
    } as unknown as Finding;
    const index = {
      "ev-ru": {
        title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
        domain: "dzen.ru",
        region: "RU",
      },
      "ev-uae": {
        title: "Court filings link the subject to a Dubai ownership dispute",
        domain: "gulfnews.com",
        region: "UAE",
      },
      "ev-dowjones": {
        kind: "compliance_hit",
        title: "Совпадение в базе Dow Jones",
        url: "https://profiles.example/dj/1",
      },
      "ev-lexis": {
        kind: "compliance_hit",
        title: "Совпадение в базе LexisNexis",
        url: "https://profiles.example/lexis/1",
      },
    };
    const ru = localizedThemedClaim(withDatabaseHits, scopedFor("RU", index));
    const uae = localizedThemedClaim(withDatabaseHits, uaeScoped(index));
    expect(ru).toContain("Всего по теме: 1 материал, с негативным контекстом — 1.");
    expect(uae).toContain("Всего по теме: 1 материал, с негативным контекстом — 1.");
    expect(ru).not.toContain("Совпадение в базе Dow Jones");
    expect(uae).not.toContain("Совпадение в базе LexisNexis");
  });
});

describe("соседние пункты одного раздела считают в одних единицах", () => {
  /**
   * Регион-эксклюзивная находка приносила строку счёта из глобального
   * утверждения как есть: на соседних листах одного раздела стояли «3
   * материала» и «4 материала, с негативным контекстом — 1» — разная
   * формулировка и разная единица (материал против наблюдения).
   */
  const INDEX = {
    "ev-ru-1": {
      title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
      domain: "dzen.ru",
      url: "https://dzen.ru/a",
      region: "RU",
    },
    "ev-ru-1-second-query": {
      title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
      domain: "dzen.ru",
      url: "https://dzen.ru/a",
      region: "RU",
    },
    "ev-ru-2": {
      title: "Компания субъекта открыла складской комплекс в Подмосковье",
      domain: "logistics.example",
      url: "https://logistics.example/b",
      region: "RU",
    },
    "ev-uae-1": {
      title: "Court filings link the subject to a Dubai ownership dispute",
      domain: "gulfnews.com",
      url: "https://gulfnews.com/c",
      region: "UAE",
    },
  };

  const EXCLUSIVE = {
    findingId: "finding-criminal_legal-subject_match-exclusive",
    theme: "Криминальные / судебные материалы",
    claim:
      "Найдены публикации по теме:\n" +
      "«Суд по иску о взыскании 72 млн рублей с предпринимателя» — источник dzen.ru\n" +
      "Всего по теме: 3 материала, с негативным контекстом — 2.",
    riskLevel: "high",
    regions: ["RU"],
    evidenceRefs: ["ev-ru-1", "ev-ru-1-second-query", "ev-ru-2"],
    sourceDomains: ["dzen.ru", "logistics.example"],
  } as unknown as Finding;

  const CROSS = {
    findingId: "finding-criminal_legal-subject_match-cross",
    theme: "Криминальные / судебные материалы",
    claim:
      "Найдены публикации по теме:\n" +
      "«Суд по иску о взыскании 72 млн рублей с предпринимателя» — источник dzen.ru\n" +
      "Всего по теме: 4 материала, с негативным контекстом — 2.",
    riskLevel: "high",
    regions: ["RU", "UAE"],
    evidenceRefs: ["ev-ru-1", "ev-ru-2", "ev-uae-1"],
    sourceDomains: ["dzen.ru", "gulfnews.com"],
  } as unknown as Finding;

  it("регион-эксклюзивный пункт пересчитывает счёт по материалам региона", () => {
    const claim = localizedThemedClaim(EXCLUSIVE, scopedFor("RU", INDEX));
    // Две ссылки одной страницы — один материал, и негативен он один.
    expect(claim).toContain("Всего по теме: 2 материала, с негативным контекстом — 1.");
    expect(claim).not.toContain("3 материала");
  });

  it("хвост негатива печатается на обоих путях одной формулировкой", () => {
    const exclusive = localizedThemedClaim(EXCLUSIVE, scopedFor("RU", INDEX));
    const cross = localizedThemedClaim(CROSS, scopedFor("RU", INDEX));
    const scaleOf = (claim: string): string =>
      claim.split("\n").find((l) => l.startsWith("Всего по теме:")) ?? "";
    expect(scaleOf(exclusive)).toBe("Всего по теме: 2 материала, с негативным контекстом — 1.");
    expect(scaleOf(cross)).toBe(scaleOf(exclusive));
  });

  it("негатив считается тем же предикатом, что и рамка строки", () => {
    // Чистый материал в негатив не попадает: у предиката один ответ на отчёт,
    // и «складской комплекс» ему не негатив.
    const onlyClean = {
      ...EXCLUSIVE,
      evidenceRefs: ["ev-ru-2"],
    } as unknown as Finding;
    const claim = localizedThemedClaim(onlyClean, scopedFor("RU", INDEX));
    expect(claim).toContain("Всего по теме: 1 материал.");
    expect(claim).not.toContain("негативным контекстом");
  });
});

describe("тема без пригодной цитаты в регионе печатает честную пустую ветку", () => {
  /** Находка стр. 52 дословно: российская опора темы и подборка Instagram. */
  const FINDING = {
    findingId: "finding-financial_claims-subject_match-f861cec8",
    theme: "Финансовые претензии / долговые споры",
    claim:
      "Найдены публикации по теме:\n" +
      "«Миллионы долгов Hardcore» — источник kulak.team\n" +
      "Всего по теме: 2 материала.",
    riskLevel: "low",
    regions: ["RU", "UAE"],
    evidenceRefs: ["ev-ru-kulak", "ev-uae-insta"],
    sourceDomains: ["kulak.team", "instagram.com"],
  } as unknown as Finding;

  const SCOPED = uaeScoped({
    "ev-ru-kulak": {
      title: "Миллионы долгов Hardcore",
      domain: "kulak.team",
      region: "RU",
    },
    "ev-uae-insta": {
      title: "Umar Kremlev (@umarkremlev) • Instagram photos and videos",
      domain: "instagram.com",
      region: "UAE",
      readVerdictTone: "neutral",
      verdictTheme: "Подборка популярных роликов Instagram об Умаре Кремлеве",
      pageQuote:
        "Umar Kremlev recently announced a historic partnership with Real American Freestyle.",
    },
  });

  it("нейтрально прочитанная страница не цитируется под темой низкого уровня", () => {
    const claim = localizedThemedClaim(FINDING, SCOPED);
    expect(claim).not.toContain("historic partnership");
  });

  it("цитата чужого региона на странице ОАЭ не всплывает вместо неё", () => {
    const claim = localizedThemedClaim(FINDING, SCOPED);
    expect(claim).not.toContain("Миллионы долгов");
    expect(claim).not.toContain("kulak.team");
  });

  it("площадка названа, счёт — региональный", () => {
    const claim = localizedThemedClaim(FINDING, SCOPED);
    expect(claim).toContain("По теме в источниках instagram.com");
    expect(claim).toContain("Всего по теме: 1 материал.");
    expect(claim).not.toContain("2 материала");
  });

  it("источники не названы — числа тоже нет", () => {
    /*
     * «По этой теме источники в данном регионе не выделены» и следом «Всего по
     * теме: 1 материал» — два спорящих предложения: опоры у числа нет, а
     * читатель ищет, где этот материал.
     */
    const noDomains = uaeScoped({
      "ev-ru-kulak": {
        title: "Миллионы долгов Hardcore",
        domain: "kulak.team",
        region: "RU",
      },
      "ev-uae-no-domain": {
        title: "Запись без адреса и площадки",
        region: "UAE",
        readVerdictTone: "neutral",
      },
    });
    const claim = localizedThemedClaim(
      { ...FINDING, theme: "Криминальные / судебные материалы" } as unknown as Finding,
      noDomains
    );
    expect(claim).toContain("По этой теме источники в данном регионе не выделены");
    expect(claim).not.toContain("Всего по теме");
  });
});
