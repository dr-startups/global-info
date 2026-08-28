/**
 * «Негативных: N» в таблице метрик региона и негативные строки на странице
 * региона — одно число, посчитанное одним предикатом.
 *
 * Таблица метрик берёт `adverseSubjectCount` у разбора поверхностей, а
 * страница считает строки сама (`composePageRowComposition` →
 * `resolveRowAdverse`). Пока это были два разных словаря, соседние листы
 * одного раздела говорили о материале разное: машинный ярлык `classification`
 * делал строку негативной в метрике и не делал в таблице выдачи.
 */

import { describe, expect, it } from "vitest";
import { runSurfaceAnalyzers } from "@/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import { composePageRowComposition } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const CASE_ID = "case-unit-regional-adverse";
const REF = "inventory:obs-1";

function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  return {
    inventoryId: "obs-1",
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

/** Число из таблицы метрик региона: «негативных: N». */
function metricCount(one: RawInventoryItem): number {
  const unit = runSurfaceAnalyzers({
    caseId: CASE_ID,
    datasetId: "ds-regional-adverse",
    items: [one],
    resolutionLookup: new Map<string, SubjectResolutionItem>([
      [REF, { evidenceRef: REF, decision: "SUBJECT_MATCH" } as SubjectResolutionItem],
    ]),
    sourceHashes: ["sha256:test"],
  }).organic.units[0]!;
  return Number(unit.metrics.find((m) => m.key === "adverseSubjectCount")?.value ?? -1);
}

/** Число, которое считает сама страница по своим строкам. */
function pageCount(one: RawInventoryItem): number {
  const scoped = {
    evidenceIndex: {
      [REF]: {
        title: one.title,
        url: one.sourceUrl,
        domain: one.sourceUrl ? new URL(one.sourceUrl).hostname : undefined,
        subjectDecision: "SUBJECT_MATCH",
      },
    },
  } as unknown as ScopedFragmentInput;
  return composePageRowComposition(scoped, [REF]).adverseHeadlines;
}

describe("метрика региона и страница региона считают негатив одним предикатом", () => {
  it("машинный ярлык не делает строку негативной ни там, ни там", () => {
    const labelled = item({
      title: "Умар Кремлев открыл спортивный центр в Москве",
      sourceUrl: "https://www.example-news.ru/kremlev-center",
      classification: "ADVERSE_MEDIA",
    });
    expect(metricCount(labelled)).toBe(0);
    expect(pageCount(labelled)).toBe(0);
  });

  it("настоящее слово негатива в заголовке считают оба", () => {
    const criminal = item({
      title: "Уголовное дело против Умара Кремлева",
      sourceUrl: "https://www.example-news.ru/kremlev-case",
    });
    expect(metricCount(criminal)).toBe(1);
    expect(pageCount(criminal)).toBe(1);
  });

  it("мягкая площадка одинаково слепа к жанровому слову", () => {
    const genre = item({
      title: "Умар Кремлев: биография, бизнес, скандалы",
      sourceUrl: "https://www.klerk.ru/buh/articles/kremlev/",
    });
    expect(metricCount(genre)).toBe(0);
    expect(pageCount(genre)).toBe(0);
  });
});
