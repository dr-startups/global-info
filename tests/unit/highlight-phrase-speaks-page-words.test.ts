/**
 * «Почему выделено» говорит словами прочитанной страницы.
 *
 * До шага под выделенным результатом печаталось перечисление «рубрика — домен;
 * уровень: высокий» — три служебных слова вместо ответа на вопрос «что там
 * написано». Данные для ответа уже куплены: у прочитанной страницы есть сюжет
 * одной фразой, дословная цитата, прошедшая аудитора, и адрес наблюдения.
 * Значит, фраза собирается из наблюдений и прослеживается до URL — модель на
 * сборке деки не участвует.
 *
 * Непрочитанная страница при этом не притворяется прочитанной: ни сюжета, ни
 * цитаты у неё нет, и фраза называет причину непрочтения словами.
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

const DICTIONARY_TITLE = "Криминальные / судебные материалы";

const row: VisibleAssetItem = {
  ref: "inventory:row-1",
  url: "https://rupep.org/ru/person/8095",
  domain: "rupep.org",
  title: "Сергей Глинка — RUPEP",
  adverse: true,
  themeTitle: DICTIONARY_TITLE,
};

function index(over: Partial<ScopedEvidenceIndex[string]> = {}): ScopedEvidenceIndex {
  return {
    "inventory:row-1": {
      url: "https://rupep.org/ru/person/8095",
      domain: "rupep.org",
      title: "Сергей Глинка — RUPEP",
      ...over,
    },
  };
}

describe("фраза «Почему выделено» у прочитанной страницы", () => {
  it("называет домен, сюжет, цитату и адрес — без рубрики и без слова «уровень»", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
      }),
    });

    expect(phrase.read).toBe(true);
    expect(phrase.sidebar).toContain("rupep.org");
    expect(phrase.sidebar).toContain("Санкции ЕС и заморозка активов");
    expect(phrase.sidebar).toContain("«Активы компании заморожены решением Совета ЕС.»");
    expect(phrase.sidebar).toContain("rupep.org/ru/person/8095");
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebar).not.toContain("уровень");
    expect(phrase.sidebar).not.toContain(DICTIONARY_TITLE);
  });

  it("оговаривает принадлежность, когда решение назвало её вероятной", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
        verdictSubjectMatch: "likely",
      }),
    });

    expect(phrase.full).toMatch(/[Пп]ринадлежность[^.]*требует подтверждения/u);
    expect(phrase.sidebar).toMatch(/[Пп]ринадлежность[^.]*требует подтверждения/u);
  });

  it("укорачивает цитату по границе предложения, но адрес сохраняет", () => {
    const long =
      "Первое предложение цитаты со страницы, довольно длинное и содержательное. " +
      "Второе предложение цитаты, тоже не короткое и с подробностями. " +
      "Третье предложение цитаты, добивающее объём до предела сайдбара.";
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: long,
        readVerdictTone: "adverse",
      }),
      budget: 240,
    });

    expect(phrase.sidebar.length).toBeLessThanOrEqual(240);
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebar).toContain("rupep.org/ru/person/8095");
    expect(phrase.sidebar).toContain("Первое предложение цитаты");
    expect(phrase.sidebar).not.toContain("Третье предложение цитаты");
    // Продолжение несёт цитату целиком: укорачивание — свойство сайдбара, а не
    // отчёта.
    expect(phrase.full).toContain("Третье предложение цитаты");
    expect(phrase.full).toContain("rupep.org/ru/person/8095");
  });

  it("цитата уступает адресу: неполная сайдбарная форма просит продолжения", () => {
    const oneLongSentence =
      "Одно очень длинное предложение цитаты со страницы, которое невозможно " +
      "укоротить по границе предложения, потому что граница у него ровно одна и " +
      "стоит она в самом конце этого предложения, занимая весь бюджет сайдбара";
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: oneLongSentence,
        readVerdictTone: "adverse",
      }),
      budget: 240,
    });

    // Без адреса утверждение нечем проверить, поэтому уступает цитата.
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebar).not.toContain("Одно очень длинное предложение");
    expect(phrase.sidebarComplete).toBe(false);
    expect(phrase.full).toContain(oneLongSentence);
    expect(phrase.full).toContain("rupep.org/ru/person/8095");
  });

  it("взводит признак «нужно продолжение», когда адрес в сайдбар не поместился", () => {
    const longPath = `https://rupep.org/ru/person/8095/${"otchet-o-proverke-".repeat(6)}itog`;
    const longTheme =
      "Санкции ЕС, заморозка активов и связанные с ними судебные разбирательства " +
      "в нескольких юрисдикциях одновременно";
    const phrase = highlightPhrase({
      row: { ...row, url: longPath },
      evidence: index({
        url: longPath,
        verdictTheme: longTheme,
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
      }),
      budget: 240,
    });

    expect(phrase.sidebarHasLink).toBe(false);
    expect(phrase.sidebarComplete).toBe(false);
    expect(phrase.link).toContain("rupep.org/ru/person/8095/otchet-o-proverke-");
    expect(phrase.full).toContain("rupep.org/ru/person/8095/otchet-o-proverke-");
  });
});

describe("фраза «Почему выделено» у непрочитанной страницы", () => {
  it("называет рубрику, домен и то, что страница не читалась", () => {
    const phrase = highlightPhrase({ row, evidence: index() });

    expect(phrase.read).toBe(false);
    expect(phrase.sidebar).toContain(DICTIONARY_TITLE);
    expect(phrase.sidebar).toContain("rupep.org");
    expect(phrase.sidebar).toContain("страница не читалась в этом прогоне");
    expect(phrase.sidebar).toContain("требует ручной проверки");
  });

  it("называет причину отказа клиентскими словами", () => {
    const phrase = highlightPhrase({ row, evidence: index({ readFailure: "blocked" }) });

    expect(phrase.read).toBe(false);
    expect(phrase.sidebar).toContain("доступ закрыт");
    expect(phrase.sidebar).not.toContain("blocked");
  });

  it("не сочиняет ни сюжета, ни цитаты у непрочитанной страницы", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({
        readFailure: "not_found",
        // Решение по непрочитанной странице темы не приносит; даже если тема
        // в артефакте осталась, печатать её как «что написано на странице»
        // нельзя — страницу не открывали.
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
      }),
    });

    expect(phrase.read).toBe(false);
    expect(phrase.sidebar).toContain("страница не найдена");
    expect(phrase.sidebar).not.toContain("Санкции ЕС и заморозка активов");
    expect(phrase.sidebar).not.toContain("«");
    expect(phrase.full).not.toContain("Активы компании заморожены");
  });
});

describe("фраза не называет того, чего клиенту называть нельзя", () => {
  const mockRow: VisibleAssetItem = {
    ...row,
    url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
    domain: "en.wikipedia-mock.example",
  };

  it("демо-домен не называется и в непрочитанной ветке, а фраза остаётся", () => {
    const phrase = highlightPhrase({
      row: mockRow,
      evidence: {
        "inventory:row-1": {
          url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
          domain: "en.wikipedia-mock.example",
        },
      },
    });

    expect(phrase.sidebar).toContain("Криминальные / судебные материалы");
    expect(phrase.sidebar).not.toContain("wikipedia-mock");
    expect(phrase.sidebar).not.toContain(".example");
    expect(phrase.sidebar).not.toContain("— —");
  });

  it("адрес без пригодного хоста не печатается, и прочерка вместо него нет", () => {
    const phrase = highlightPhrase({
      row: { ...row, url: "   " },
      evidence: index({
        url: "   ",
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
      }),
    });

    expect(phrase.link).toBeUndefined();
    expect(phrase.full).not.toContain("—.");
    expect(phrase.sidebarComplete).toBe(true);
  });

  it("кириллический адрес печатается читаемым, а не в punycode", () => {
    const phrase = highlightPhrase({
      row: { ...row, url: "https://xn--h1ajim.xn--p1ai/otchet", domain: "xn--h1ajim.xn--p1ai" },
      evidence: {
        "inventory:row-1": {
          url: "https://xn--h1ajim.xn--p1ai/otchet",
          domain: "xn--h1ajim.xn--p1ai",
          verdictTheme: "Санкции ЕС и заморозка активов",
          pageQuote: "Активы компании заморожены решением Совета ЕС.",
          readVerdictTone: "adverse",
        },
      },
    });

    expect(phrase.full).toContain("руни.рф/otchet");
    expect(phrase.full).not.toContain("xn--");
    expect(phrase.sidebar).not.toContain("xn--");
  });
});

describe("длинный адрес и цитата с многоточием", () => {
  it("адрес длиннее двухсот знаков не теряется, а уходит на продолжение", () => {
    const longUrl = `https://rupep.org/ru/person/8095/${"otchet-o-proverke-".repeat(14)}itog`;
    const phrase = highlightPhrase({
      row: { ...row, url: longUrl },
      evidence: index({
        url: longUrl,
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: "Активы компании заморожены решением Совета ЕС.",
        readVerdictTone: "adverse",
      }),
      budget: 240,
    });

    expect(phrase.link).toBeDefined();
    expect(phrase.full).toContain("itog");
    expect(phrase.sidebarHasLink).toBe(false);
    expect(phrase.sidebarComplete).toBe(false);
  });

  it("цитата с многоточием в сайдбар не идёт: панель многоточий не допускает", () => {
    const quote = "Совет ЕС постановил… активы заморожены полностью.";
    const phrase = highlightPhrase({
      row,
      evidence: index({
        verdictTheme: "Санкции ЕС и заморозка активов",
        pageQuote: quote,
        readVerdictTone: "adverse",
      }),
      budget: 240,
    });

    expect(phrase.sidebar).not.toContain("…");
    expect(phrase.sidebar).not.toContain("постановил");
    expect(phrase.sidebarComplete).toBe(false);
    expect(phrase.full).toContain(quote);
  });
});

describe("строка с находкой и строка без неё читаются по-разному", () => {
  const finding = { findingId: "f-1", theme: "Криминальные / судебные материалы" };

  it("отнесённая к находке строка говорит об этом, но уровня не называет", () => {
    const phrase = highlightPhrase({ row, evidence: index(), finding: finding as never });

    expect(phrase.sidebar).toContain("Криминальные / судебные материалы");
    expect(phrase.sidebar).toContain("находк");
    expect(phrase.sidebar).not.toContain("уровень");
    expect(phrase.sidebar).not.toContain("требует ручной проверки");
  });

  it("строка, не сопоставленная ни с чем, по-прежнему требует ручной проверки", () => {
    const phrase = highlightPhrase({ row, evidence: index() });

    expect(phrase.sidebar).toContain("требует ручной проверки");
    expect(phrase.sidebar).not.toContain("находк");
  });
});

describe("строка без называемого источника", () => {
  const nameless: VisibleAssetItem = {
    ref: "inventory:row-1",
    title: "Сергей Глинка — досье",
    adverse: true,
    themeTitle: "Криминальные / судебные материалы",
  };

  it("фраза есть, но источника не называет и адреса не печатает", () => {
    const phrase = highlightPhrase({
      row: nameless,
      evidence: { "inventory:row-1": { title: "Сергей Глинка — досье" } },
    });

    expect(phrase.sidebar).toContain("Криминальные / судебные материалы");
    expect(phrase.sidebar).not.toContain("—;");
    expect(phrase.sidebar).not.toContain("— —");
    expect(phrase.link).toBeUndefined();
  });

  it("демо-домен не называется, но объяснение строка получает", () => {
    const phrase = highlightPhrase({
      row: {
        ...nameless,
        url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
        domain: "en.wikipedia-mock.example",
      },
      evidence: {
        "inventory:row-1": {
          url: "https://en.wikipedia-mock.example/wiki/Sergey_Glinka",
          domain: "en.wikipedia-mock.example",
          verdictTheme: "Уголовное преследование и суды",
          pageQuote: "Против него возбуждено дело.",
          readVerdictTone: "adverse",
        },
      },
    });

    // Прочитанная ветка без имени источника: клиент видит сюжет и цитату, а
    // «На странице <домен>» уступает место безличному началу.
    expect(phrase.sidebar).toBe(
      "Выделенный результат — Уголовное преследование и суды: «Против него возбуждено дело.»"
    );
    expect(phrase.full).toBe(phrase.sidebar);
    expect(phrase.sidebar).not.toContain("wikipedia-mock");
    expect(phrase.sidebar).not.toContain(".example");
    expect(phrase.sidebar).not.toContain("— —");
    expect(phrase.link).toBeUndefined();
    expect(phrase.read).toBe(true);
  });

  it("оценка и материал — разные подлежащие, и точка с запятой их разделяет", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index(),
      finding: { findingId: "f-1", theme: "Криминальные / судебные материалы" } as never,
    });

    expect(phrase.sidebar).toContain("оценка по заголовку выдачи; материал учтён в находках отчёта.");
  });
});
