/**
 * Контекст субъекта не намайнивается из собранного корпуса.
 *
 * Майнер учился на бесконфликтных SUBJECT_MATCH прохода 1, а у полного тёзки
 * конфликтов не бывает: на прогоне 0049 в «эффективный контекст» попали
 * одновременно «судья, арбитражный, краснодарского» и «офтальмолог, профессор»,
 * после чего 292 материала четырёх разных людей получили
 * `full_name_with_context` 0.92. Корпус, собранный по одному совпадению имени,
 * не может быть источником признаков, которыми этот же корпус подтверждается.
 *
 * Функция остаётся вызываемой (её словарь пригодится как подсказка оператору о
 * тёзках), но в разметку её результат больше не идёт.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { resolveSubjectWithDerivedContext } from "@/modules/digital-profile/orion-golden/analytics/subject-context-miner";
import type { SubjectIdentity } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

const SUBJECT: SubjectIdentity = {
  displayName: "Егоров Алексей Евгеньевич",
  lastName: "Егоров",
  lastNameVariants: [],
  firstNames: ["Алексей"],
  patronymics: ["Евгеньевич"],
  aliases: [],
  strongIdentifiers: [],
  contextIdentifiers: ["арбитражный суд"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

let seq = 0;
const item = (title: string, snippet: string): RawInventoryItem => {
  seq += 1;
  return {
    inventoryId: `mine-${seq}`,
    caseId: "case-egorov",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-03T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet,
  } as RawInventoryItem;
};

describe("майнер контекста", () => {
  it("словарь тёзки в разметку не попадает", () => {
    const items = [
      item("Егоров Алексей Евгеньевич, офтальмолог", "профессор кафедры офтальмологии РНИМУ"),
      item("Егоров Алексей Евгеньевич — офтальмолог в Подольске", "профессор, доктор медицинских наук"),
    ];
    const out = resolveSubjectWithDerivedContext({
      caseId: "case-egorov",
      datasetId: "ds-1",
      subject: SUBJECT,
      items,
      sourceHashes: [],
    });
    expect(out.minedContext).toEqual([]);
    expect(out.effectiveContext).toEqual(["арбитражный суд"]);
    expect(out.skippedReason).toBe("mining_disabled");
  });
});
