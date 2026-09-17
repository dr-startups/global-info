/**
 * Строки блока доезжают до провода, и данные строки никто не переразбирает.
 *
 * Клиент читал отчёт сплошным текстом, хотя части блока построитель знал:
 * счётная фраза, источники, цитаты, оговорка. Гибли они в трёх местах, и все
 * три отвечали на один вопрос — «где у блока строки»:
 *
 *   1. построитель склеивал части пробелом, а заголовок приклеивал точкой;
 *   2. укладка (`packSentencesNoTruncate`) собирала куски через пробел;
 *   3. уже размеченный текст переразбирался регулярками. Сторож
 *      `structureThemeClaimText` «уже размеченное оставить» написан с `\b` после
 *      кириллицы, а в JavaScript `\b` определён на ASCII: после «Где видно»
 *      границы нет, и сторож не срабатывал **никогда** — утверждение
 *      синтезатора из пяти правильных строк выходило тремя, с «Где видно: …» и
 *      присказкой, приклеенными к цитате.
 *
 * Рендерер печатает строки по ролям (шаг 0096), поэтому строка, потерянная
 * здесь, — это заголовок, не ставший жирным, и цитата, утонувшая в абзаце.
 *
 * Субъект вымышленный.
 */

import { describe, expect, it } from "vitest";
import { composeBlockLines } from "@/modules/digital-profile/orion-golden/client/block-lines";
import { themeBlockText } from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { packSentencesNoTruncate } from "@/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import {
  highlightPhrase,
  reflowThemeBullet,
  structureThemeClaimText,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { normalizeQuoteMarks } from "@/modules/digital-profile/orion-golden/client/client-quote";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();

describe("один ответ на «как блок становится текстом»", () => {
  it("заголовок — своей строкой без конечной точки, части — строками", () => {
    expect(
      composeBlockLines("Следующие проверки.", ["1) Сверить первоисточники.", "", "  2) Сверить записи.  "])
    ).toBe("Следующие проверки\n1) Сверить первоисточники.\n2) Сверить записи.");
  });

  it("без заголовка блок — просто строки; пустые части не печатаются", () => {
    expect(composeBlockLines(undefined, ["Первая строка.", "", "Вторая строка."])).toBe(
      "Первая строка.\nВторая строка."
    );
  });

  it("знак внутри заголовка не трогается, снимается только конечная точка", () => {
    expect(composeBlockLines("Санкции, PEP, RCA и compliance-сигналы.", ["Тело."])).toBe(
      "Санкции, PEP, RCA и compliance-сигналы\nТело."
    );
    // Вопрос и многоточие — слова автора заголовка, а не наша точка.
    expect(composeBlockLines("Что дальше?", ["Тело."])).toBe("Что дальше?\nТело.");
  });

  it("склейка заголовка темы с телом — строкой, и без повтора заголовка", () => {
    expect(themeBlockText("Офшоры и финансовая прозрачность", "Найдены материалы.")).toBe(
      "Офшоры и финансовая прозрачность\nНайдены материалы."
    );
    expect(themeBlockText(undefined, "Найдены материалы.")).toBe("Найдены материалы.");
    expect(
      themeBlockText("Офшоры", "Офшоры упомянуты в двух материалах.")
    ).toBe("Офшоры упомянуты в двух материалах.");
  });
});

describe("укладка блока знает строки", () => {
  const BODY = [
    "По сюжету прочитано 5 публикаций, 4 из них нежелательные.",
    "Источники: affarsposten.example, pravo-obzor.example.",
    "«Основатель фонда стал фигурантом налогового расследования в Стокгольме» — источник (affarsposten.example/2026/fond/01).",
    "Процитирована 1 публикация сюжета из 5 прочитанных. Остальные названы в таблице тем.",
    "Сведения требуют проверки по первичным документам; наличие публикации не подтверждает изложенные обвинения.",
  ].join("\n");

  it("под бюджетом блок остаётся одним куском со всеми строками", () => {
    const chunks = packSentencesNoTruncate(BODY, 900, { keepLines: true });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.split("\n")).toHaveLength(5);
    // Два предложения одной строки остаются на одной строке.
    expect(chunks[0]).toContain("из 5 прочитанных. Остальные названы в таблице тем.");
  });

  it("над бюджетом куски режутся по строкам и предложениям, и ни знака не теряется", () => {
    const chunks = packSentencesNoTruncate(BODY, 260, { keepLines: true });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 260)).toBe(true);
    expect(flat(chunks.join(" "))).toBe(flat(BODY));
    // Строка не склеивается с соседней пробелом: граница строк внутри куска — `\n`.
    expect(chunks.some((c) => c.includes("\n"))).toBe(true);
    expect(chunks.join("\n")).not.toContain("нежелательные. Источники:");
  });

  it("без признака укладка абзаца прежняя — строки склеиваются пробелом", () => {
    // Абзац страницы переходит на строки шагом 3; до него его укладка не меняется.
    expect(packSentencesNoTruncate("Первое предложение.\nВторое предложение.", 900)).toEqual([
      "Первое предложение. Второе предложение.",
    ]);
  });
});

