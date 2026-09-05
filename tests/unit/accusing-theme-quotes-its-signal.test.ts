/**
 * Обвиняющая тема цитирует то, чем она вызвана.
 *
 * Отчёт 86, блок «Криминальные / судебные материалы»: две цитаты, и обе —
 * заголовок профиля на портале о судьях («Судьи России — Егоров Алексей
 * Евгеньевич — Краснодарский край»). Владелец прочитал это так: в
 * криминальную тему попало то, что субъект работает судьёй.
 *
 * На самом деле тему дал сниппет — «…при попустительстве губернатора и
 * прокурора … завладел государственной землей лесного фонда и построил
 * виллу…». Классификация была верной, а подача врала: сигнала в напечатанной
 * цитате не было вовсе.
 *
 * Правило: у обвиняющей темы цитата обязана нести сигнал. Описательной темы
 * это не касается — там нейтральный заголовок и есть доказательство.
 */

import { describe, expect, it } from "vitest";
import { resolveExampleQuote } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import { buildSubjectContextMask } from "@/modules/digital-profile/config/subject-context-words";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

const CRIMINAL = getFindingThemes().find((t) => t.themeId === "criminal_legal")!;
const BUSINESS = getFindingThemes().find((t) => t.themeId === "business_profile")!;

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

const VILLA_SNIPPET =
  "Егоров Алексей Евгеньевич. Регион: Краснодарский край. Отзывов: 3. " +
  "Председатель Арбитражного суда Краснодарского края Алексей Егоров при попустительстве " +
  "губернатора Кубани Вениамина Кондратьева и прокурора Сергея Табельского, под видом рекреации " +
  "завладел государственной землей лесного фонда и построил виллу в первой санитарной зоне " +
  "охраны курортов Туапсинского района, на берегу мыса Агрий Черного моря.";

function item(partial: Partial<RawInventoryItem>): RawInventoryItem {
  return {
    inventoryId: "obs-1",
    caseId: "case-egorov",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-05T12:00:00.000Z",
    evidenceType: "search_result",
    title: "",
    snippet: "",
    ...partial,
  } as RawInventoryItem;
}

const JUDGE_PROFILE = item({
  title: "Судьи России - Егоров Алексей Евгеньевич - Краснодарский край",
  snippet: VILLA_SNIPPET,
  sourceUrl: "https://судьироссии.рф/sudii/egorov-aleksey-evgen-evich",
});

describe("цитата обвиняющей темы несёт её сигнал", () => {
  it("сигнал в сниппете — цитируется предложение сниппета", () => {
    const ex = resolveExampleQuote(JUDGE_PROFILE, CRIMINAL, MASK);
    expect(ex?.title).toContain("прокурора Сергея Табельского");
    expect(ex?.title).not.toContain("Судьи России");
  });

  it("сигнал в заголовке — цитируется заголовок", () => {
    const ex = resolveExampleQuote(
      item({
        title: "Проверят председателя Арбитражного суда Краснодарского края на коррупционность",
        snippet: VILLA_SNIPPET,
        sourceUrl: "https://zakrasnodar.ru/art/proveryat_6195.html",
      }),
      CRIMINAL,
      MASK
    );
    expect(ex?.title).toContain("коррупционность");
  });

  it("описательная тема цитирует заголовок, как и прежде", () => {
    const ex = resolveExampleQuote(JUDGE_PROFILE, BUSINESS, MASK);
    expect(ex?.title).toBe("Судьи России - Егоров Алексей Евгеньевич - Краснодарский край");
  });

  it("сигнала нет нигде — цитаты нет", () => {
    const ex = resolveExampleQuote(
      item({
        title: "Егоров А.Е. | Арбитражный суд Краснодарского края",
        snippet: "Председатель Арбитражного суда Краснодарского края. Приём граждан по средам.",
        sourceUrl: "https://declarator.org/person/12345/",
      }),
      CRIMINAL,
      MASK
    );
    expect(ex).toBeNull();
  });
});
