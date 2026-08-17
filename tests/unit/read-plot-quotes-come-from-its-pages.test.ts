/**
 * Цитата сюжета — с его собственной страницы.
 *
 * Сюжет собирается из строки артефакта, а цитаты берутся из вердиктов
 * участников: цитата чужого сюжета в блоке — это то же нарушение, что и
 * заголовок, приписанный не тому изданию. Порядок отбора задан: сначала
 * нежелательные страницы, внутри — по позиции в выдаче; больше двух цитат в
 * блок не идёт.
 *
 * Гигиена та же, что у остального клиентского текста: обрывок или машинная
 * выгрузка не печатается вовсе, и тогда блок живёт числами и доменами, а не
 * куском фразы.
 */

import { describe, expect, it } from "vitest";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { ClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";
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
    url: `https://affarsposten.se/${over.evidenceRef}`,
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
  it("нежелательная страница цитируется раньше нейтральной, и не больше двух", () => {
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
    expect(plot.quotes.map((q) => q.text)).toEqual([ADVERSE_TOP, ADVERSE_LOWER]);
    expect(plot.quotes.map((q) => q.domain)).toEqual([
      "affarsposten.se",
      "pravo-obzor.ru",
    ]);
    expect(plot.quotes.map((q) => q.evidenceRef)).toEqual([
      "inventory:obs-03",
      "inventory:obs-02",
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
});
