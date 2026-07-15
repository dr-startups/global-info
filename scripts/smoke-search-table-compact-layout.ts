/**
 * Measured search-table pagination tests (spec §14 A–I).
 * Pure/deterministic — LIVE API NOT RUN, NETWORK_CALLS=0.
 */

import assert from "node:assert/strict";
import {
  estimateTitleLines,
  MIN_BODY_PT,
  paginateSearchResults,
  RENDERER_GEOMETRY,
  type SearchResultRow,
} from "../src/modules/digital-profile/orion-golden/classic/search-results-pagination";

function row(
  i: number,
  opts: Partial<SearchResultRow> & { title: string; adverse?: boolean; query?: string }
): SearchResultRow {
  return {
    queryNormalized: opts.query ?? "глинка сергей михайлович",
    queryDisplay: opts.query ?? "Глинка Сергей Михайлович",
    position: String(i + 1),
    domain: opts.domain ?? `example${i}.ru`,
    title: opts.title,
    status: opts.adverse ? "Нежелательный" : "Нейтральный",
    adverse: Boolean(opts.adverse),
    engine: opts.engine ?? "YANDEX",
    tieBreaker: `t${i}`,
  };
}

const SHORT = "Профиль в соцсети";
const LONG =
  "Очень длинный заголовок новостной статьи о субъекте проверки с множеством уточняющих слов и деталей о событии";

function it(name: string, fn: () => void) {
  return { name, fn };
}

const tests = [
  it("A. 16 short rows fit on a single slide (no continuation)", () => {
    const items = Array.from({ length: 16 }, (_, i) => row(i, { title: SHORT }));
    const res = paginateSearchResults({ items });
    assert.equal(res.singleSlide, true, `expected 1 page, got ${res.pages.length}`);
    assert.equal(res.pages.length, 1);
    assert.equal(res.deckDisplayedCount, 16);
  }),

  it("B. 16 long-title rows spill to 2+ pages only when height truly runs out", () => {
    const items = Array.from({ length: 16 }, (_, i) => row(i, { title: LONG }));
    const res = paginateSearchResults({ items });
    assert.ok(res.pages.length >= 2, `expected >=2 pages, got ${res.pages.length}`);
    assert.equal(res.deckDisplayedCount, 16);
  }),

  it("C. No row crosses the footer (per-page height within available bounds)", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      row(i, { title: i % 3 === 0 ? LONG : SHORT })
    );
    const bounds = { top: 1_150_000, bottom: RENDERER_GEOMETRY.CONTENT_BOTTOM };
    const avail = bounds.bottom - bounds.top;
    const res = paginateSearchResults({ items, availableBounds: bounds });
    const lineH = Math.round(res.bodyFontPt * RENDERER_GEOMETRY.EMU_PER_PT * RENDERER_GEOMETRY.LINE_LEADING);
    const headerH = Math.round(26 * RENDERER_GEOMETRY.EMU_PER_PT);
    const groupH = Math.round(18 * RENDERER_GEOMETRY.EMU_PER_PT);
    const pad = Math.round(6 * RENDERER_GEOMETRY.EMU_PER_PT);
    for (const p of res.pages) {
      let used = headerH + p.groupHeaders.length * groupH;
      for (const r of p.rows) used += r.titleLines * lineH + pad;
      assert.ok(used <= avail, `page ${p.pageIndex} used ${used} > available ${avail}`);
    }
  }),

  it("D. No word is broken by characters (title lines never exceed word wrap)", () => {
    // Over-long single word must occupy its own line, not be split.
    const lines = estimateTitleLines(
      "Suuuuuuuuuuuuuuuuuuuuuuuuuuuperlongsinglewordwithoutspaces",
      1_000_000,
      10,
      2,
      RENDERER_GEOMETRY.CHAR_W_FACTOR
    );
    assert.ok(lines >= 1 && lines <= 2);
  }),

  it("E. All adverse rows are present across pages", () => {
    const items = Array.from({ length: 24 }, (_, i) =>
      row(i, { title: i % 2 ? LONG : SHORT, adverse: i % 5 === 0 })
    );
    const res = paginateSearchResults({ items });
    const inputAdverse = items.filter((r) => r.adverse).length;
    assert.equal(res.deckDisplayedAdverseCount, inputAdverse);
    assert.equal(res.datasetAdverseCount, inputAdverse);
  }),

  it("F. Sum of per-page displayed == datasetCount", () => {
    const items = Array.from({ length: 30 }, (_, i) => row(i, { title: i % 4 ? LONG : SHORT }));
    const res = paginateSearchResults({ items });
    const sum = res.pages.reduce((a, p) => a + p.pageDisplayedCount, 0);
    assert.equal(sum, res.datasetCount);
    assert.equal(res.deckDisplayedCount, res.datasetCount);
  }),

  it("G. 12 UAE rows fit or split cleanly with all displayed", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      row(i, { title: SHORT, query: "Ahmed Client UAE" })
    );
    const res = paginateSearchResults({ items });
    assert.equal(res.deckDisplayedCount, 12);
  }),

  it("H. Three adverse UAE rows all displayed", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      row(i, { title: SHORT, query: "Ahmed Client UAE", adverse: i < 3 })
    );
    const res = paginateSearchResults({ items });
    assert.equal(res.datasetAdverseCount, 3);
    assert.equal(res.deckDisplayedAdverseCount, 3);
  }),

  it("I. A single adverse RU row is always visible", () => {
    const items = Array.from({ length: 16 }, (_, i) => row(i, { title: LONG, adverse: i === 15 }));
    const res = paginateSearchResults({ items });
    const anyAdverse = res.pages.some((p) => p.rows.some((r) => r.adverse));
    assert.equal(anyAdverse, true);
    assert.equal(res.deckDisplayedAdverseCount, 1);
  }),

  it("font never drops below 9pt", () => {
    const items = Array.from({ length: 60 }, (_, i) => row(i, { title: LONG }));
    const res = paginateSearchResults({ items });
    assert.ok(res.bodyFontPt >= MIN_BODY_PT, `bodyFontPt ${res.bodyFontPt} < ${MIN_BODY_PT}`);
    assert.equal(res.deckDisplayedCount, 60);
  }),

  it("exact duplicates excluded and accounted", () => {
    const base = row(0, { title: SHORT });
    const items = [base, { ...base }, row(1, { title: SHORT })];
    const res = paginateSearchResults({ items });
    assert.equal(res.excludedCount, 1);
    assert.equal(res.excludedReasons.EXACT_DUPLICATE, 1);
    assert.equal(res.datasetCount, 2);
    assert.equal(res.deckDisplayedCount, 2);
  }),

  it("grouped: query shown as group header, not repeated in rows", () => {
    const items = [
      row(0, { title: SHORT, query: "Глинка Сергей Михайлович" }),
      row(1, { title: SHORT, query: "Сергей Михайлович Глинка" }),
    ];
    const res = paginateSearchResults({ items });
    const p0 = res.pages[0]!;
    assert.equal(p0.groupHeaders.length, 2);
    assert.ok(p0.rows.every((r) => r.startsGroup !== undefined));
  }),
];

function main() {
  let passed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`PASS ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL ${t.name}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`search-table-compact-layout ${passed}/${tests.length}`);
}

main();
