/**
 * Буллет приложения не теряет конец фразы ради маркера находки.
 *
 * Боевой отчёт 28.07 (Тиньков), страница 54, приложение:
 *
 *     Деловой фон важен для позиционирования, но сам по себе не перекрывает
 *     чувствительные темы [finding-business_profile-other_subject-5370bdde]
 *
 * Полная фраза заканчивается словами «чувствительные темы риска.» — слово и
 * точка срезаны, а маркер приписан следом. Читатель видит обрыв на полуслове.
 *
 * Причина: приложение обрезало текст по 340 знакам и **потом** дописывало
 * маркер, из-за чего итог всё равно выходил длиннее бюджета, а фраза теряла
 * конец. Рядом, в том же наборе помощников, лежит `bulletWithFindingId`: он
 * резервирует место под маркер заранее и ужимает текст целыми строками, не
 * разрезая предложение. Один вопрос — «как приписать маркер, не сломав
 * текст» — и два ответа, из которых приложение брало худший.
 *
 * Свойство: маркер помещается в бюджет вместе с текстом, а текст не
 * обрывается на полуслове.
 */

import { describe, expect, it } from "vitest";
import { bulletWithFindingId } from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { buildAppendixFragment } from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/appendix";
import { DECK_TEMPLATE_REGISTRY } from "../../src/modules/digital-profile/orion-golden/deck-sections/template-registry";

/** Бюджет карточки находки — тот же, что у шаблона, а не записанный числом. */
const CARD_BUDGET = DECK_TEMPLATE_REGISTRY["finding-cards"].layout.itemCharBudget;

const FINDING_ID = "finding-business_profile-other_subject-5370bdde";

/** Форма буллета приложения: заголовок темы, цитаты, «Где видно», вывод. */
const BODY = [
  "«Деловой профиль»",
  "Найдены материалы делового и биографического профиля:",
  "«ИП Тиньков Олег Игоревич ИНН 680704255210 Крутое» — источник tbank.ru",
  "«Тиньков Олег Михайлович ИНН 482611311037» — источник rusprofile.ru",
  "Где видно: tbank.ru, rusprofile.ru.",
  "Деловой фон важен для позиционирования, но сам по себе не перекрывает чувствительные темы риска.",
].join("\n");

describe("буллет приложения и маркер находки", () => {
  it("наблюдавшийся случай: фраза не обрывается на полуслове", () => {
    const out = bulletWithFindingId(BODY, FINDING_ID, 340);
    expect(out).toContain(`[${FINDING_ID}]`);
    // Если строка про деловой фон осталась — она осталась целиком.
    if (out.includes("Деловой фон важен")) {
      expect(out).toContain("чувствительные темы риска.");
    }
  });

  it("маркер входит в бюджет вместе с текстом", () => {
    // Прежний путь дописывал маркер поверх обрезанного текста, и итог всё
    // равно выходил за бюджет.
    for (const budget of [200, 340, 900]) {
      expect(bulletWithFindingId(BODY, FINDING_ID, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("маркер не задваивается", () => {
    const once = bulletWithFindingId(BODY, FINDING_ID, 900);
    const twice = bulletWithFindingId(once, FINDING_ID, 900);
    expect(twice.match(/\[finding-/gu) ?? []).toHaveLength(1);
  });

  it("при тесном бюджете отбрасываются целые строки, а не слова", () => {
    const out = bulletWithFindingId(BODY, FINDING_ID, 200);
    const body = out.replace(/\s*\[finding-[^\]]+\]$/u, "");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      expect(BODY.split("\n")).toContain(line);
    }
  });

  it("приложение собирает буллет тем же помощником", () => {
    // Ровно наблюдавшийся случай: находка чужого субъекта с длинным выводом.
    const scoped = {
      findings: [
        {
          findingId: FINDING_ID,
          subjectMatch: "OTHER_SUBJECT",
          riskLevel: "LOW",
          theme: "business_profile",
          // Длина как в наблюдавшемся случае: до обрезки текст длиннее 340
          // знаков, поэтому прежний путь резал фразу и дописывал маркер сверху.
          claim: BODY,
          evidenceRefs: ["inventory:x"],
        },
      ],
      surfaceUnits: [],
      metricSnapshot: {},
      evidenceIndex: {},
      scope: { regions: null },
    } as unknown as Parameters<typeof buildAppendixFragment>[1];

    const out = buildAppendixFragment("APPENDIX" as never, scoped);
    const bullets = out.slides.flatMap((s) => s.content.bullets ?? []);
    expect(bullets.length).toBeGreaterThan(0);
    for (const b of bullets) {
      // Бюджет соблюдён вместе с маркером — прежде маркер дописывался сверх него.
      expect(b.length).toBeLessThanOrEqual(CARD_BUDGET);
      // И фраза не обрывается на полуслове перед маркером.
      expect(b).not.toMatch(/[а-яё]\s+\[finding-/u);
      // Вывод темы уцелел целиком: бюджет шаблона его вмещает.
      expect(b).toContain("чувствительные темы риска.");
    }
  });
});
