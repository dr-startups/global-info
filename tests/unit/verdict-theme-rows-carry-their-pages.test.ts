/**
 * Строка темы вердиктов ведёт к своим страницам.
 *
 * Резюме называет сюжеты прочитанных страниц, а не рубрики словаря, и каждый
 * сюжет обязан прослеживаться до наблюдения с URL и доменом. Название и числа
 * сюжета — это строка `summary.themes` из `link-verdicts.json`, но состава у
 * строки не было: `examples` хранит до пяти адресов, а по каким решениям строка
 * собрана, из замороженного артефакта восстановить было нельзя. `evidenceRefs`
 * — этот недостающий кирпич: сюжет ведёт к наблюдениям, а не сопоставляется с
 * ними по тексту.
 *
 * Инварианты, которые здесь закреплены: в строке только субъектные страницы,
 * число ссылок равно счётчику публикаций, а сведение тем вторым проходом
 * ничего не теряет и не задваивает.
 */

import { describe, expect, it } from "vitest";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSchema,
  summarizeLinkVerdicts,
  type LinkVerdict,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import {
  applyThemeGroups,
  summarizeThemesWithLabels,
  themesForClustering,
} from "@/modules/digital-profile/orion-golden/analytics/link-theme-clustering";

function verdict(partial: Partial<LinkVerdict> & { evidenceRef: string }): LinkVerdict {
  return LinkVerdictSchema.parse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    url: `https://news.holmstrom-case.se/${partial.evidenceRef}`,
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Деловой профиль",
    quotes: [],
    readAt: "2026-08-17T12:00:00.000Z",
    ...partial,
  });
}

/** Прогон: две страницы сюжета, чужая, вероятная и не открывшаяся. */
const VERDICTS: LinkVerdict[] = [
  verdict({
    evidenceRef: "inventory:obs-01",
    tone: "adverse",
    rank: 1,
    theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
    quotes: [{ text: "faces tax-fraud probe in Stockholm" }],
  }),
  verdict({
    evidenceRef: "inventory:obs-02",
    rank: 4,
    theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
  }),
  verdict({
    evidenceRef: "inventory:obs-03",
    subjectMatch: "other",
    tone: "adverse",
    rank: 6,
    theme: "Приговор однофамильцу",
    quotes: [{ text: "приговор вынесен другому человеку" }],
  }),
  verdict({
    evidenceRef: "inventory:obs-04",
    subjectMatch: "likely",
    rank: 8,
    theme: "Возможное совпадение по имени",
  }),
  // Непрочитанная страница выглядит ровно так, как её пишет аналитик:
  // «не знаем» вместо догадки. В свод она не входит и в состав сюжета тоже.
  verdict({
    evidenceRef: "inventory:obs-05",
    subjectMatch: "unclear",
    readFailure: "blocked",
    rank: 9,
    theme: "Заголовок выдачи",
  }),
  verdict({ evidenceRef: "inventory:obs-06", rank: 12, theme: "Деловой профиль" }),
];

describe("состав строки темы", () => {
  it("в строке — только субъектные прочитанные страницы", () => {
    const rows = summarizeLinkVerdicts(VERDICTS).themes;
    const row = rows.find(
      (t) => t.theme === "Уголовное дело о налоговом мошенничестве в Стокгольме"
    );
    expect(row?.evidenceRefs).toEqual(["inventory:obs-01", "inventory:obs-02"]);
    const allRefs = rows.flatMap((t) => t.evidenceRefs);
    expect(allRefs).not.toContain("inventory:obs-03");
    expect(allRefs).not.toContain("inventory:obs-04");
    expect(allRefs).not.toContain("inventory:obs-05");
  });

  it("число ссылок строки равно числу её публикаций", () => {
    const s = summarizeLinkVerdicts(VERDICTS);
    for (const t of s.themes) {
      expect(t.evidenceRefs).toHaveLength(t.count);
    }
    // Существующее свойство свода не сломано: сумма по темам сходится.
    expect(s.themes.reduce((n, t) => n + t.adverseCount, 0)).toBe(s.adverse);
  });

  it("сведение тем не теряет и не задваивает страницы", () => {
    const labels = new Map([
      ["Уголовное дело о налоговом мошенничестве в Стокгольме", "Судебные сюжеты"],
      ["Деловой профиль", "Судебные сюжеты"],
    ]);
    const before = summarizeLinkVerdicts(VERDICTS).themes.flatMap((t) => t.evidenceRefs);
    const after = summarizeThemesWithLabels(VERDICTS, labels).flatMap((t) => t.evidenceRefs);
    expect([...after].sort()).toEqual([...before].sort());
    expect(new Set(after).size).toBe(after.length);
  });

  it("группировка складывает состав своих участников", () => {
    const themes = themesForClustering(VERDICTS);
    const grouped = applyThemeGroups({
      themes,
      groups: [
        {
          theme: "Судебные сюжеты",
          members: themes
            .filter((t) => t.theme.startsWith("Уголовное дело"))
            .map((t) => t.index),
        },
      ],
      verdicts: VERDICTS,
    });
    const merged = grouped.find((t) => t.theme === "Судебные сюжеты");
    expect(merged?.evidenceRefs).toEqual(["inventory:obs-01", "inventory:obs-02"]);
    expect(merged?.evidenceRefs).toHaveLength(merged?.count ?? -1);
    // Неразобранная тема остаётся собственной — и со своим составом.
    const own = grouped.find((t) => t.theme === "Деловой профиль");
    expect(own?.evidenceRefs).toEqual(["inventory:obs-06"]);
  });
});
