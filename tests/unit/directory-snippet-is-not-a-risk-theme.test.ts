/**
 * Сниппет справочника — оглавление сайта, а не утверждение о человеке.
 *
 * Живой прогон 20.08 (кейс Прохоров, `unified-1787248325884-c84131ed`) выдал
 * банку ключевым риском №1 «Криминальные / судебные материалы». Под находкой
 * было ровно одно наблюдение: карточка `bizfiles.org` на двадцатом месте
 * Яндекса, страница не читалась, а весь «криминал» — слово «суды» в перечне
 * разделов сайта: «Сводка информации, аффилированность, финансы, суды.»
 * Такой перечень стоит на карточке любого человека на этом сайте.
 *
 * Решение владельца 21.08: у справочных доменов (реестры, каталоги) сниппет
 * выдачи в определении темы не участвует. Заголовок и адрес участвуют:
 * режется сниппет, а не домен целиком.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { sourceTypeFromDomain } from "../../src/modules/digital-profile/orion-golden/analytics/source-type";

const CASE_ID = "case-unit-directory-snippet";

/** Сниппет ровно с того прогона. */
const BIZFILES_SNIPPET =
  "Предприниматель Прохоров Михаил Дмитриевич Москва. ИНН 771700429827. " +
  "Учредитель 9 фирм(ы). Сводка информации, аффилированность, финансы, суды.";

const SUBJECT: SubjectIdentity = {
  displayName: "Прохоров Михаил Дмитриевич",
  lastName: "Прохоров",
  lastNameVariants: ["prokhorov"],
  firstNames: ["Михаил", "mikhail"],
  patronymics: ["Дмитриевич"],
  aliases: ["Прохоров Михаил Дмитриевич"],
  strongIdentifiers: ["771700429827"],
  contextIdentifiers: ["предприниматель", "бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

let seq = 0;
function item(
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE_ID,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-08-20T16:11:08.684Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

/** Идентификаторы находок, собранных по одному наблюдению. */
function findingIdsFor(one: RawInventoryItem): string[] {
  const items = [one];
  const resolution = buildSubjectResolution({
    caseId: CASE_ID,
    datasetId: "ds-directory-snippet",
    subject: SUBJECT,
    items,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
  byRef.set(`inventory:${one.inventoryId}`, {
    ...byRef.get(`inventory:${one.inventoryId}`)!,
    decision: "SUBJECT_MATCH",
  });
  const result = synthesizeFindings({
    caseId: CASE_ID,
    datasetId: "ds-directory-snippet",
    items,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  return [...result.bundle.findings, ...result.ambiguousFindings].map((f) => f.findingId);
}

describe("сниппет справочника не становится темой риска", () => {
  it("тот самый случай прогона: карточка bizfiles.org не даёт криминальной темы", () => {
    const ids = findingIdsFor(
      item({
        title: "Прохоров Михаил Дмитриевич Москва",
        snippet: BIZFILES_SNIPPET,
        sourceUrl: "https://www.bizfiles.org/d/person/771700429827/info",
      })
    );
    expect(ids.filter((id) => id.includes("criminal_legal"))).toEqual([]);
  });

  it("тот же сниппет в СМИ темой остаётся — правило про тип источника, а не про слово", () => {
    const ids = findingIdsFor(
      item({
        title: "Прохоров Михаил Дмитриевич",
        snippet: BIZFILES_SNIPPET,
        sourceUrl: "https://www.rbc.ru/business/prohorov",
      })
    );
    expect(ids.some((id) => id.includes("criminal_legal"))).toBe(true);
  });

  it("заголовок справочника темой остаётся — режется сниппет, а не домен", () => {
    const ids = findingIdsFor(
      item({
        title: "Суд взыскал с Прохорова Михаила Дмитриевича 40 млн",
        snippet: BIZFILES_SNIPPET,
        sourceUrl: "https://www.bizfiles.org/d/person/771700429827/info",
      })
    );
    expect(ids.some((id) => id.includes("criminal_legal"))).toBe(true);
  });

  it("справочник узнаётся по домену", () => {
    expect(sourceTypeFromDomain("bizfiles.org")).toBe("База данных / реестр");
    expect(sourceTypeFromDomain("www.bizfiles.org")).toBe("База данных / реестр");
  });
});
