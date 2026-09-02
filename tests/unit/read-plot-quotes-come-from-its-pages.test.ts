/**
 * Цитата сюжета — с его собственной страницы.
 *
 * Сюжет собирается из строки артефакта, а цитаты берутся из вердиктов
 * участников: цитата чужого сюжета в блоке — это то же нарушение, что и
 * заголовок, приписанный не тому изданию. Порядок отбора задан: сначала
 * нежелательные страницы, внутри — по позиции в выдаче; предел цитат — один на
 * весь проект (`READ_PLOT_QUOTE_LIMIT`), и схема с построителем берут его из
 * одного места.
 *
 * Гигиена та же, что у остального клиентского текста: обрывок или машинная
 * выгрузка не печатается вовсе, и тогда блок живёт числами и доменами, а не
 * куском фразы.
 */

import { describe, expect, it } from "vitest";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import {
  ClientReadPlotSchema,
  READ_PLOT_QUOTE_LIMIT,
  type ClientSummaryPack,
} from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import type {
  LinkVerdict,
  VerdictThemeSummary,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RepresentativeEvidenceSelection } from "@/modules/digital-profile/orion-golden/contracts/representative-evidence";

const NO_CLAIMS = { claims: [] } as unknown as CanonicalClaimsBundle;
const NO_SELECTION = {
  materialThemeIds: [],
  selectedByTheme: {},
  isolatedSignificantItems: [],
  p1p2Account: [],
} as unknown as RepresentativeEvidenceSelection;

const NEUTRAL_QUOTE =
  "Нордкап Капитал управляет портфелем скандинавских венчурных инвестиций с 2012 года";
const ADVERSE_TOP =
  "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm";
const ADVERSE_LOWER =
  "Прокуратура Стокгольма подтвердила, что расследование в отношении предпринимателя продолжается";
const ADVERSE_THIRD =
  "Ещё одна публикация о ходе расследования вышла в скандинавском деловом издании";
const OTHER_PLOT_QUOTE =
  "Мальтийский холдинг зарегистрирован на номинального владельца, следует из выписки реестра";

function verdict(over: Partial<LinkVerdict> & { evidenceRef: string }): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    // Адрес не строится из `evidenceRef`: «inventory:obs-01» внутри URL —
    // машинный токен, которого в настоящем адресе не бывает, и сторож
    // технических токенов справедливо на него срабатывает.
    url: `https://affarsposten.se/text/${String(over.evidenceRef).replace(/[^a-z0-9]+/giu, "-")}`,
    domain: "affarsposten.se",
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
    quotes: [],
    readAt: "2026-08-17T12:00:00.000Z",
    ...over,
  } as LinkVerdict;
}

function pack(themes: VerdictThemeSummary[], verdicts: LinkVerdict[]): ClientSummaryPack {
  return buildClientSummaryPack({
    caseId: "case-quotes",
    datasetId: "ds-quotes",
    subjectId: "Anders Holmström",
    sourceHashes: ["sha256:test"],
    claimsBundle: NO_CLAIMS,
    representative: NO_SELECTION,
    overallVerdict: "HIGH",
    linkVerdicts: { themes, verdicts },
  });
}

