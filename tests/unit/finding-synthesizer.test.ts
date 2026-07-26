/**
 * Ported from smoke-orion-analytics-pipeline §3.2 — uncategorized materials.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";

const CASE_ID = "case-unit-finding-synth";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE_ID,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const GLINKA_SUBJECT: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey", "sergei"],
  patronymics: ["Михайлович"],
  aliases: ["Глинка Сергей Михайлович"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен", "транспорт"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: ["композитор", "опера"],
};

describe("finding-synthesizer uncategorized (§3.2)", () => {
  it("SUBJECT_MATCH/LIKELY without theme → uncategorized, not a finding", () => {
    const themed = item({
      title: "Уголовное дело бизнесмена Сергея Глинки: суд и следствие",
      sourceUrl: "https://news.example/criminal",
      region: "RU",
    });
    const neutral = item({
      title: "Сергей Глинка посетил выставку в Москве",
      sourceUrl: "https://news.example/exhibit",
      region: "RU",
    });
    const likelyNeutral = item({
      title: "Глинка выступил с комментарием на форуме в Дубае",
      sourceUrl: "https://uae.example/forum",
      region: "UAE",
    });
    const items = [themed, neutral, likelyNeutral];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-uncat",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    byRef.set(`inventory:${themed.inventoryId}`, {
      ...byRef.get(`inventory:${themed.inventoryId}`)!,
      decision: "SUBJECT_MATCH",
    });
    byRef.set(`inventory:${neutral.inventoryId}`, {
      ...byRef.get(`inventory:${neutral.inventoryId}`)!,
      decision: "SUBJECT_MATCH",
    });
    byRef.set(`inventory:${likelyNeutral.inventoryId}`, {
      ...byRef.get(`inventory:${likelyNeutral.inventoryId}`)!,
      decision: "LIKELY_SUBJECT",
    });

    const result = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-uncat",
      items,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });

    expect(result.stats.uncategorizedCount).toBeGreaterThanOrEqual(2);
    expect(result.uncategorized.count).toBe(result.stats.uncategorizedCount);

    const uncatRefs = new Set(result.uncategorized.topExamples.map((e) => e.evidenceRef));
    expect(uncatRefs.has(`inventory:${neutral.inventoryId}`)).toBe(true);
    expect(uncatRefs.has(`inventory:${likelyNeutral.inventoryId}`)).toBe(true);
    expect(uncatRefs.has(`inventory:${themed.inventoryId}`)).toBe(false);

    const allFindings = [...result.bundle.findings, ...result.ambiguousFindings];
    for (const f of allFindings) {
      expect(f.evidenceRefs).not.toContain(`inventory:${neutral.inventoryId}`);
      expect(f.evidenceRefs).not.toContain(`inventory:${likelyNeutral.inventoryId}`);
    }
    expect(allFindings.some((f) => f.findingId.includes("criminal_legal"))).toBe(true);
  });
});
