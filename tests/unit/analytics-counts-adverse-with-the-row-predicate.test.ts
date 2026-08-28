/**
 * «Негативен ли материал» — один ответ на весь отчёт, включая аналитику.
 *
 * Замечание владельца (Аудит 2, №4): «Биография Умара Кремлева и его путь к
 * успеху» на klerk.ru помечена нежелательной. Оценку строки таблицы выдачи
 * свели к одному предикату шагом раньше, но в находках негатив считался своим
 * словарём — по склейке «заголовок + сниппет + classification + sourceUrl»,
 * без вердикта прочитанной страницы и без списка негативных площадок.
 *
 * Цена ошибки здесь **симметрична**: отчёт читает сам субъект, и ложный
 * «Нежелательный» на благоприятном материале — это предложение убрать из
 * интернета то, что говорит о человеке хорошо.
 */

import { describe, expect, it } from "vitest";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { runSurfaceAnalyzers } from "@/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import type { ObservationVerdictByRef } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const CASE_ID = "case-unit-analytics-adverse";
const DATASET_ID = "ds-analytics-adverse";

let seq = 0;
function item(
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE_ID,
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "serper",
    region: "RU",
    collectedAt: "2026-08-28T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    rawMetadata: { surface: "organic", engine: "GOOGLE" },
    ...partial,
  };
}

function refOf(i: RawInventoryItem): string {
  return `inventory:${i.inventoryId}`;
}

/** Все материалы принадлежат субъекту: предмет проверки — только негатив. */
function subjectMatchLookup(items: RawInventoryItem[]): Map<string, SubjectResolutionItem> {
  return new Map(
    items.map((i) => [
      refOf(i),
      { evidenceRef: refOf(i), decision: "SUBJECT_MATCH" } as SubjectResolutionItem,
    ])
  );
}

function findingsFor(
  items: RawInventoryItem[],
  verdictByRef?: ObservationVerdictByRef
) {
  return synthesizeFindings({
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    items,
    resolutionByRef: subjectMatchLookup(items),
    sourceHashes: ["sha256:test"],
    verdictByRef,
  }).bundle.findings;
}

function findingFor(
  themeId: string,
  items: RawInventoryItem[],
  verdictByRef?: ObservationVerdictByRef
) {
  return findingsFor(items, verdictByRef).find((f) => f.findingId.includes(themeId));
}

/** «негативных: N» поверхности — то же число, что печатает таблица метрик. */
function adverseSubjectCount(
  items: RawInventoryItem[],
  verdictByRef?: ObservationVerdictByRef
): number {
  const unit = runSurfaceAnalyzers({
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    items,
    resolutionLookup: subjectMatchLookup(items),
    sourceHashes: ["sha256:test"],
    verdictByRef,
  }).organic.units[0]!;
  const metric = unit.metrics.find((m) => m.key === "adverseSubjectCount");
  return Number(metric?.value ?? -1);
}

