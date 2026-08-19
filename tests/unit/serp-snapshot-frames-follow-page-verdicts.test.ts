/**
 * Рамка и легенда снимка выдачи следуют решению по прочитанной странице.
 *
 * До шага на один вопрос «негативна ли строка» отвечали дважды: дека —
 * решением по прочитанной странице, снимок выдачи — словарём слов в
 * заголовке. Ответы расходились на одном листе: страница, признанная по тексту
 * нейтральной, оставалась в красной рамке, а честная фраза рядом говорила
 * обратное. Второй ответ удалён — словарь остаётся фолбэком для строк, чью
 * страницу не читали.
 *
 * Легенда снимка при этом говорит на языке резюме: кластерными ярлыками
 * сюжетов, а не рубриками справочника.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { buildSyntheticSerpViewModelFromObservations } from "@/modules/digital-profile/serp-observation/synthetic-asset";
import type { ObservationVerdictByRef } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
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

/** Строка, которую словарь считает негативной по слову в заголовке. */
const dictionaryHit = item({
  inventoryId: "dict-hit",
  title: "Санкционный список: активы заморожены",
  sourceUrl: "https://vedomosti-region.ru/sanctions/1",
});
/** Строка, о которой словарь молчит: ни слова, ни домена из списка. */
const quietRow = item({
  inventoryId: "quiet",
  title: "Отчёт о поставках оборудования за 2024 год",
  sourceUrl: "https://logistic-review.ru/reports/2024",
});
/** Строка о другом лице: словарь её выделяет, решение — нет. */
const namesakeRow = item({
  inventoryId: "namesake",
  title: "Уголовное дело в отношении однофамильца",
  sourceUrl: "https://gorod-news.ru/crime/77",
});
/** Строка без решения вовсе: страницу не читали, работает словарь. */
const unreadRow = item({
  inventoryId: "unread",
  title: "Арест по делу о мошенничестве",
  sourceUrl: "https://kriminal-vestnik.ru/news/12",
});

const verdicts: ObservationVerdictByRef = {
  "inventory:dict-hit": { tone: "neutral", quoted: true, subjectMatch: "subject" },
  "inventory:quiet": {
    tone: "adverse",
    quoted: true,
    subjectMatch: "subject",
    themeLabel: "Санкции, санкционные суды и заморозка активов",
  },
  "inventory:namesake": { tone: "adverse", quoted: true, subjectMatch: "other" },
};

const items = [dictionaryHit, quietRow, namesakeRow, unreadRow];

async function visibleRows(verdictByRef?: ObservationVerdictByRef) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: SUBJECT,
    items,
    allowImagePreviewNetwork: false,
    verdictByRef,
  });
  const rows = (visuals.visualAssets.p10_ru_serp_visual ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  return new Map(rows.map((r) => [r.ref, r]));
}

describe("рамка на снимке следует решению по прочитанной странице", () => {
  it("прочитанная нейтральной строка теряет рамку, хотя словарь её выделял", async () => {
    const withoutVerdicts = await visibleRows();
    expect(withoutVerdicts.get("inventory:dict-hit")?.adverse).toBe(true);

    const rows = await visibleRows(verdicts);
    expect(rows.get("inventory:dict-hit")?.adverse).toBe(false);
  });

  it("нежелательная по тексту страница получает рамку, хотя словарь молчал", async () => {
    const withoutVerdicts = await visibleRows();
    expect(withoutVerdicts.get("inventory:quiet")?.adverse).toBe(false);

    const rows = await visibleRows(verdicts);
    expect(rows.get("inventory:quiet")?.adverse).toBe(true);
  });

  it("строка о другом лице рисуется, но без рамки", async () => {
    const rows = await visibleRows(verdicts);
    expect(rows.has("inventory:namesake")).toBe(true);
    expect(rows.get("inventory:namesake")?.adverse).toBe(false);
  });

  it("строка без решения остаётся на словаре", async () => {
    const rows = await visibleRows(verdicts);
    expect(rows.get("inventory:unread")?.adverse).toBe(true);
  });
});

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

describe("легенда снимка говорит сюжетами прочитанных страниц", () => {
  const observations = items.map((it, i) => observation(it, i + 1));

  it("прочитанная рамочная строка получает в легенде кластерный ярлык", () => {
    const vm = buildSyntheticSerpViewModelFromObservations({
      observations,
      subjectName: SUBJECT,
      queryText: SUBJECT,
      verdictByRef: verdicts,
    });
    const titles = vm.themes.map((t) => t.title);
    expect(titles).toContain("Санкции, санкционные суды и заморозка активов");
  });

  it("непрочитанная рамочная строка остаётся под словарной рубрикой", () => {
    const vm = buildSyntheticSerpViewModelFromObservations({
      observations,
      subjectName: SUBJECT,
      queryText: SUBJECT,
      verdictByRef: verdicts,
    });
    const titles = vm.themes.map((t) => t.title);
    expect(titles).toContain("Криминальные / судебные материалы");
  });

  it("число тем в легенде сходится с числом рамок", () => {
    const vm = buildSyntheticSerpViewModelFromObservations({
      observations,
      subjectName: SUBJECT,
      queryText: SUBJECT,
      verdictByRef: verdicts,
    });
    const framed = vm.themes.reduce((n, t) => n + t.count, 0);
    // Рамок ровно две: прочитанная нежелательная и непрочитанная словарная.
    expect(framed).toBe(2);
    expect(vm.noNegatives).toBe(false);
  });
});
