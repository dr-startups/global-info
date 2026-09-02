/**
 * Тема повышенного внимания не цитирует страницу, признанную нейтральной.
 *
 * Тему материалу назначает словарь ключевых слов — по заголовку. Слово «суд» в
 * заголовке телеинтервью тянет его в криминальный блок, и клиент читает
 * интервью как доказательство судебного сюжета. Решение же вынесено по тексту
 * страницы: она прочитана, разобрана моделью и признана нейтральной. Оно и
 * решает, что можно цитировать.
 *
 * Непрочитанной страницы правило не касается: там словарь — всё, что есть.
 * От уровня внимания темы правило не зависит: причина у него одна и та же. А
 * вот от того, обвиняет тема или описывает, зависит: у делового профиля и
 * публичной экспозиции нейтральная публикация — законное доказательство темы,
 * и изгонять её не за что.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const FINDING = {
  findingId: "finding-criminal_legal-subject_match-test",
  theme: "Криминальные / судебные материалы",
  claim:
    "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:\nВсего по теме: 2 материала.",
  riskLevel: "high",
  regions: ["RU", "UAE"],
  evidenceRefs: ["inventory:read-neutral", "inventory:read-adverse"],
  sourceDomains: ["tv.example", "news.example"],
} as unknown as Finding;

function scoped(
  tones: Record<string, "adverse" | "neutral" | "supportive" | undefined>,
  /** Правка аналитика по нейтрально прочитанному материалу — если она есть. */
  analystDecision?: "ADVERSE" | "NEUTRAL"
): ScopedFragmentInput {
  return {
    findings: [FINDING],
    surfaceUnits: [],
    evidenceIndex: {
      "inventory:read-neutral": {
        title: "Тимати в суде дал интервью о новом альбоме и планах на тур",
        domain: "tv.example",
        region: "RU",
        readVerdictTone: tones["inventory:read-neutral"],
        analystDecision,
      },
      "inventory:read-adverse": {
        title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
        domain: "news.example",
        region: "RU",
        readVerdictTone: tones["inventory:read-adverse"],
      },
    },
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("вердикт прочитанной страницы сильнее словаря", () => {
  it("нейтральная страница не цитируется в теме повышенного внимания", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": "neutral", "inventory:read-adverse": "adverse" })
    );
    expect(claim).not.toContain("дал интервью о новом альбоме");
    expect(claim).toContain("Суд по иску о взыскании 72 млн рублей");
  });

  it("поддерживающая страница тоже не цитируется", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": "supportive", "inventory:read-adverse": "adverse" })
    );
    expect(claim).not.toContain("дал интервью о новом альбоме");
  });

  it("непрочитанная страница остаётся доказательством: словарь — всё, что есть", () => {
    const claim = localizedThemedClaim(
      FINDING,
      scoped({ "inventory:read-neutral": undefined, "inventory:read-adverse": undefined })
    );
    expect(claim).toContain("дал интервью о новом альбоме");
  });

  it("правка аналитика сильнее вердикта: цитата возвращается", () => {
    /*
     * Человек посмотрел материал и пометил его нежелательным — значит, на
     * странице что-то есть, и обвиняющая тема цитату не теряет. Порядок сил
     * тот же, что у оценки строки, и предикат тот же
     * (`pageReadAsFavourable`): иначе строка выдачи печаталась бы
     * «Нежелательной» по правке аналитика, а тема того же материала на
     * соседнем листе не цитировала бы его вовсе.
     */
    const claim = localizedThemedClaim(
      FINDING,
      scoped(
        { "inventory:read-neutral": "neutral", "inventory:read-adverse": "adverse" },
        "ADVERSE"
      )
    );
    expect(claim).toContain("дал интервью о новом альбоме");
  });

  it("обвиняющая тема низкого уровня внимания ограничена вердиктом так же", () => {
    /*
     * Было наоборот: правило применялось только к темам не ниже среднего, и
     * «Финансовые претензии / долговые споры» (низкий уровень) на стр. 52
     * отчёта Кремлёва процитировала пост о партнёрстве со страницы,
     * прочитанной и признанной нейтральной. Причина защиты — «тему назначил
     * словарь по заголовку, а страницу прочитали» — от уровня риска не зависит
     * ни в чём: заголовок с «судом» тянет материал в тему одинаково при любом
     * уровне.
     */
    const lowRisk = {
      ...FINDING,
      findingId: "finding-financial_claims-subject_match-test",
      theme: "Финансовые претензии / долговые споры",
      riskLevel: "low",
    } as Finding;
    const claim = localizedThemedClaim(
      lowRisk,
      scoped({ "inventory:read-neutral": "neutral", "inventory:read-adverse": "neutral" })
    );
    expect(claim).not.toContain("дал интервью о новом альбоме");
  });
});

describe("описательная тема нейтральную страницу цитирует", () => {
  /*
   * Защита стоит на темах, которые **обвиняют**: там нейтрально прочитанная
   * страница попала в тему словарём по заголовку, и цитировать её — значит
   * предъявить клиенту сюжет, которого на странице нет. У делового профиля и
   * публичной экспозиции всё наоборот: нейтральная публикация и есть законное
   * доказательство темы, а её изгнание печатало на странице делового профиля
   * «сути риска в выдаче не выделено» при двух годных цитатах.
   */
  it.each([
    ["Деловой профиль", "business_profile"],
    ["Политические связи / публичная экспозиция", "political_exposure"],
  ])("«%s» оставляет цитату прочитанной страницы", (theme, themeId) => {
    // Идентификатор находки несёт тему, и подменять один ярлык уже нельзя:
    // тему находки дека узнаёт по идентификатору.
    const descriptive = {
      ...FINDING,
      findingId: `finding-${themeId}-subject_match-test`,
      theme,
      riskLevel: "low",
    } as Finding;
    const claim = localizedThemedClaim(
      descriptive,
      scoped({ "inventory:read-neutral": "neutral", "inventory:read-adverse": "neutral" })
    );
    expect(claim).toContain("дал интервью о новом альбоме");
    expect(claim).not.toContain("отдельный заголовок с сутью риска в выдаче не выделен");
  });
});
