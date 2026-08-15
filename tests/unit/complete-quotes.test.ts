/**
 * В отчёте нет оборванных фраз.
 *
 * Поисковик режет длинный заголовок по своей ширине и ставит многоточие.
 * `cleanExampleTitle` это многоточие снимало, и обрывок начинал выглядеть
 * законченной цитатой. В отчёте 72 так появились (дословно):
 *
 *   «Ирина Винер и Алишер Усманов: первая встреча, разлука длиною»
 *   «Алишер Усманов: биография предпринимателя, бизнес, личная»
 *   «Sanctioning an Oligarch Is Not So Easy: Why the Money»
 *   «Homeless. Alisher Usmanov lost his mansion in Germany due»
 *
 * Длиною во сколько, что личная, why the money, due to what — читателю не
 * узнать. Многоточие такую фразу не спасает: в отчёте его быть не должно,
 * фразы обязаны быть целыми. Значит, обрезанный заголовок не цитируется вовсе,
 * а вместо него берётся цитата с прочитанной страницы — целое предложение,
 * сверенное аудитором с текстом дословно.
 */

import { describe, expect, it } from "vitest";
import { pageQuoteForClient } from "@/modules/digital-profile/orion-golden/analytics/client-quote-hygiene";
import {
  endsWithSentence,
  quoteForClaim,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

/** Заголовки прогона 72 — ровно так их отдал поисковик. */
const TRUNCATED = [
  "Ирина Винер и Алишер Усманов: первая встреча, разлука длиною...",
  "Алишер Усманов: биография предпринимателя, бизнес, личная...",
  "Sanctioning an Oligarch Is Not So Easy: Why the Money ...",
  "Homeless. Alisher Usmanov lost his mansion in Germany due ...",
  "Усманов Алишер Бурханович биография, возраст, состояние…",
];

describe("обрезанный поисковиком заголовок не цитируется", () => {
  it("ни один из обрывков прогона не проходит в цитату", () => {
    for (const raw of TRUNCATED) {
      expect(quoteForClaim(raw, 220), raw).toBe("");
    }
  });

  it("целый заголовок цитируется как был", () => {
    const whole = "Treasury Sanctions Russians Bankrolling Putin and Russia";
    expect(quoteForClaim(whole, 220)).toBe(whole);
  });

  it("обрезанный заголовок с законченным предложением внутри сохраняет его", () => {
    // «Полное предложение. Обрывок...» → остаётся первое предложение.
    const raw = "Усманов признан виновным в мошенничестве. Позже дело было...";
    expect(quoteForClaim(raw, 220)).toBe("Усманов признан виновным в мошенничестве.");
  });
});

describe("цитата со страницы", () => {
  it("целое предложение проходит", () => {
    const q =
      "Официально Усманов был реабилитирован в 2000 году Верховным судом Узбекистана, признавшим дело сфабрикованным";
    expect(pageQuoteForClient(q)).toBe(q);
  });

  it("выгрузка таблицы не цитируется", () => {
    // Табличная страница отдаёт набор ярлыков и чисел, а не фразу.
    expect(pageQuoteForClient("События Участие в организациях 26 События ИП 2 Санкции 83")).toBe("");
  });

  it("короткий обрывок не цитируется", () => {
    expect(pageQuoteForClient("Санкции ЕС")).toBe("");
    expect(pageQuoteForClient("Criminal charges Fraud, embezzlement (1980, vacated 2000)")).toBe("");
  });

  it("висящий предлог в конце не пропускается", () => {
    expect(
      pageQuoteForClient("Расследование в отношении бизнесмена было прекращено судом в связи с")
    ).toBe("");
  });

  it("относительное слово в хвосте — признак незаконченной фразы", () => {
    expect(
      pageQuoteForClient("Усманов был арестован и осуждён по обвинению в хищении, которое")
    ).toBe("");
  });

  it("законченный оборот без точки проходит: точку требовать нельзя", () => {
    const q =
      "Alisher Usmanov is closely tied to Russian President Vladimir Putin, with whom he is alleged to have financial ties";
    expect(pageQuoteForClient(q)).toBe(q);
  });
});

describe("блок темы берёт цитату со страницы, а не заголовок", () => {
  const FINDING = {
    findingId: "finding-criminal_legal-subject_match-test",
    theme: "Криминальные / судебные материалы",
    claim:
      "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:\nВсего по теме: 2 материала.",
    riskLevel: "high",
    regions: ["RU", "UAE"],
    evidenceRefs: ["inventory:read", "inventory:unread"],
    sourceDomains: ["ru.wikipedia.org", "lisa.ru"],
  } as unknown as Finding;

  function scoped(withPageQuote: boolean): ScopedFragmentInput {
    return {
      findings: [FINDING],
      surfaceUnits: [],
      evidenceIndex: {
        "inventory:read": {
          title: "Ирина Винер и Алишер Усманов: первая встреча, разлука длиною...",
          domain: "ru.wikipedia.org",
          region: "RU",
          readVerdictTone: "adverse",
          ...(withPageQuote
            ? {
                pageQuote:
                  "Официально Усманов был реабилитирован в 2000 году Верховным судом Узбекистана, признавшим дело сфабрикованным",
              }
            : {}),
        },
        "inventory:unread": {
          title: "Алишер Усманов: биография предпринимателя, бизнес, личная...",
          domain: "lisa.ru",
          region: "RU",
        },
      },
      scope: { regions: ["RU"] },
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
  }

  it("цитата со страницы вытесняет обрезанный заголовок", () => {
    const claim = localizedThemedClaim(FINDING, scoped(true));
    expect(claim).toContain("реабилитирован в 2000 году Верховным судом Узбекистана");
    expect(claim).not.toContain("разлука длиною");
    expect(claim).not.toContain("бизнес, личная");
  });

  it("без прочитанной страницы обрывки просто не печатаются", () => {
    const claim = localizedThemedClaim(FINDING, scoped(false));
    expect(claim).not.toContain("разлука длиною");
    expect(claim).not.toContain("бизнес, личная");
    // Блок остаётся содержательным: тема, рамка и счётчики на месте.
    expect(claim).toContain("Криминальные / судебные материалы");
  });

  it("многоточия в блоке не остаётся", () => {
    for (const withQuote of [true, false]) {
      const claim = localizedThemedClaim(FINDING, scoped(withQuote));
      expect(claim).not.toMatch(/…|\.\.\./u);
    }
  });
});

describe("точка не всегда конец предложения", () => {
  /**
   * Восстановление обрезанного заголовка искало последнюю точку и брало всё до
   * неё. Точка внутри числа и в инициале давала «Благотворительный Фонд А.» и
   * «Alisher Usmanov is worth is an estimated $18.» — обрывки, ради устранения
   * которых восстановление и делалось.
   */
  it("десятичный разделитель концом не считается", () => {
    expect(endsWithSentence("Alisher Usmanov is worth an estimated $18.")).toBe(false);
    expect(endsWithSentence("The owner turned $100M into $1.")).toBe(false);
  });

  it("инициал концом не считается", () => {
    expect(endsWithSentence("Благотворительный Фонд А.")).toBe(false);
    expect(endsWithSentence("Kevin J.")).toBe(false);
  });

  it("настоящий конец предложения признаётся", () => {
    expect(endsWithSentence("Dilbar is owned by famous Russian oligarch Alisher Usmanov.")).toBe(true);
    expect(endsWithSentence("Чего мы не знаем об Алишере Усманове?")).toBe(true);
    expect(endsWithSentence("The biggest yacht on the planet!")).toBe(true);
  });

  it("обрезанный заголовок с ложной точкой в цитату не проходит", () => {
    expect(quoteForClaim("Благотворительный Фонд А.Усманова: ИНН 7729418938, ОГРН...", 220)).toBe("");
    expect(
      quoteForClaim("Alisher Usmanov is worth is an estimated $18.4 billion and the EU ...", 220)
    ).toBe("");
  });

  it("целое предложение с числом внутри сохраняется", () => {
    expect(
      quoteForClaim("The owner turned $100M into $1.4B in four years. This is “ ...", 220)
    ).toBe("The owner turned $100M into $1.4B in four years.");
  });
});

describe("цитата со страницы сильнее любого заголовка", () => {
  /**
   * Прогон 73: блоки тем напечатали 7 цитат со страниц и 18 заголовков, и
   * заголовки оказались негодные — «Leonid Mikhelson - OpenSanctions», «Л
   * михельсон, кто его жена?». У двадцати одной такой ссылки годная цитата со
   * страницы была: вес 6 против «до 10» у заголовка с попаданием в ключевые
   * слова темы означал, что заголовок обгоняет проверенное предложение.
   */
  const FINDING = {
    findingId: "finding-pep_rca_watchlist-subject_match-test",
    theme: "PEP / RCA / watchlist-сигналы",
    claim:
      "Найдены материалы, связывающие субъекта с санкционными и мониторинговыми списками (PEP/RCA):\nВсего по теме: 2 материала.",
    riskLevel: "high",
    regions: ["RU", "UAE"],
    evidenceRefs: ["inventory:keyword-title", "inventory:page-quote"],
    sourceDomains: ["opensanctions.org", "fr.wikipedia.org"],
  } as unknown as Finding;

  const scoped = {
    findings: [FINDING],
    surfaceUnits: [],
    evidenceIndex: {
      // Заголовок бьёт прямо в ключевые слова темы, но ничего не утверждает.
      "inventory:keyword-title": {
        title: "Leonid Mikhelson - Sanctions record - OpenSanctions",
        domain: "opensanctions.org",
        region: "RU",
      },
      // Страница прочитана, предложение целое и по делу.
      "inventory:page-quote": {
        title: "Leonid Mikhelson",
        domain: "fr.wikipedia.org",
        region: "RU",
        pageQuote:
          "Son nom est cite en novembre 2017 dans les revelations des Paradise Papers concernant des avoirs offshore",
      },
    },
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;

  it("страница цитируется первой, даже когда заголовок бьёт в ключевые слова", () => {
    const claim = localizedThemedClaim(FINDING, scoped);
    const first = claim.split("\n").find((l) => l.startsWith("«") && l.includes("источник"));
    expect(first).toContain("Paradise Papers");
  });

  it("голое имя с ярлыком площадки цитатой не становится вперёд страницы", () => {
    const claim = localizedThemedClaim(FINDING, scoped);
    const lines = claim.split("\n").filter((l) => l.startsWith("«") && l.includes("источник"));
    expect(lines[0]).not.toContain("OpenSanctions");
  });
});
