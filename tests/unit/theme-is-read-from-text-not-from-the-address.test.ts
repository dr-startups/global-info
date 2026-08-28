/**
 * Тему материала назначают слова текста, а домены отвечают отдельным списком.
 *
 * Замечание владельца (Аудит 2, №6): «некоторые темы стоят странно — ни одна
 * ссылка не говорит об этой тематике». Один из двух источников этого — строка
 * сверки: `themesFor` склеивал заголовок, сниппет, служебный `classification`
 * **и адрес**, а у словаря тем есть левая граница и нет правой. Раздел сайта в
 * пути (`…/court/…`, `…/investigations/…`) и слаг с дефисами читались как текст
 * публикации, и нейтральный заголовок получал криминальную тему.
 *
 * Доменные слова из словарей тем при этом никуда не делись — они переехали в
 * именованный список доменов темы, как `ADVERSE_DOMAIN_RE` у предиката строки:
 * `opencorporates.com` в адресе по-прежнему называет тему, но отвечает за это
 * список площадок, а не словарь.
 */

import { describe, expect, it } from "vitest";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const CASE_ID = "case-unit-theme-text";
const DATASET_ID = "ds-theme-text";

let seq = 0;
function item(
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-theme-${seq}`,
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

function synthesize(items: RawInventoryItem[]) {
  return synthesizeFindings({
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    items,
    resolutionByRef: new Map(
      items.map((i) => [
        refOf(i),
        { evidenceRef: refOf(i), decision: "SUBJECT_MATCH" } as SubjectResolutionItem,
      ])
    ),
    sourceHashes: ["sha256:test"],
  });
}

function themeIdsFor(one: RawInventoryItem): string[] {
  const result = synthesize([one]);
  return result.themeAssignments.get(refOf(one)) ?? [];
}

describe("тему назначает текст материала, а не его адрес", () => {
  it("раздел сайта в пути темой не становится", () => {
    const inPath = item({
      title: "Умар Кремлев рассказал о планах федерации бокса",
      sourceUrl: "https://www.example-news.ru/court/kremlev-plany",
    });
    expect(themeIdsFor(inPath)).toEqual([]);
  });

  it("материал, оставшийся без темы, виден в неотнесённых, а не пропадает", () => {
    const inPath = item({
      title: "Умар Кремлев рассказал о планах федерации бокса",
      sourceUrl: "https://www.example-news.ru/court/kremlev-plany",
    });
    const result = synthesize([inPath]);
    expect(result.uncategorized.allEvidenceRefs).toEqual([refOf(inPath)]);
  });

  it("служебный ярлык материала темой не становится", () => {
    const labelled = item({
      title: "Умар Кремлев открыл детскую спортивную школу",
      sourceUrl: "https://www.example-news.ru/kremlev-school",
      classification: "PEP",
    });
    expect(themeIdsFor(labelled)).toEqual([]);
  });

  it("домен темы отвечает своим списком: opencorporates при нейтральном заголовке", () => {
    const registry = item({
      title: "Nordkap Capital AB — company record",
      sourceUrl: "https://opencorporates.com/companies/se/5566012345",
    });
    expect(themeIdsFor(registry)).toContain("offshore_structures");
  });

  it("отрицание рядом со словом по-прежнему снимает тему", () => {
    const denied = item({
      title: "Сведения об офшоре не подтвердились",
      sourceUrl: "https://www.example-news.ru/kremlev-holding-check",
    });
    expect(themeIdsFor(denied)).toEqual([]);
  });

  it("совпадение по домену отрицанием в тексте не снимается", () => {
    const registry = item({
      title: "Сведения об офшоре не подтвердились",
      sourceUrl: "https://opencorporates.com/companies/se/5566012345",
    });
    expect(themeIdsFor(registry)).toContain("offshore_structures");
  });
});
