import { describe, expect, it } from "vitest";
import {
  applyThemeGroups,
  clusterVerdictThemes,
  themesForClustering,
  summarizeThemesWithLabels,
} from "@/modules/digital-profile/orion-golden/analytics/link-theme-clustering";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

function verdict(theme: string, tone: "adverse" | "neutral", i: number): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    evidenceRef: `inventory:${i}`,
    url: `https://s${i}.ru/`,
    rank: i,
    subjectMatch: "subject",
    tone,
    theme,
    quotes: tone === "adverse" ? [{ text: "основание для вывода из текста" }] : [],
    readAt: "2026-08-14T09:00:00.000Z",
  };
}

/** Живая картина прогона: восемь способов сказать одно и то же. */
const LIVE = [
  verdict("Биография Киркорова с упоминанием скандалов", "adverse", 1),
  verdict("Биография певца с описанием скандальных инцидентов", "adverse", 2),
  verdict("Биография и скандалы в карьере Филиппа Киркорова", "adverse", 3),
  verdict("Бизнес-активы Киркорова, долги и убытки его компаний", "adverse", 4),
  verdict("Бизнес-активы Киркорова, долги и убытки компаний", "adverse", 5),
  verdict("Дети Филиппа Киркорова и их публичная жизнь", "neutral", 6),
  verdict("Дети Филиппа Киркорова учатся в школе-пансионе", "neutral", 7),
  verdict("Интервью о карьере, сцене и семье", "neutral", 8),
];

describe("темы страниц перед группировкой", () => {
  it("считает публикации по каждой формулировке", () => {
    const themes = themesForClustering([
      verdict("Одна тема", "adverse", 1),
      verdict("Одна тема", "neutral", 2),
      verdict("Другая тема", "adverse", 3),
    ]);
    expect(themes).toHaveLength(2);
    expect(themes[0]).toMatchObject({ theme: "Одна тема", count: 2, adverseCount: 1 });
  });

  it("материал о другом человеке в группировку не идёт", () => {
    const other = { ...verdict("Приговор однофамильцу", "adverse", 1), subjectMatch: "other" as const };
    expect(themesForClustering([other])).toHaveLength(0);
  });
});

describe("применение групп", () => {
  const themes = themesForClustering(LIVE);

  it("суммы складываются, а не пересчитываются", () => {
    const grouped = applyThemeGroups({
      themes,
      groups: [
        { theme: "Скандалы в публичной карьере", members: [0, 1, 2] },
        { theme: "Финансовое положение бизнеса", members: [3, 4] },
        { theme: "Семья и дети", members: [5, 6] },
      ],
      verdicts: LIVE,
    });
    const adverseTotal = grouped.reduce((n, t) => n + t.adverseCount, 0);
    expect(adverseTotal).toBe(LIVE.filter((v) => v.tone === "adverse").length);
    expect(grouped.reduce((n, t) => n + t.count, 0)).toBe(LIVE.length);
  });

  it("не попавшая в группу тема остаётся собственной, а не исчезает", () => {
    const grouped = applyThemeGroups({
      themes,
      groups: [{ theme: "Скандалы в публичной карьере", members: [0, 1, 2] }],
      verdicts: LIVE,
    });
    expect(grouped.map((t) => t.theme)).toContain("Интервью о карьере, сцене и семье");
    expect(grouped.reduce((n, t) => n + t.count, 0)).toBe(LIVE.length);
  });

  it("одна тема не попадает в две группы", () => {
    const grouped = applyThemeGroups({
      themes,
      groups: [
        { theme: "Первая", members: [0, 1] },
        { theme: "Вторая", members: [1, 2] },
      ],
      verdicts: LIVE,
    });
    expect(grouped.reduce((n, t) => n + t.count, 0)).toBe(LIVE.length);
  });

  it("темы идут по числу нежелательных публикаций", () => {
    const grouped = applyThemeGroups({
      themes,
      groups: [
        { theme: "Семья и дети", members: [5, 6] },
        { theme: "Скандалы в публичной карьере", members: [0, 1, 2] },
      ],
      verdicts: LIVE,
    });
    expect(grouped[0]!.theme).toBe("Скандалы в публичной карьере");
  });
});

