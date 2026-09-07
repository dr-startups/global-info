/**
 * Решение аналитика принадлежит материалу, а не наблюдению.
 *
 * Ключ наблюдения включает запрос, поэтому одна страница, найденная четырьмя
 * запросами, лежит в наборе четырьмя ссылками. На бандле отчёта 86 у пяти
 * материалов наблюдения одного адреса получили **разные** машинные решения
 * (`pro-sud-123.ru` — и «дата рождения», и «смешанные признаки»). Решение,
 * легшее на одну ссылку, оставило бы остальные как были: строка таблицы,
 * рамка снимка и плитка сетки берут ответ по своим ссылкам и разошлись бы.
 *
 * Это то же правило, по которому уже раскладываются решения по прочитанным
 * страницам и правки классического контура (`applyAnalystDecisionsToEvidence`).
 */

import { describe, expect, it } from "vitest";
import { applyAnalystOverrides } from "@/modules/digital-profile/services/analyst-overrides-loader";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type {
  SubjectResolution,
  SubjectResolutionItem,
} from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const URL = "https://zakrasnodar.ru/art/villa.html";
/** Ключ материала: тот же, которым лист проверки считает пункты. */
const KEY = "url:zakrasnodar.ru/art/villa.html";

function item(id: string, url = URL): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Егоров Алексей Евгеньевич",
    collectedAt: "2026-09-01T00:00:00.000Z",
    evidenceType: "serp_result",
    title: "На мысе Агрия образовалась вилла матери судьи",
    snippet: "",
    sourceUrl: url,
    rawMetadata: { engine: "GOOGLE", surface: "organic", provider: "serper" },
  } as unknown as RawInventoryItem;
}

function resolution(items: RawInventoryItem[], decisions: string[]): SubjectResolution {
  return {
    schemaVersion: "subject-resolution-v2",
    caseId: "case-1",
    datasetId: "ds",
    sourceHashes: [],
    evidenceRefs: [],
    subjectDisplayName: "Егоров Алексей Евгеньевич",
    items: items.map((it, i) => ({
      evidenceRef: `inventory:${it.inventoryId}`,
      decision: decisions[i] ?? "AMBIGUOUS",
      confidence: 0.45,
      matchedIdentifiers: [],
      conflictingIdentifiers: [],
      reasonCode: "surname_query_no_anchor",
    })) as SubjectResolutionItem[],
  } as SubjectResolution;
}

function applyOne(
  status: string,
  decisionKind = "belonging"
): {
  items: RawInventoryItem[];
  subjectResolution: SubjectResolution;
  applied: Array<{ kind: string; inventoryId?: string }>;
} {
  // Три наблюдения одного адреса плюс чужой материал, которого решение не касается.
  const items = [item("obs-a"), item("obs-b"), item("obs-c"), item("obs-x", "https://other.ru/1")];
  const subjectResolution = resolution(items, [
    "AMBIGUOUS",
    "AMBIGUOUS",
    "OTHER_SUBJECT",
    "AMBIGUOUS",
  ]);
  const resolutionByRef = new Map(subjectResolution.items.map((i) => [i.evidenceRef, i]));
  const { applied } = applyAnalystOverrides({
    items,
    resolutionByRef,
    subjectResolution,
    overrides: {
      version: "analyst-overrides-v1",
      caseId: "case-1",
      classification: [],
      manualReview: [],
      approvedFindings: [],
      reviewDecisions: [
        { itemKind: "evidence", itemKey: KEY, decisionKind, status, source: "review_decision" },
      ],
    },
  });
  return { items, subjectResolution, applied };
}

const decisionOf = (r: SubjectResolution, id: string): SubjectResolutionItem | undefined =>
  r.items.find((i) => i.evidenceRef === `inventory:${id}`);

describe("решение аналитика по материалу", () => {
  it("подтверждение закрывает все наблюдения одного адреса", () => {
    const { subjectResolution } = applyOne("CONFIRMED_SUBJECT");
    for (const id of ["obs-a", "obs-b", "obs-c"]) {
      expect(decisionOf(subjectResolution, id)?.decision).toBe("SUBJECT_MATCH");
      expect(decisionOf(subjectResolution, id)?.reasonCode).toBe("analyst_confirmed");
    }
    // Чужой материал решение не трогает.
    expect(decisionOf(subjectResolution, "obs-x")?.decision).toBe("AMBIGUOUS");
  });

  it("«это другой человек» доезжает тем же путём", () => {
    const { subjectResolution } = applyOne("OTHER_SUBJECT");
    expect(decisionOf(subjectResolution, "obs-a")?.decision).toBe("OTHER_SUBJECT");
    expect(decisionOf(subjectResolution, "obs-a")?.reasonCode).toBe("analyst_other_subject");
  });

  it("решение о негативе метит материал, а принадлежность не трогает", () => {
    const neutral = applyOne("NEUTRAL", "adverse");
    expect(neutral.items[0]!.classification).toBe("neutral");
    expect(decisionOf(neutral.subjectResolution, "obs-a")?.decision).toBe("AMBIGUOUS");

    const adverse = applyOne("ADVERSE", "adverse");
    expect(adverse.items[0]!.classification).toBe("adverse_media");
    expect(adverse.items[1]!.classification).toBe("adverse_media");
    expect(adverse.items[3]!.classification).not.toBe("adverse_media");
  });

  it("каждое применение записано в журнал правок поимённо", () => {
    const { applied } = applyOne("CONFIRMED_SUBJECT");
    const confirmed = applied.filter((a) => a.kind === "review_confirmed_subject");
    expect(confirmed.map((a) => a.inventoryId).sort()).toEqual(["obs-a", "obs-b", "obs-c"]);
  });

  it("снятое решение ничего не меняет", () => {
    const { subjectResolution, applied } = applyOne("CLEARED");
    expect(decisionOf(subjectResolution, "obs-a")?.decision).toBe("AMBIGUOUS");
    expect(applied).toHaveLength(0);
  });
});
