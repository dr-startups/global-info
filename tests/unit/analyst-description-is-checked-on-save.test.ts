/**
 * Описание снимка проверяется при сохранении, а не в рендере.
 *
 * Текст аналитика уезжает на клиентскую страницу и проходит те же ворота, что
 * весь клиентский текст: бюджет знаков и сторож служебных кодов. Проверять его
 * в сборке значило бы показать аналитику отказ через пять минут после того, как
 * он ушёл пить кофе, — и не показать вовсе, если сборку запустит кто-то другой.
 */

import { describe, expect, it } from "vitest";
import { validateAnalystVisualDescription } from "@/modules/digital-profile/services/compliance-visual-pages";

const ok = {
  whatItShows: "Карточка профиля в LexisNexis с двумя публикациями о судебном споре.",
  whyItMatters: "Публикации связывают субъекта с судебным сюжетом и требуют проверки.",
  whatToDo: "Запросить первоисточники и полную карточку записи, включая связанных лиц.",
};

describe("описание снимка проверяется при сохранении", () => {
  it("годное описание принимается как есть", () => {
    expect(validateAnalystVisualDescription(ok)).toEqual({ ok: true, value: ok });
  });

  it("слишком длинное поле отвергается с названным пределом", () => {
    const res = validateAnalystVisualDescription({ ...ok, whyItMatters: "я".repeat(400) });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("320");
  });

  it("служебный код в тексте не проходит", () => {
    const res = validateAnalystVisualDescription({
      ...ok,
      whatItShows: "Совпадение по теме criminal_legal подтверждено.",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("служебн");
  });

  it("пустое описание — это отсутствие описания, а не ошибка", () => {
    expect(validateAnalystVisualDescription(undefined)).toEqual({ ok: true, value: undefined });
    expect(
      validateAnalystVisualDescription({ whatItShows: "  ", whyItMatters: "", whatToDo: "" })
    ).toEqual({ ok: true, value: undefined });
  });

  it("описание из одного поля годится: пустое честнее выдуманного", () => {
    const res = validateAnalystVisualDescription({ whatItShows: ok.whatItShows });
    expect(res).toEqual({ ok: true, value: { whatItShows: ok.whatItShows } });
  });
});