describe("негатив в аналитике считается предикатом строки", () => {
  it("благоприятно прочитанная страница снимает словарную метку в находках", () => {
    const material = item({
      title: "Суд рассмотрел иск Умара Кремлева к изданию",
      sourceUrl: "https://www.rbc.ru/society/kremlev-sud",
    });
    const supportive: ObservationVerdictByRef = {
      [refOf(material)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };

    const before = findingFor("criminal_legal", [material]);
    expect(before?.riskLevel).toBe("critical");

    const after = findingFor("criminal_legal", [material], supportive);
    expect(after?.riskLevel).toBe("medium");
    expect(after?.claim).not.toContain("с негативным контекстом");
  });

  it("биография на мягкой площадке не становится негативом от машинного ярлыка", () => {
    // Тот самый материал из замечания владельца: klerk.ru, благоприятный
    // заголовок и `classification`, записанный четвёртым словарём.
    const biography = item({
      title: "Биография Умара Кремлева и его путь к успеху",
      snippet: "Как основатель федерации бокса выстроил карьеру.",
      sourceUrl: "https://www.klerk.ru/buh/articles/kremlev-biography/",
      classification: "ADVERSE_MEDIA",
    });

    const finding = findingFor("business_profile", [biography]);
    expect(finding?.riskLevel).toBe("none");
    expect(finding?.claim).not.toContain("с негативным контекстом");
  });

  it("`classification` сам по себе материал негативным не делает", () => {
    // Ярлык строки выдачи пишется тем же предикатом негатива
    // (`hl.isHighlighted ? "ADVERSE_MEDIA" : "NEUTRAL"`), поэтому проверка
    // через него мерила бы дефект тем, что его создаёт.
    const labelled = item({
      title: "Умар Кремлев открыл спортивный центр в Москве",
      sourceUrl: "https://www.example-news.ru/kremlev-center",
      classification: "ADVERSE_MEDIA",
    });
    expect(adverseSubjectCount([labelled])).toBe(0);
  });

  it("адрес площадки словарём не читается", () => {
    // Словарь читает текст, а домен отвечает списком. У словаря есть левая
    // граница, поэтому имя площадки «The Investigator News» совпадения не даёт
    // и без правки, — а вот раздел сайта в пути даёт: там перед словом стоит
    // косая черта.
    const inHostName = item({
      title: "Умар Кремлев как инвестор: интервью о планах",
      sourceUrl: "https://theinvestigatornews.com/kremlev-board",
    });
    const inUrlPath = item({
      title: "Умар Кремлев как инвестор: интервью о планах",
      sourceUrl: "https://www.example-news.ru/investigations/kremlev-board",
    });
    expect(findingFor("business_profile", [inHostName])?.riskLevel).toBe("none");
    const byPath = findingFor("business_profile", [inUrlPath]);
    expect(byPath?.riskLevel).toBe("none");
    expect(byPath?.claim).not.toContain("с негативным контекстом");
  });

  it("мягкая площадка слепа только к слабым словам", () => {
    const genre = item({
      title: "Умар Кремлев: биография, бизнес, скандалы",
      sourceUrl: "https://www.klerk.ru/buh/articles/kremlev/",
    });
    const signal = item({
      title: "Уголовное дело против Умара Кремлева",
      sourceUrl: "https://x.com/someone/status/1",
    });
    expect(adverseSubjectCount([genre])).toBe(0);
    expect(adverseSubjectCount([signal])).toBe(1);
  });

  it("санкционный реестр остаётся негативом без единого слова словаря", () => {
    const registry = item({
      title: "Umar Kremlev — entity profile",
      sourceUrl: "https://www.opensanctions.org/entities/Q55102113/",
    });
    expect(adverseSubjectCount([registry])).toBe(1);
  });

  it("решение аналитика сильнее всего и доезжает до уровня темы", () => {
    const ownership = item({
      title: 'Умар Кремлев стал владельцем "Рольфа"',
      sourceUrl: "https://www.example-news.ru/kremlev-rolf",
    });
    const adverseByAnalyst = { ...ownership, rawMetadata: { ...ownership.rawMetadata, analystAdverse: true } };
    const neutralByAnalyst = {
      ...ownership,
      rawMetadata: { ...ownership.rawMetadata, analystNeutral: true },
    };
    // Аналитик спорит с вердиктом в обе стороны: его «нежелательный» стоит
    // выше благоприятной страницы, его «нейтральный» — выше нежелательной.
    const supportive: ObservationVerdictByRef = {
      [refOf(ownership)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };
    const adverseRead: ObservationVerdictByRef = {
      [refOf(ownership)]: { tone: "adverse", quoted: true, subjectMatch: "subject" },
    };

    expect(findingFor("offshore_corporate", [adverseByAnalyst], supportive)?.riskLevel).toBe("medium");
    expect(findingFor("offshore_corporate", [neutralByAnalyst], adverseRead)?.riskLevel).toBe("low");
  });

  it("тема, все материалы которой прочитаны и благоприятны, не повышает уровень", () => {
    const owner = item({
      title: 'Умар Кремлев стал владельцем "Рольфа"',
      sourceUrl: "https://www.example-news.ru/kremlev-rolf",
      classification: "ADVERSE_MEDIA",
    });
    const beneficiary = item({
      title: "Кремлев — бенефициар фонда: расследование издания",
      sourceUrl: "https://www.example-news.ru/kremlev-fund",
    });
    const supportive: ObservationVerdictByRef = {
      [refOf(owner)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
      [refOf(beneficiary)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };

    expect(findingFor("offshore_corporate", [owner, beneficiary])?.riskLevel).toBe("medium");
    const after = findingFor("offshore_corporate", [owner, beneficiary], supportive);
    expect(after?.riskLevel).toBe("low");
    expect(after?.claim).not.toContain("с негативным контекстом");
  });
});