describe("данные строки никто не переразбирает", () => {
  /** Утверждение синтезатора золотого кейса — как оно лежит в `verified-finding-bundle.json`. */
  const SYNTHESIZED = [
    "Найдены публикации об офшорных структурах и юрисдикциях с особым режимом:",
    "«Фонд связан с мальтийским холдингом и офшорным бенефициарным владением» — источник (watch.example/fond-svyazan-s-maltijskim-holdingom-2)",
    "Всего по теме: 2 материала, с негативным контекстом — 2.",
    "Где видно: watch.example, reestr.example.",
    "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
  ];

  it("уже размеченное утверждение остаётся своими строками", () => {
    expect(structureThemeClaimText(SYNTHESIZED.join("\n")).split("\n")).toEqual(SYNTHESIZED);
  });

  /*
   * У сторожа две ветки — «есть мета-строка» и «есть строка-цитата», — и `\b`
   * после кириллицы стоял в обеих. Утверждение выше проходит через вторую, так
   * что первую держит только этот случай: размеченное утверждение без единой
   * цитаты (мутация, вернувшая `\b` в первую ветку, без него оставалась зелёной).
   */
  it("размеченное утверждение без цитат тоже остаётся своими строками", () => {
    const unquoted = [
      "По теме в источниках watch.example и reestr.example; отдельный заголовок с сутью риска в выдаче не выделен — сверить первоисточники.",
      "Всего по теме: 2 материала, с негативным контекстом — 2.",
      "Где видно: watch.example, reestr.example.",
      "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
    ];
    expect(structureThemeClaimText(unquoted.join("\n")).split("\n")).toEqual(unquoted);
  });

  // Вторая ветка сторожа — строка-цитата при отсутствии мета-строк: у региона
  // может не быть ни счёта, ни «Где видно», а цитата есть.
  it("утверждение из ввода, цитаты и присказки остаётся своими строками", () => {
    const quotedOnly = [
      "Найдены публикации по теме:",
      "«Фонд связан с мальтийским холдингом и офшорным владением» — источник watch-nyheter.se",
      "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
    ];
    expect(structureThemeClaimText(quotedOnly.join("\n")).split("\n")).toEqual(quotedOnly);
  });

  it("плоское утверждение по-прежнему раскладывается", () => {
    const structured = structureThemeClaimText(
      "«Деловой профиль» 43 свидетельства в источниках site.example. Источники: site.example. Примеры: Заголовок один · Заголовок два"
    );
    expect(structured.split("\n")[0]).toBe("«Деловой профиль»");
    expect(structured.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("блок из двух строк с цитатой остаётся двумя строками", () => {
    const block = [
      "«Фонд попал в список наблюдения» — kuriren.example",
      "Отнесено к теме «Сигналы списков» по заголовку «Фонд попал в список наблюдения при проверке» — источник kuriren.example.",
    ].join("\n");
    expect(reflowThemeBullet(block)).toBe(block);
  });

  it("строки блока построителя возвращаются как есть", () => {
    const block = ["«Офшорные структуры»", ...SYNTHESIZED].join("\n");
    expect(reflowThemeBullet(block)).toBe(block);
  });

  it("мета, приклеенная к цитате, раскладывается на свои строки", () => {
    const glued = [
      "«Офшорные структуры»",
      "Найдены публикации об офшорных структурах:",
      "«Фонд связан с мальтийским холдингом» — источник (watch.example/fond-2) Где видно: watch.example, reestr.example.",
      "Всего по теме: 2 материала, с негативным контекстом — 2.",
    ].join("\n");
    const lines = reflowThemeBullet(glued).split("\n");
    expect(lines).toContain("Где видно: watch.example, reestr.example.");
    expect(lines.some((l) => l.startsWith("«Фонд связан") && l.includes("Где видно"))).toBe(false);
    // Слова те же: переразбор ничего не теряет.
    expect(flat(lines.join(" "))).toBe(flat(glued));
  });
});

describe("лист «почему выделено» получает фразу строками", () => {
  const READ_ROW: VisibleAssetItem = {
    ref: "inventory:read-row",
    url: "https://istina-vestnik.ru/news/obraschenie-k-predsedatelyu.html",
    domain: "istina-vestnik.ru",
    title: "Обращение к председателю суда",
    adverse: true,
    themeTitle: "Судебные материалы",
  };
  const UNREAD_ROW: VisibleAssetItem = {
    ref: "inventory:unread-row",
    url: "https://kuriren-nyheter.se/fond-popal-v-spisok-1",
    domain: "kuriren-nyheter.se",
    title: "Фонд попал в список наблюдения",
    adverse: true,
    themeTitle: "Сигналы списков наблюдения",
  };
  const EVIDENCE = {
    "inventory:read-row": {
      url: READ_ROW.url,
      domain: "istina-vestnik.ru",
      title: READ_ROW.title,
      verdictTheme: "Обвинения председателя суда в коррупции",
      pageQuote: "Председатель суда мог получить взятку от участника спора.",
    },
    "inventory:unread-row": {
      url: UNREAD_ROW.url,
      domain: "kuriren-nyheter.se",
      title: UNREAD_ROW.title,
    },
  } as unknown as ScopedEvidenceIndex;

  it("прочитанная страница: заголовок и цитата с источником — своими строками", () => {
    const phrase = highlightPhrase({ row: READ_ROW, evidence: EVIDENCE });
    // Цитата печатается в едином формате деки (`sourceQuote`): с источником на
    // той же строке. Адрес отдельной строкой оставил бы строку-цитату без
    // атрибуции, а такую снимает сеть на границе паков (шаг 0092).
    expect(phrase.block.split("\n")).toEqual([
      "На странице istina-vestnik.ru — Обвинения председателя суда в коррупции",
      "«Председатель суда мог получить взятку от участника спора.» — источник (istina-vestnik.ru/news/obraschenie-k-predsedatelyu.html).",
    ]);
  });

  /*
   * Сеть на границе паков снимает строку-цитату без источника вместе с
   * обещанием над ней («цитата без источника не печатается», шаг 0092). На
   * золотом кейсе и эталоне-72 прочитанных страниц нет — чтение ссылок там
   * выключено, — поэтому потерю цитаты листа «почему выделено» не показал бы
   * ни один эталон: она случилась бы только в бою.
   */
  it("сеть на границе паков не снимает с блока ни строки", () => {
    for (const row of [READ_ROW, UNREAD_ROW]) {
      const block = highlightPhrase({ row, evidence: EVIDENCE }).block;
      expect(normalizeQuoteMarks(block)).toBe(block);
    }
  });

  it("непрочитанная страница: материал и источник — заголовком, основание — предложением", () => {
    const phrase = highlightPhrase({ row: UNREAD_ROW, evidence: EVIDENCE });
    const lines = phrase.block.split("\n");
    expect(lines[0]).toBe("«Фонд попал в список наблюдения» — kuriren-nyheter.se");
    expect(lines[1]).toMatch(/^Отнесено к теме «Сигналы списков наблюдения» по заголовку и описанию в выдаче; /u);
    expect(lines[1]!.endsWith(".")).toBe(true);
    expect(lines[2]).toBe("(kuriren-nyheter.se/fond-popal-v-spisok-1).");
  });

  it("плоская форма и признак полноты панели не меняются", () => {
    const read = highlightPhrase({ row: READ_ROW, evidence: EVIDENCE });
    expect(read.full).toBe(
      "На странице istina-vestnik.ru — Обвинения председателя суда в коррупции: «Председатель суда мог получить взятку от участника спора.» (istina-vestnik.ru/news/obraschenie-k-predsedatelyu.html)."
    );
    expect(read.full).not.toContain("\n");
    expect(read.sidebarComplete).toBe(read.sidebar === read.full);
    // Строчная форма несёт те же слова, что и плоская: заголовок, цитату, адрес.
    for (const part of [
      "На странице istina-vestnik.ru — Обвинения председателя суда в коррупции",
      "«Председатель суда мог получить взятку от участника спора.»",
      "(istina-vestnik.ru/news/obraschenie-k-predsedatelyu.html)",
    ]) {
      expect(read.full).toContain(part);
      expect(flat(read.block)).toContain(part);
    }
  });
});
