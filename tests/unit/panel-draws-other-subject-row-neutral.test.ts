/**
 * Панель рисует то, что говорит текст страницы.
 *
 * Строка о другом человеке печатается — панель воспроизводит то, что показывает
 * поисковик, — но без красной рамки и с тегом принадлежности: иначе заголовок
 * «3 негативные формулировки» спорил бы с четырьмя красными рамками на той же
 * картинке.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const OWN_SANCTIONS = "viktor rashnikov ofac";
const FOREIGN_SANCTIONS = "viktor feliksovich vekselberg ofac";

function suggestion(id: string, title: string): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: "case-unit-panel-ownership",
    reportRunId: "run-1",
    source: "arsenkin",
    provider: "arsenkin",
    region: "UAE",
    query: "viktor rashnikov",
    collectedAt: "2026-08-01T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet: "",
    sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(title)}`,
    rawMetadata: { engine: "ARSENKIN", surface: "autocomplete", provider: "arsenkin" },
  } as RawInventoryItem;
}

const ITEMS: RawInventoryItem[] = [
  suggestion("uae-own", OWN_SANCTIONS),
  suggestion("uae-foreign", FOREIGN_SANCTIONS),
];

async function panelRows(subjectDecisionByRef?: Record<string, string>) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: "Виктор Филиппович Рашников",
    items: ITEMS,
    fetchImagePreviews: false,
    ...(subjectDecisionByRef ? { subjectDecisionByRef } : {}),
  });
  const rows = visuals.visualAssets.p28_uae_suggestions?.[0]?.visibleItems ?? [];
  return JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
}

describe("панель знает о принадлежности строки", () => {
  it("чужая негативная строка уходит на панель нейтральной и с решением в записи", async () => {
    const rows = await panelRows({
      "inventory:uae-own": "SUBJECT_MATCH",
      "inventory:uae-foreign": "OTHER_SUBJECT",
    });
    const foreign = rows.find((r) => r.title === FOREIGN_SANCTIONS)!;
    expect(foreign.adverse).toBe(false);
    expect(foreign.subjectDecision).toBe("OTHER_SUBJECT");
  });

  it("снятая рамка не теряет негативную формулировку", async () => {
    // Иначе страница не смогла бы сказать словами, что именно исключено из
    // счёта, — исключение выглядело бы как молча пропавшая строка.
    const rows = await panelRows({ "inventory:uae-foreign": "OTHER_SUBJECT" });
    const foreign = rows.find((r) => r.title === FOREIGN_SANCTIONS)!;
    expect(foreign.adverseWording).toBe(true);
  });

  it("своя негативная строка остаётся красной", async () => {
    const rows = await panelRows({
      "inventory:uae-own": "SUBJECT_MATCH",
      "inventory:uae-foreign": "OTHER_SUBJECT",
    });
    const own = rows.find((r) => r.title === OWN_SANCTIONS)!;
    expect(own.adverse).toBe(true);
    expect(own.subjectDecision).toBe("SUBJECT_MATCH");
  });

  it("без карты решений вывод прежний", async () => {
    const rows = await panelRows();
    expect(rows.map((r) => r.adverse)).toEqual([true, true]);
    for (const row of rows) expect(row).not.toHaveProperty("subjectDecision");
  });
});
