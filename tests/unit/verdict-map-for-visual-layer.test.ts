/**
 * Карта решений для визуального слоя строится по ключам наблюдений.
 *
 * Рамку на снимке выдачи ставит прочитанная страница, и связь держится на
 * одном ключе: `verdict.evidenceRef` обязан совпасть с `inventory:<id>`,
 * которым визуальный слой называет строку. Разъедутся — рамки молча вернутся
 * к словарю, и никто не заметит: дека соберётся, ворота пройдут.
 *
 * Здесь же проверяются два правила отбора: непрочитанная страница решения не
 * приносит, а нежелательный вывод без цитаты рамку не назначает.
 */

import { describe, expect, it } from "vitest";
import { observationVerdictsForVisuals } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const ARTIFACT = {
  summary: {
    themes: [
      {
        theme: "Санкции, санкционные суды и заморозка активов",
        count: 2,
        adverseCount: 2,
        evidenceRefs: ["inventory:a", "inventory:c"],
      },
    ],
  },
  verdicts: [
    {
      evidenceRef: "inventory:a",
      subjectMatch: "subject",
      tone: "adverse",
      quotes: [{ text: "Активы заморожены решением Совета ЕС." }],
    },
    {
      evidenceRef: "inventory:b",
      subjectMatch: "subject",
      tone: "adverse",
      quotes: [{ text: "Страница недоступна." }],
      readFailure: "blocked",
    },
    {
      evidenceRef: "inventory:c",
      subjectMatch: "likely",
      tone: "adverse",
      quotes: [{ text: "   " }],
    },
    {
      evidenceRef: "inventory:d",
      subjectMatch: "other",
      tone: "neutral",
      quotes: [],
    },
  ],
};

describe("карта решений для рамок и легенды", () => {
  const map = observationVerdictsForVisuals(ARTIFACT);

  it("ключи — те же, которыми визуальный слой называет строки", () => {
    expect(Object.keys(map).sort()).toEqual(["inventory:a", "inventory:c", "inventory:d"]);
  });

  it("непрочитанная страница в карту не попадает", () => {
    expect(map["inventory:b"]).toBeUndefined();
  });

  it("кластерный ярлык берётся из свода по наблюдениям темы", () => {
    expect(map["inventory:a"]?.themeLabel).toBe("Санкции, санкционные суды и заморозка активов");
    expect(map["inventory:d"]?.themeLabel).toBeUndefined();
  });

  it("цитата из одних пробелов цитатой не считается", () => {
    expect(map["inventory:a"]?.quoted).toBe(true);
    expect(map["inventory:c"]?.quoted).toBe(false);
  });

  it("тон и принадлежность переносятся как есть", () => {
    expect(map["inventory:c"]?.subjectMatch).toBe("likely");
    expect(map["inventory:d"]?.tone).toBe("neutral");
  });
});
