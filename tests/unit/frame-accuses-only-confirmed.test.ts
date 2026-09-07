/**
 * Красная рамка — обвинение, и оно относится к человеку.
 *
 * Отчёт 86: `rupep.org/en/person/12041` напечатан в таблице выдачи как «О
 * другом лице» (стр. 45) и обведён красной рамкой на снимке ОАЭ (стр. 50);
 * `opensanctions.org` с записью «Alexey FILATOV», в тексте которой нет ни
 * имени, ни фамилии субъекта, — в рамке «Санкционный контур»; страница
 * режиссёра-однофамильца с `afisha.ru` — в рамке «Потенциально негативные
 * публикации». Девять рамок из тринадцати стояли на материале, чья
 * принадлежность не подтверждена, а две — на материале, который отчёт страницей
 * раньше сам назвал чужим. Отчёт читает субъект, и это обвинения в его адрес.
 *
 * Правило: обвинение печатается только о материале с решением `SUBJECT_MATCH`.
 * Строка при этом не исчезает — она рисуется нейтральной, а признак негативной
 * формулировки записывается, чтобы страница сказала о ней словами.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { buildSyntheticSerpViewModelFromObservations } from "@/modules/digital-profile/serp-observation/synthetic-asset";
import {
  claimAgainstSubject,
  subjectConfirmedForClaim,
} from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { PersistedSerpObservation } from "@/modules/digital-profile/serp-observation/types";

const SUBJECT = "Сергей Михайлович Глинка";

function item(over: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: SUBJECT,
    collectedAt: "2026-08-01T00:00:00.000Z",
    evidenceType: "serp_result",
    title: "Материал",
    snippet: "",
    sourceUrl: "https://example.org/a",
    rawMetadata: { engine: "GOOGLE", surface: "organic", provider: "serper" },
    ...over,
  } as RawInventoryItem;
}

/** Негативная строка о самом субъекте: рамка её законна. */
const confirmedRow = item({
  inventoryId: "confirmed",
  title: "Уголовное дело: арест по делу о мошенничестве",
  sourceUrl: "https://kriminal-vestnik.ru/news/12",
});
/** Негативная строка, принадлежность которой не подтверждена. */
const unconfirmedRow = item({
  inventoryId: "unconfirmed",
  title: "Санкционный список: активы заморожены",
  sourceUrl: "https://sanctions-tracker.example/ru/1",
});
/** Негативная строка, которую отчёт сам называет чужой. */
const otherRow = item({
  inventoryId: "other",
  title: "Уголовное дело о взятке: обвинительный приговор",
  sourceUrl: "https://gorod-news.ru/crime/77",
});

const items = [confirmedRow, unconfirmedRow, otherRow];

const decisions: Record<string, string> = {
  "inventory:confirmed": "SUBJECT_MATCH",
  "inventory:unconfirmed": "AMBIGUOUS",
  "inventory:other": "OTHER_SUBJECT",
};

async function visibleRows(subjectDecisionByRef?: Record<string, string>) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: SUBJECT,
    items,
    allowImagePreviewNetwork: false,
    ...(subjectDecisionByRef ? { subjectDecisionByRef } : {}),
  });
  const rows = (visuals.visualAssets.p10_ru_serp_visual ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  return new Map(rows.map((r) => [r.ref, r]));
}

describe("рамка обвиняет только подтверждённый материал", () => {
  it("подтверждена принадлежность только у решения SUBJECT_MATCH", () => {
    expect(subjectConfirmedForClaim("SUBJECT_MATCH")).toBe(true);
    expect(subjectConfirmedForClaim("LIKELY_SUBJECT")).toBe(false);
    expect(subjectConfirmedForClaim("AMBIGUOUS")).toBe(false);
    expect(subjectConfirmedForClaim("INSUFFICIENT_IDENTIFIERS")).toBe(false);
    expect(subjectConfirmedForClaim("OTHER_SUBJECT")).toBe(false);
    // Молчание подтверждением не является.
    expect(subjectConfirmedForClaim(undefined)).toBe(false);
  });

  it("снятая рамка оставляет след: формулировка была негативной", () => {
    expect(claimAgainstSubject({ adverse: true, subjectDecision: "SUBJECT_MATCH" })).toEqual({
      adverse: true,
      adverseWording: false,
    });
    expect(claimAgainstSubject({ adverse: true, subjectDecision: "AMBIGUOUS" })).toEqual({
      adverse: false,
      adverseWording: true,
    });
    // Ненегативная строка следа не оставляет: терять нечего.
    expect(claimAgainstSubject({ adverse: false, subjectDecision: "AMBIGUOUS" })).toEqual({
      adverse: false,
      adverseWording: false,
    });
  });

  it("на снимке выдачи рамку получает только подтверждённая строка", async () => {
    const withoutDecisions = await visibleRows();
    // Без решений о принадлежности всё как раньше: судит словарь.
    expect(withoutDecisions.get("inventory:unconfirmed")?.adverse).toBe(true);

    const rows = await visibleRows(decisions);
    expect(rows.get("inventory:confirmed")?.adverse).toBe(true);
    expect(rows.get("inventory:unconfirmed")?.adverse).toBe(false);
    expect(rows.get("inventory:other")?.adverse).toBe(false);
  });

  it("строка не исчезает: она нарисована и названа негативной по формулировке", async () => {
    const rows = await visibleRows(decisions);
    expect(rows.has("inventory:unconfirmed")).toBe(true);
    expect(rows.get("inventory:unconfirmed")?.adverseWording).toBe(true);
    expect(rows.get("inventory:other")?.adverseWording).toBe(true);
    expect(rows.get("inventory:confirmed")?.adverseWording).toBeUndefined();
  });

  it("картинка снимка не рисует рамку неподтверждённой строке", () => {
    const observations = items.map((it, i) => observation(it, i + 1));
    const before = buildSyntheticSerpViewModelFromObservations({
      observations,
      subjectName: SUBJECT,
      queryText: SUBJECT,
    });
    const framedBefore = framedRows(before);
    expect(framedBefore.length).toBeGreaterThan(1);

    const vm = buildSyntheticSerpViewModelFromObservations({
      observations,
      subjectName: SUBJECT,
      queryText: SUBJECT,
      subjectDecisionByRef: decisions,
    });
    const framed = framedRows(vm);
    expect(framed).toHaveLength(1);
    expect(framed[0]?.url).toContain("kriminal-vestnik.ru");
  });
});

/** Строки обеих колонок снимка, обведённые рамкой. */
function framedRows(vm: {
  engines: { yandex: { results: Array<{ isHighlighted?: boolean; url: string }> }; google: { results: Array<{ isHighlighted?: boolean; url: string }> } };
}): Array<{ isHighlighted?: boolean; url: string }> {
  return [...vm.engines.yandex.results, ...vm.engines.google.results].filter(
    (r) => r.isHighlighted
  );
}

function observation(it: RawInventoryItem, rank: number): PersistedSerpObservation {
  return {
    id: `inventory:${it.inventoryId}`,
    searchDocumentId: null,
    caseId: it.caseId,
    auditRunId: it.reportRunId,
    queryId: "composite",
    queryText: it.query ?? "",
    provider: "serper",
    engine: "GOOGLE",
    surface: "organic",
    region: "RU",
    language: "ru",
    rank,
    url: it.sourceUrl ?? "",
    title: it.title ?? null,
    snippet: it.snippet ?? null,
    domain: new URL(it.sourceUrl!).hostname,
    providerStatus: "OK",
    capturedAt: new Date(0),
  } as unknown as PersistedSerpObservation;
}