describe("группировка целиком", () => {
  it("при малом числе тем модель не зовётся", async () => {
    let called = false;
    const few = [verdict("Одна", "adverse", 1), verdict("Две", "neutral", 2)];
    const res = await clusterVerdictThemes(few, {
      call: (async () => {
        called = true;
        return { groups: [] };
      }) as never,
    });
    expect(called).toBe(false);
    expect(res).toHaveLength(2);
  });

  it("отказ модели оставляет темы дробными, но честными", async () => {
    const many = Array.from({ length: 12 }, (_, i) => verdict(`Тема ${i}`, "neutral", i + 1));
    const res = await clusterVerdictThemes(many, {
      call: (async () => {
        throw new Error("openai-timeout");
      }) as never,
    });
    expect(res).toHaveLength(12);
    expect(res.reduce((n, t) => n + t.count, 0)).toBe(12);
  });

  it("группы модели применяются и сокращают россыпь", async () => {
    const many = Array.from({ length: 12 }, (_, i) => verdict(`Тема ${i}`, "neutral", i + 1));
    const res = await clusterVerdictThemes(many, {
      call: (async () => ({
        groups: [
          { theme: "Первая половина", members: [0, 1, 2, 3, 4, 5] },
          { theme: "Вторая половина", members: [6, 7, 8, 9, 10, 11] },
        ],
      })) as never,
    });
    expect(res.map((t) => t.theme)).toEqual(["Вторая половина", "Первая половина"]);
    expect(res.reduce((n, t) => n + t.count, 0)).toBe(12);
  });
});

describe("темы по контурам", () => {
  const verdict = (over: Record<string, unknown>) =>
    ({
      schemaVersion: "link-verdict-v1",
      evidenceRef: `inventory:${over.url}`,
      url: String(over.url),
      subjectMatch: "subject",
      tone: over.tone ?? "neutral",
      theme: String(over.theme),
      quotes: [],
      readAt: "2026-08-14T10:00:00.000Z",
      ...over,
    }) as never;

  const verdicts = [
    verdict({ url: "a", region: "RU", theme: "Судебный спор о разделе активов", tone: "adverse" }),
    verdict({ url: "b", region: "RU", theme: "Судебный спор о разделе активов" }),
    verdict({ url: "c", region: "UAE", theme: "Санкции США и ЕС", tone: "adverse" }),
    verdict({ url: "d", region: "UAE", theme: "Санкции США и ЕС", tone: "adverse" }),
  ];

  it("каждый контур считает своё, названия тем общие", () => {
    const labels = new Map<string, string>();
    const ru = summarizeThemesWithLabels(
      verdicts.filter((v) => (v as { region?: string }).region === "RU"),
      labels
    );
    const uae = summarizeThemesWithLabels(
      verdicts.filter((v) => (v as { region?: string }).region === "UAE"),
      labels
    );
    expect(ru.map((t) => [t.theme, t.count, t.adverseCount])).toEqual([
      ["Судебный спор о разделе активов", 2, 1],
    ]);
    expect(uae.map((t) => [t.theme, t.count, t.adverseCount])).toEqual([["Санкции США и ЕС", 2, 2]]);
  });

  it("общий словарь тем применяется к любому подмножеству", () => {
    const labels = new Map([
      ["Судебный спор о разделе активов", "Судебные и правовые сюжеты"],
      ["Санкции США и ЕС", "Санкционный контур"],
    ]);
    const all = summarizeThemesWithLabels(verdicts, labels);
    expect(all.map((t) => t.theme)).toEqual(["Санкционный контур", "Судебные и правовые сюжеты"]);
  });

  it("материал о другом лице в свод не идёт", () => {
    const foreign = [verdict({ url: "e", region: "RU", theme: "Однофамилец", subjectMatch: "other" })];
    expect(summarizeThemesWithLabels(foreign, new Map())).toEqual([]);
  });
});
