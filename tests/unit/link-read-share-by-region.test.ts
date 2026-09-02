/**
 * Доля негатива считается по уникальным прочитанным страницам своего региона.
 *
 * Числитель — страницы, которые удалось прочитать, признать материалом о
 * субъекте и оценить как нежелательные. Знаменатель — прочитанные страницы
 * региона за вычетом признанных чужими: однофамилец ничего не подтверждает о
 * субъекте и не вправе разбавлять долю. Непрочитанная страница не входит
 * никуда, кроме числа отобранных: её вердикт — «не знаем», а не оценка.
 *
 * Счёт идёт по уникальным `evidenceRef`, а не по строкам вердиктов: инвариант
 * «страница входит ровно в одну тему» держится в кластеризации, и метрика
 * региона не обязана от него зависеть.
 */

import { describe, expect, it } from "vitest";
import { countLinkReadByRegion } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { summarizeThemesWithLabels } from "@/modules/digital-profile/orion-golden/analytics/link-theme-clustering";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

function verdict(patch: Partial<LinkVerdict> & { evidenceRef: string }): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    url: `https://example.com/${patch.evidenceRef}`,
    domain: "example.com",
    region: "RU",
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Тема страницы",
    quotes: [],
    readAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as LinkVerdict;
}

describe("счётчик прочитанного по регионам", () => {
  it("одна ссылка с двумя вердиктами считается один раз", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "ref-1", tone: "adverse", theme: "Суд" }),
      verdict({ evidenceRef: "ref-1", tone: "adverse", theme: "Санкции" }),
    ]);
    expect(counts.RU).toEqual({ requested: 1, read: 1, readOther: 0, adverseRead: 1 });
  });

  it("непрочитанная страница входит только в число отобранных", () => {
    const counts = countLinkReadByRegion([
      // Даже нежелательный тон по непрочитанной странице — не оценка: цитаты
      // со страницы нет, подтверждать нечем.
      verdict({ evidenceRef: "ref-1", tone: "adverse", readFailure: "blocked" }),
      verdict({ evidenceRef: "ref-2", tone: "neutral", readFailure: "timeout" }),
    ]);
    expect(counts.RU).toEqual({ requested: 2, read: 0, readOther: 0, adverseRead: 0 });
  });

  it("страница о другом лице прочитана, но из знаменателя исключена", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "ref-1", subjectMatch: "other", tone: "neutral" }),
      verdict({ evidenceRef: "ref-2", subjectMatch: "other", tone: "adverse" }),
      verdict({ evidenceRef: "ref-3", subjectMatch: "subject", tone: "adverse" }),
    ]);
    expect(counts.RU).toEqual({ requested: 3, read: 3, readOther: 2, adverseRead: 1 });
    // Знаменатель — прочитано минус чужие: 3 − 2 = 1.
    expect(counts.RU!.read - counts.RU!.readOther).toBe(1);
  });

  it("«вероятно» и «неясно» остаются в знаменателе, но не в числителе", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "ref-1", subjectMatch: "likely", tone: "adverse" }),
      verdict({ evidenceRef: "ref-2", subjectMatch: "unclear", tone: "adverse" }),
      verdict({ evidenceRef: "ref-3", subjectMatch: "subject", tone: "adverse" }),
    ]);
    expect(counts.RU).toEqual({ requested: 3, read: 3, readOther: 0, adverseRead: 1 });
  });

  it("российские вердикты не меняют корзину ОАЭ", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "ru-1", tone: "adverse" }),
      verdict({ evidenceRef: "ru-2", tone: "adverse" }),
      verdict({ evidenceRef: "ru-3", tone: "neutral", readFailure: "not_found" }),
      verdict({ evidenceRef: "ae-1", region: "AE", tone: "adverse" }),
      verdict({ evidenceRef: "ae-2", region: "UAE", tone: "neutral" }),
    ]);
    expect(counts.RU).toEqual({ requested: 3, read: 2, readOther: 0, adverseRead: 2 });
    // Сырой регион `AE` сводится в корзину UAE тем же правилом, что и темы.
    expect(counts.UAE).toEqual({ requested: 2, read: 2, readOther: 0, adverseRead: 1 });
  });

  it("вердикт без региона не попадает ни в одну корзину", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "ref-1", region: undefined, tone: "adverse" }),
    ]);
    expect(counts.RU).toBeUndefined();
    expect(counts.UAE).toBeUndefined();
  });

  it("инвариант adverseRead ≤ read − readOther ≤ read ≤ requested держится", () => {
    const counts = countLinkReadByRegion([
      verdict({ evidenceRef: "r1", tone: "adverse" }),
      verdict({ evidenceRef: "r2", tone: "neutral" }),
      verdict({ evidenceRef: "r3", subjectMatch: "other", tone: "adverse" }),
      verdict({ evidenceRef: "r4", subjectMatch: "likely", tone: "adverse" }),
      verdict({ evidenceRef: "r5", tone: "adverse", readFailure: "empty_text" }),
      verdict({ evidenceRef: "r5", tone: "adverse", readFailure: "empty_text" }),
      verdict({ evidenceRef: "u1", region: "UAE", subjectMatch: "other", tone: "neutral" }),
    ]);
    for (const bucket of Object.values(counts)) {
      expect(bucket.adverseRead).toBeLessThanOrEqual(bucket.read - bucket.readOther);
      expect(bucket.read - bucket.readOther).toBeLessThanOrEqual(bucket.read);
      expect(bucket.read).toBeLessThanOrEqual(bucket.requested);
    }
    expect(counts.RU).toEqual({ requested: 5, read: 4, readOther: 1, adverseRead: 1 });
  });
});

describe("числа страницы региона сходятся с числами страницы тем", () => {
  it("adverseRead региона равен сумме adverseCount тем этого региона", () => {
    const verdicts = [
      verdict({ evidenceRef: "ru-1", tone: "adverse", theme: "Судебные споры" }),
      verdict({ evidenceRef: "ru-2", tone: "adverse", theme: "Судебные споры" }),
      verdict({ evidenceRef: "ru-3", tone: "adverse", theme: "Санкционные списки" }),
      verdict({ evidenceRef: "ru-4", tone: "neutral", theme: "Деловой профиль" }),
      verdict({ evidenceRef: "ru-5", subjectMatch: "other", tone: "adverse", theme: "Однофамилец" }),
      verdict({
        evidenceRef: "ru-6",
        subjectMatch: "unclear",
        tone: "neutral",
        readFailure: "blocked",
        theme: "Заголовок выдачи",
      }),
      verdict({ evidenceRef: "ae-1", region: "UAE", tone: "adverse", theme: "Судебные споры" }),
    ];
    const counts = countLinkReadByRegion(verdicts);
    const themesRu = summarizeThemesWithLabels(
      verdicts.filter((v) => v.region === "RU"),
      new Map()
    );
    const adverseOnThemesPage = themesRu.reduce((n, t) => n + t.adverseCount, 0);
    expect(counts.RU!.adverseRead).toBe(adverseOnThemesPage);
    expect(adverseOnThemesPage).toBe(3);
  });
});