describe("цитаты сюжета", () => {
  it("нежелательная страница цитируется раньше нейтральной", () => {
    const built = pack(
      [
        {
          theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
          count: 4,
          adverseCount: 3,
          evidenceRefs: [
            "inventory:obs-01",
            "inventory:obs-02",
            "inventory:obs-03",
            "inventory:obs-04",
          ],
          examples: [],
        },
      ],
      [
        verdict({ evidenceRef: "inventory:obs-01", rank: 1, quotes: [{ text: NEUTRAL_QUOTE }] }),
        verdict({
          evidenceRef: "inventory:obs-02",
          rank: 5,
          tone: "adverse",
          domain: "pravo-obzor.ru",
          quotes: [{ text: ADVERSE_LOWER }],
        }),
        verdict({
          evidenceRef: "inventory:obs-03",
          rank: 3,
          tone: "adverse",
          quotes: [{ text: ADVERSE_TOP }],
        }),
        verdict({
          evidenceRef: "inventory:obs-04",
          rank: 9,
          tone: "adverse",
          domain: "nordic-review.se",
          quotes: [{ text: ADVERSE_THIRD }],
        }),
      ]
    );
    const plot = built.readPlots[0]!;
    // Нежелательные впереди по позиции в выдаче, нейтральная — последней.
    expect(plot.quotes.map((q) => q.text)).toEqual([
      ADVERSE_TOP,
      ADVERSE_LOWER,
      ADVERSE_THIRD,
      NEUTRAL_QUOTE,
    ]);
    expect(plot.quotes.map((q) => q.domain)).toEqual([
      "affarsposten.se",
      "pravo-obzor.ru",
      "nordic-review.se",
      "affarsposten.se",
    ]);
  });

  it("цитата берётся только у страниц своего сюжета", () => {
    const built = pack(
      [
        {
          theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
          count: 1,
          adverseCount: 1,
          evidenceRefs: ["inventory:obs-01"],
          examples: [],
        },
        {
          theme: "Спор о структуре владения через мальтийский холдинг",
          count: 1,
          adverseCount: 1,
          evidenceRefs: ["inventory:obs-02"],
          examples: [],
        },
      ],
      [
        verdict({
          evidenceRef: "inventory:obs-01",
          rank: 1,
          tone: "adverse",
          quotes: [{ text: ADVERSE_TOP }],
        }),
        verdict({
          evidenceRef: "inventory:obs-02",
          rank: 2,
          tone: "adverse",
          domain: "malta-registry-watch.org",
          theme: "Спор о структуре владения через мальтийский холдинг",
          quotes: [{ text: OTHER_PLOT_QUOTE }],
        }),
      ]
    );
    const stockholm = built.readPlots.find((p) => p.title.startsWith("Уголовное дело"))!;
    const malta = built.readPlots.find((p) => p.title.startsWith("Спор о структуре"))!;
    expect(stockholm.quotes.map((q) => q.text)).toEqual([ADVERSE_TOP]);
    expect(malta.quotes.map((q) => q.text)).toEqual([OTHER_PLOT_QUOTE]);
    expect(stockholm.sourceDomains).toEqual(["affarsposten.se"]);
    expect(malta.sourceDomains).toEqual(["malta-registry-watch.org"]);
  });

  it("обрывок не печатается, а числа и домены остаются", () => {
    const built = pack(
      [
        {
          theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
          count: 2,
          adverseCount: 2,
          evidenceRefs: ["inventory:obs-01", "inventory:obs-02"],
          examples: [],
        },
      ],
      [
        // Оборванная фраза: предложение продолжалось за краем цитаты.
        verdict({
          evidenceRef: "inventory:obs-01",
          rank: 1,
          tone: "adverse",
          quotes: [
            {
              text: "Стокгольмский суд отказал в удовлетворении ходатайства защиты по делу, поскольку",
            },
          ],
        }),
        // Выгрузка таблицы: набор ярлыков и чисел вместо фразы.
        verdict({
          evidenceRef: "inventory:obs-02",
          rank: 2,
          tone: "adverse",
          domain: "pravo-obzor.ru",
          quotes: [{ text: "События Участие в организациях 26 События ИП 2 Санкции 83" }],
        }),
      ]
    );
    const plot = built.readPlots[0]!;
    expect(plot.quotes).toEqual([]);
    expect(plot.count).toBe(2);
    expect(plot.adverseCount).toBe(2);
    expect(plot.sourceDomains).toEqual(["affarsposten.se", "pravo-obzor.ru"]);
  });

  it("сюжет из девяти нежелательных публикаций цитируется шестью, а не двумя", () => {
    /*
     * Тот самый случай прогона Прохорова: сюжет «Скандалы, конфликты и критика
     * деловой репутации» собрал девять нежелательных страниц, среди них разбор
     * файлов Эпштейна. В блок шли две цитаты — Википедия и Куршевель, — и
     * владелец, читая отчёт, не нашёл про Эпштейна ни слова.
     */
    const refs = Array.from({ length: 9 }, (_, i) => `inventory:obs-${String(i + 1).padStart(2, "0")}`);
    const built = pack(
      [
        {
          theme: "Скандалы, конфликты и критика деловой репутации",
          count: 9,
          adverseCount: 9,
          evidenceRefs: refs,
          examples: [],
        },
      ],
      refs.map((ref, i) =>
        verdict({
          evidenceRef: ref,
          rank: i + 1,
          tone: "adverse",
          domain: `pub-${i + 1}.example`,
          quotes: [{ text: `Публикация номер ${i + 1} подробно разбирает обстоятельства дела и его последствия для деловой репутации` }],
        })
      )
    );
    const plot = built.readPlots[0]!;
    expect(plot.quotes).toHaveLength(READ_PLOT_QUOTE_LIMIT);
    expect(plot.quotes.map((q) => q.evidenceRef)).toEqual(refs.slice(0, READ_PLOT_QUOTE_LIMIT));
    // Шестая по порядку — та, что при пределе в две терялась.
    expect(plot.quotes[5]!.text).toContain("номер 6");
  });

  it("схема принимает ровно тот же предел, что и построитель", () => {
    const quote = { text: "Фраза со страницы", domain: "example.com", evidenceRef: "inventory:obs-x" };
    const plot = {
      plotId: "plot:abc",
      title: "Сюжет",
      count: 9,
      adverseCount: 9,
      evidenceRefs: [],
      sourceDomains: [],
    };
    expect(
      ClientReadPlotSchema.safeParse({
        ...plot,
        quotes: Array.from({ length: READ_PLOT_QUOTE_LIMIT }, () => quote),
      }).success
    ).toBe(true);
    expect(
      ClientReadPlotSchema.safeParse({
        ...plot,
        quotes: Array.from({ length: READ_PLOT_QUOTE_LIMIT + 1 }, () => quote),
      }).success
    ).toBe(false);
  });
});
