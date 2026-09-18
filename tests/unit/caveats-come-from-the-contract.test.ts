/**
 * Оговорки серым — шаг 0105 программы 0095 (решение 3, вариант (а)).
 *
 * Оговорка — законченное предложение фиксированного словаря, в котором нет
 * факта: «Наличие публикации не подтверждает изложенные обвинения»,
 * «Принадлежность материала проверяемому лицу требует подтверждения». Рендерер
 * узнаёт её роль по словарю, и словарь у оговорки один — раздел
 * `typography.caveats` контракта клиентского текста. Производители берут текст
 * оттуда же: константа в коде рядом с шаблоном в контракте — два ответа на один
 * вопрос, и разойдутся они молча: рендерер перестанет узнавать строку, а
 * страница промолчит.
 *
 * Здесь же — форма блока: оговорка стоит своей строкой (роль — свойство
 * строки), а одинаковая у всех записей блока печатается один раз, последней.
 */

import { describe, expect, it } from "vitest";
import { getClientTextContract } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import { caveatText, type CaveatKey } from "@/modules/digital-profile/orion-golden/client/caveats";
import { linesWithCaveats } from "@/modules/digital-profile/orion-golden/client/block-lines";
import { qualificationFor } from "@/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import { CLIENT_MATERIAL_QUALIFICATION } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { composeClientSummary } from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { sampleClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/sample-contracts";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const DOMAINS = "kapitalnytt.se, stockholm-kuriren.se";

function templates(): Record<string, string> {
  const section = getClientTextContract().typography as { caveats?: Record<string, string> } | undefined;
  return section?.caveats ?? {};
}

function filled(template: string): string {
  return template.replace("{domains}", DOMAINS);
}

describe("оговорки: один словарь — в контракте", () => {
  it("К1: caveatText отдаёт каждый шаблон словаря; подстановка — только объявленная", () => {
    const all = templates();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(12);
    for (const [key, template] of Object.entries(all)) {
      const withDomains = template.includes("{domains}");
      const text = caveatText(key as CaveatKey, withDomains ? { domains: DOMAINS } : undefined);
      expect(text).toBe(filled(template));
      expect(text).not.toMatch(/[{}]/u);
    }
    // Шаблон с подстановкой без доменов и домены для шаблона без подстановки —
    // ошибка сборки, а не текст с фигурными скобками на странице клиента.
    expect(() => caveatText("sourceAllegationWithDomains")).toThrow(/domains/u);
    expect(() => caveatText("context", { domains: DOMAINS })).toThrow(/domains/u);
    expect(() => caveatText("noSuchCaveat" as CaveatKey)).toThrow(/noSuchCaveat/u);
  });

  it("К2: всё, что производители называют оговоркой, есть в словаре слово в слово", () => {
    const known = new Set(Object.values(templates()).map(filled));
    const produced = [
      qualificationFor("SOURCE_ALLEGATION", ["kapitalnytt.se", "stockholm-kuriren.se"]),
      qualificationFor("SOURCE_ALLEGATION", []),
      qualificationFor("DATABASE_STATUS", []),
      qualificationFor("OFFICIAL_RECORD", []),
      qualificationFor("FACT", []),
      qualificationFor("CONTEXT", []),
      CLIENT_MATERIAL_QUALIFICATION,
    ];
    for (const sentence of produced) expect(known).toContain(sentence);
    expect(new Set(produced).size).toBe(produced.length);

    // Оговорка о принадлежности ставится прочитанной странице: рамку объяснил
    // вердикт аналитика (`verdictTheme`), а не заголовок выдачи.
    const url = "https://x.com/some/status/1";
    const out = highlightPhrase({
      row: { ref: "obs-1", url, domain: "x.com", themeTitle: "Криминальные / судебные материалы" },
      evidence: {
        "obs-1": {
          title: "Заголовок материала о деле",
          url,
          domain: "x.com",
          snippet: "",
          verdictTheme: "Уголовное дело о налоговом мошенничестве",
          verdictSubjectMatch: "likely",
          pageQuote: "Суд назначил заседание по делу фонда.",
        },
      },
      finding: { theme: "Криминальные / судебные материалы" },
      budget: 240,
    } as never);
    const lines = String(out.block).split("\n");
    expect(lines).toContain(caveatText("subjectMatchLikely"));
  });

  it("К3: оговорка — своей строкой; одинаковая у всех записей блока — один раз, последней", () => {
    const same = "Сигнал базы требует сверки.";
    expect(
      linesWithCaveats([
        { line: "Dow Jones. Есть сигнал.", caveat: same },
        { line: "LexisNexis. Есть сигнал.", caveat: same },
      ])
    ).toEqual(["Dow Jones. Есть сигнал.", "LexisNexis. Есть сигнал.", same]);
    expect(
      linesWithCaveats([
        { line: "A.", caveat: "Первая." },
        { line: "B.", caveat: "Вторая." },
      ])
    ).toEqual(["A.", "Первая.", "B.", "Вторая."]);
    expect(
      linesWithCaveats([
        { line: "A.", caveat: "" },
        { line: "B.", caveat: "Одна." },
      ])
    ).toEqual(["A.", "B.", "Одна."]);
    expect(linesWithCaveats([{ line: "A.", caveat: "Одна." }])).toEqual(["A.", "Одна."]);
    expect(linesWithCaveats([])).toEqual([]);
  });

  it("К4: в резюме оговорка базы и единичной публикации — строкой после записи, не хвостом её предложения", () => {
    const dbCaveat = caveatText("databaseSignalCheck");
    const pack = {
      ...sampleClientSummaryPack(),
      internationalDatabases: [
        {
          databaseName: "Dow Jones",
          statusSummary:
            "По открытым/импортированным данным есть сигнал, связанный с записью «Holmstrom, Johan».",
          qualification: dbCaveat,
          evidenceRefs: ["inventory:obs-dj"],
          sourceDomains: ["dowjones.com"],
        },
        {
          databaseName: "LexisNexis",
          statusSummary:
            "По открытым/импортированным данным есть сигнал, связанный с записью «Johan Holmstrom».",
          qualification: dbCaveat,
          evidenceRefs: ["inventory:obs-ln"],
          sourceDomains: ["lexisnexis.com"],
        },
      ],
      isolatedSignificantItems: [
        {
          title: "Материал о споре",
          domain: "news.example",
          description: "Описание материала.",
          qualification: CLIENT_MATERIAL_QUALIFICATION,
          materialityLevel: "HIGH" as const,
          evidenceRefs: ["inventory:obs-iso"],
        },
      ],
    };
    const composed = composeClientSummary({ pack });

    const db = composed.sections.internationalDatabases.split("\n");
    expect(db).toHaveLength(4);
    expect(db[0]).toBe("Международные базы и официальные источники");
    expect(db[1]).toMatch(/^Dow Jones\. .*«Holmstrom, Johan»\.$/u);
    expect(db[2]).toMatch(/^LexisNexis\. .*«Johan Holmstrom»\.$/u);
    expect(db[3]).toBe(dbCaveat);

    const iso = composed.sections.isolatedItems.split("\n");
    expect(iso).toHaveLength(3);
    expect(iso[0]).toBe("Единичные существенные публикации");
    expect(iso[1]).toMatch(/^«Материал о споре».*Описание материала\.$/u);
    expect(iso[2]).toBe(CLIENT_MATERIAL_QUALIFICATION);
  });
});
