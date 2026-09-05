/**
 * Снимок выдачи красит строки теми же словами, что и счёт страницы.
 *
 * Правки шага 0057 доехали до счёта, но не до картинки: сайдбар страницы
 * снимка считает негатив по маске признаков субъекта, а рамки и легенда тем на
 * самом снимке рисуются прежним словарём. Ответ на «негативна ли строка» на
 * одной странице обязан быть один.
 */

import { describe, expect, it } from "vitest";
import { selectVisibleObservationsForEngine } from "@/modules/digital-profile/serp-observation/synthetic-asset";
import { buildObservationThemeGrouping } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import { buildSubjectContextMask } from "@/modules/digital-profile/config/subject-context-words";
import type { PersistedSerpObservation } from "@/modules/digital-profile/serp-observation/types";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

const ANCHORS: SubjectAnchors = {
  birthDate: null,
  phrases: [
    { kind: "employer", text: "Арбитражный Суд Краснодарского края", strong: true },
    { kind: "position", text: "председатель Арбитражного суда Краснодарского края", strong: true },
  ],
  inn: [],
  domains: [],
};
const MASK = buildSubjectContextMask(ANCHORS);

function obs(i: number, title: string, url: string): PersistedSerpObservation {
  return {
    id: `obs-${i}`,
    engine: "GOOGLE",
    rank: i + 1,
    title,
    url,
    domain: new URL(url).hostname,
    snippet: title,
    region: "RU",
    language: "ru",
    provider: "serper",
    capturedAt: "2026-09-05T12:00:00.000Z",
  } as unknown as PersistedSerpObservation;
}

const JUDGE = obs(0, "Судья Егоров Алексей Евгеньевич на портале Право.ру", "https://pravo.ru/judge/1465/");
const CORRUPTION = obs(
  1,
  "Проверят председателя суда на коррупционность",
  "https://zakrasnodar.ru/art/proveryat_6195.html"
);

describe("снимок выдачи следует маске признаков субъекта", () => {
  it("строка со словами должности не выделяется и темы не заводит", () => {
    const withoutMask = buildObservationThemeGrouping([JUDGE], "ru");
    expect(withoutMask.loaded[0]?.isHighlighted).toBe(true);
    expect(withoutMask.grouping.themes.length).toBeGreaterThan(0);

    const withMask = buildObservationThemeGrouping([JUDGE], "ru", undefined, MASK);
    expect(withMask.loaded[0]?.isHighlighted).toBe(false);
    expect(withMask.grouping.themes).toEqual([]);
  });

  it("настоящий негатив маской не снимается", () => {
    const { loaded } = buildObservationThemeGrouping([CORRUPTION], "ru", undefined, MASK);
    expect(loaded[0]?.isHighlighted).toBe(true);
  });

  it("порядок строк снимка тоже считается по маске", () => {
    const rows = [JUDGE, CORRUPTION];
    // Без маски «негативными» считаются обе, и порядок — по позиции.
    expect(
      selectVisibleObservationsForEngine(rows, "GOOGLE", 5).map((o) => o.id)
    ).toEqual(["obs-0", "obs-1"]);
    // С маской вперёд выходит единственная негативная строка.
    expect(
      selectVisibleObservationsForEngine(rows, "GOOGLE", 5, undefined, MASK).map((o) => o.id)
    ).toEqual(["obs-1", "obs-0"]);
  });
});
