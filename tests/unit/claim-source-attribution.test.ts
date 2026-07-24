import { describe, it, expect } from "vitest";
import { buildCanonicalClaimsBundle } from "../../src/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

/**
 * Шаг 05.3 плана (docs/rework/05-claim-synthesis-and-gpt-input.md).
 *
 * `originalTitle` брался из evidenceItems[0], а домен рядом с ним — из
 * sourceDomains[0], то есть из агрегированного по всему finding'у списка,
 * порядок которого с заголовком не связан. В отчёте это дало «ПЕРСОНА ТАСС»
 * с припиской news.mail.ru и статью «Циклопедии» с приписком ru.wikipedia.org
 * при реальном URL cyclowiki.org.
 */

function item(over: Partial<RawInventoryItem> & Pick<RawInventoryItem, "inventoryId" | "title">) {
  return {
    caseId: "case-attr",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-20T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    sourceUrl: "https://example.org/a",
    ...over,
  } as RawInventoryItem;
}

/** Finding whose aggregated domain list deliberately disagrees with the lead item. */
function buildBundle(items: RawInventoryItem[], sourceDomains: string[]) {
  const evidenceRefs = items.map((i) => `inventory:${i.inventoryId}`);
  return buildCanonicalClaimsBundle({
    caseId: "case-attr",
    datasetId: "ds-attr",
    subjectId: "Субъект Тестовый",
    sourceHashes: ["sha256:abc"],
    items,
    synthesis: {
      bundle: {
        findings: [
          {
            findingId: "finding-attr-1",
            theme: "criminal_judicial",
            claim: "Материал о судебном разбирательстве.",
            subjectMatch: "SUBJECT_MATCH",
            confidence: 0.9,
            evidenceRefs,
            sourceDomains,
            providers: ["yandex"],
            regions: ["RU"],
            contradictions: [],
            recommendedAction: "Сверить первоисточник и статус дела.",
          },
        ],
      },
      ambiguousFindings: [],
    },
    dispositionLedger: { entries: [] },
  } as never);
}

describe("атрибуция источника в canonical claim", () => {
  it("берёт домен из того же материала, что и заголовок", () => {
    const lead = item({
      inventoryId: "i1",
      title: "Дуров, Павел Валерьевич — ПЕРСОНА ТАСС",
      sourceUrl: "https://tass.ru/persons/durov",
    });
    const other = item({
      inventoryId: "i2",
      title: "Другой материал",
      sourceUrl: "https://news.mail.ru/story/2",
    });

    // sourceDomains намеренно начинается с ЧУЖОГО домена — как в проде.
    const bundle = buildBundle([lead, other], ["news.mail.ru", "tass.ru"]);
    const claim = bundle.claims[0];

    expect(claim.originalTitle).toBe("Дуров, Павел Валерьевич — ПЕРСОНА ТАСС");
    expect(claim.originalDomain).toBe("tass.ru");
    expect(claim.originalUrl).toBe("https://tass.ru/persons/durov");
    // Домен ведущего материала не совпадает с первым в агрегате — раньше
    // именно этот случай и порождал ложную атрибуцию.
    expect(claim.sourceDomains[0]).not.toBe(claim.originalDomain);
  });

  it("не выдумывает домен, когда у ведущего материала нет URL", () => {
    const lead = item({ inventoryId: "i1", title: "Материал без ссылки", sourceUrl: undefined });
    const bundle = buildBundle([lead], ["news.mail.ru"]);
    const claim = bundle.claims[0];

    expect(claim.originalTitle).toBe("Материал без ссылки");
    expect(claim.originalDomain).toBeNull();
    expect(claim.originalUrl).toBeNull();
  });

  it("сохраняет агрегированный список доменов темы без изменений", () => {
    const lead = item({ inventoryId: "i1", title: "Заголовок", sourceUrl: "https://tass.ru/x" });
    const other = item({ inventoryId: "i2", title: "Второй", sourceUrl: "https://rbc.ru/y" });
    const bundle = buildBundle([lead, other], ["news.mail.ru"]);

    // Домены темы законно агрегируют все источники — ломать это не нужно,
    // запрещено лишь подставлять чужой домен рядом с конкретным заголовком.
    expect(bundle.claims[0].sourceDomains).toEqual(
      expect.arrayContaining(["news.mail.ru", "tass.ru", "rbc.ru"])
    );
  });
});
