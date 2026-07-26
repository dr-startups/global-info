/**
 * PDF review 36 — phases D (text fits whole) and E (design) — offline acceptance.
 * - D.1/D.2: sidebarSafe keeps whole sentences, never «…относящийся к.»
 * - D.4: statusLine is human phrasing, no «уверенность 90%»
 * - D.5: example titles join on whole-title boundaries; SERP suffixes cleaned;
 *        the §7.2 diff line lives only in the executive narrative (no bullet dupe)
 */

import { describe, expect, it } from "vitest";
import { sidebarSafe } from "../../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  cleanExampleTitle,
  joinTitlesWithinBudget,
} from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  applyExecutiveFreshnessChangeToPacks,
  statusLine,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";

describe("D.1/D.2 — sidebarSafe keeps whole sentences", () => {
  it("keeps as many complete sentences as fit the budget", () => {
    const text =
      "Первое предложение о субъекте. Второе предложение с деталями анализа. Третье предложение, которое уже не влезает в бюджет панели.";
    const out = sidebarSafe(text, 75);
    expect(out).toBe("Первое предложение о субъекте. Второе предложение с деталями анализа.");
  });

  it("never leaves a dangling participle/preposition when the first sentence is over budget", () => {
    const text =
      "По этому блоку нет подтверждённых риск-сигналов: в панели знаний зафиксирован один результат, относящийся к проверяемому лицу и его окружению без негативного контекста.";
    const out = sidebarSafe(text, 110);
    expect(out).toBeDefined();
    expect(out!).toMatch(/[.!?]$/u);
    expect(out!).not.toMatch(/\s(?:к|относящийся|и|с|в|о)\.$/iu);
  });

  it("returns short text unchanged", () => {
    expect(sidebarSafe("Коротко и ясно.", 240)).toBe("Коротко и ясно.");
  });
});

describe("D.4 — statusLine human phrasing", () => {
  it("no percent-style «уверенность 90%» telegraph", () => {
    const line = statusLine({
      confidence: 0.9,
      riskLevel: "critical",
    } as never);
    expect(line).not.toMatch(/уверенность \d+%/u);
    expect(line).toMatch(/тема подтверждена/u);
    expect(line).toMatch(/достоверность оценки высокая/u);
  });

  it("preliminary signal below 0.7 confidence", () => {
    const line = statusLine({ confidence: 0.5, riskLevel: "medium" } as never);
    expect(line).toMatch(/сигнал предварительный/u);
    expect(line).toMatch(/оценка требует подтверждения/u);
  });
});

describe("D.5 — example titles cut on whole-title boundaries", () => {
  it("cleanExampleTitle strips SERP source suffix, timestamps and broken ellipsis tails", () => {
    expect(cleanExampleTitle("Самый говорливый олигарх. Как Дерипаска из-под… | Дзен")).toBe(
      "Самый говорливый олигарх."
    );
    expect(cleanExampleTitle("Интервью и вокруг него - 03.12.25 22:27")).toBe(
      "Интервью и вокруг него"
    );
    expect(cleanExampleTitle("Обычный заголовок без мусора")).toBe(
      "Обычный заголовок без мусора"
    );
  });

  it("joinTitlesWithinBudget never cuts mid-title", () => {
    const titles = ["Первый заголовок статьи", "Второй заголовок подлиннее", "Третий заголовок"];
    const joined = joinTitlesWithinBudget(titles, 52);
    expect(joined).toBe("Первый заголовок статьи · Второй заголовок подлиннее");
    const tight = joinTitlesWithinBudget(titles, 30);
    expect(tight).toBe("Первый заголовок статьи");
  });
});

describe("D.5 — §7.2 diff line only in the executive narrative", () => {
  const extras = {
    materialFreshness: null,
    reportDiff: { addedCount: 610, removedCount: 46, previousJobId: "j-1" },
  } as never;

  it("continuation bullets carry no diff-line duplicate", () => {
    const packs = [
      {
        fragmentKey: "EXECUTIVE_SUMMARY",
        slides: [
          {
            isContinuation: false,
            content: { narrative: "Основной вывод по субъекту." },
          },
          {
            isContinuation: true,
            content: {
              bullets: [
                "Новых материалов с прошлого отчёта: 610, ушло из выдачи: 46",
                "Обычный факт о субъекте.",
              ],
            },
          },
        ],
      },
    ];
    const [out] = applyExecutiveFreshnessChangeToPacks(packs as never, extras);
    const base = out.slides[0];
    const cont = out.slides[1];
    expect(String(base.content.narrative)).toMatch(/Новых материалов с прошлого отчёта/u);
    expect(cont.content.bullets).toEqual(["Обычный факт о субъекте."]);
  });
});
