/**
 * Таблица движка показывает основной запрос раздела, когда у движка есть по нему строки (шаг 0147).
 *
 * Стр. 24 отчёта Мельниченко (DPA-2026-0075, 22.09.2026): «Основной запрос
 * этого раздела — «Мельниченко Андрей Игоревич»; у этого поисковика по нему в
 * наборе нет ни одной строки, поэтому таблица показывает другой запрос». В
 * наборе было девять строк Google по этому запросу. Пометку «это само имя»
 * несли только строки Яндекса, запрос таблицы Google выбирался по её
 * собственным строкам счётом материалов — у «Мельниченко Андрей» их было
 * десять, — а фраза печаталась по одному признаку «показан другой запрос», без
 * сверки с наблюдениями.
 *
 * Основной запрос — свойство раздела, а не движка. Есть у движка строки по
 * нему — таблица строится на нём. Нет — таблица показывает другой запрос, и
 * тогда фраза верна по построению.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const MAIN = "Мельниченко Андрей Игоревич";
const SHORT = "Мельниченко Андрей";

type Row = { url: string; query: string; engine: "YANDEX" | "GOOGLE"; rank: number; marked?: boolean };

function scoped(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `i${i + 1}`;
    evidenceIndex[ref] = {
      title: `Материал ${new URL(row.url).hostname}`,
      url: row.url,
      domain: new URL(row.url).hostname,
      region: "RU",
      engine: row.engine,
      rank: row.rank,
      rankSource: row.engine === "GOOGLE" ? "serper" : "yandex",
      query: row.query,
      queryPurpose: "subject_lookup",
      ...(row.marked ? { subjectNameQuery: true } : {}),
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  });
  return {
    findings: [],
    surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

const googleMainPages = (rows: Row[]): SlideContentContract[] =>
  buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped(rows)).slides.filter(
    (s) => s.metrics?.serpExtraQueries !== 1 && s.metrics?.serpEngine === "GOOGLE"
  );

/** Набор прогона Мельниченко в миниатюре: у Google дополнительный запрос богаче основного. */
function melnichenkoShape(): Row[] {
  return [
    ...[1, 2, 3, 4, 5].map((rank) => ({ url: `https://y-${rank}.ru/a`, query: MAIN, engine: "YANDEX" as const, rank, marked: true })),
    ...[1, 2, 3].map((rank) => ({ url: `https://g-main-${rank}.ru/a`, query: MAIN, engine: "GOOGLE" as const, rank })),
    ...[10, 11, 12, 13].map((rank) => ({ url: `https://g-short-${rank}.ru/a`, query: SHORT, engine: "GOOGLE" as const, rank })),
  ];
}

describe("таблица движка — основной запрос раздела", () => {
  it("О1: у Google есть строки основного запроса — таблица на нём, без оговорки", () => {
    const pages = googleMainPages(melnichenkoShape());
    expect(pages.length).toBeGreaterThan(0);
    const text = pages.map((p) => String(p.content.narrative ?? "")).join(" ");
    expect(text).toContain(`по запросу «${MAIN}»`);
    expect(text).not.toContain("нет ни одной строки");
  });

  it("О2: строки таблицы — строки основного запроса", () => {
    const cells = googleMainPages(melnichenkoShape()).flatMap((p) => (p.content.table?.rows ?? []).map((r) => r.join(" ")));
    expect(cells.some((c) => c.includes("g-main-1.ru"))).toBe(true);
    expect(cells.some((c) => c.includes("g-short-10.ru"))).toBe(false);
  });

  it("О3: у Google нет ни одной строки основного запроса — оговорка печатается", () => {
    const rows = melnichenkoShape().filter((r) => !(r.engine === "GOOGLE" && r.query === MAIN));
    const text = googleMainPages(rows).map((p) => String(p.content.narrative ?? "")).join(" ");
    expect(text).toContain(`Основной запрос этого раздела — «${MAIN}»; у этого поисковика по нему в наборе нет ни одной строки`);
  });
});
