import { describe, expect, it } from "vitest";
import {
  conflictingPatronymics,
  hasPatronymicConflict,
} from "../../src/modules/digital-profile/orion-golden/analytics/patronymic-conflict";
import {
  cleanExampleTitle,
  isWeakExampleTitle,
} from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";

/**
 * Шаг 13, этап 2 — C3 и C9.
 *
 * В отчёт попали материал о другом человеке под профилем субъекта и статья
 * Википедии как единственное «доказательство» офшорного владения.
 */

const SUBJECT = {
  lastName: "Дуров",
  lastNameVariants: ["Durov"],
  patronymics: ["Валерьевич"],
};

describe("чужое отчество рядом с фамилией — другой человек", () => {
  it("узнаёт подмену отчества", () => {
    // Ровно строка из приложения: ИП с реквизитами другого человека.
    expect(conflictingPatronymics("ИП Дуров Павел Юрьевич — ОГРНИП: 324774600790305", SUBJECT)).toEqual([
      "юрьевич",
    ]);
    expect(hasPatronymicConflict("дуров павел владимирович", SUBJECT)).toBe(true);
  });

  it("собственное отчество конфликтом не считает", () => {
    expect(conflictingPatronymics("Дуров Павел Валерьевич, ИНН 781428692439", SUBJECT)).toEqual([]);
    expect(hasPatronymicConflict("Павел Валерьевич Дуров основал Telegram", SUBJECT)).toBe(false);
  });

  it("отчество родственника с той же фамилией конфликтом не считает", () => {
    // Николай Валерьевич Дуров — брат, отчество то же.
    expect(hasPatronymicConflict("Николай Валерьевич Дуров, математик", SUBJECT)).toBe(false);
  });

  it("чужое отчество вдали от фамилии субъекта не относится к нему", () => {
    const text =
      "Павел Валерьевич Дуров выступил на форуме. " +
      "Отдельно выступал приглашённый эксперт Иванов Пётр Сергеевич из другого ведомства.";
    expect(hasPatronymicConflict(text, SUBJECT)).toBe(false);
  });

  it("без известного отчества субъекта выводов не делает", () => {
    expect(hasPatronymicConflict("Дуров Павел Юрьевич", { ...SUBJECT, patronymics: [] })).toBe(false);
  });

  it("женские формы отчества тоже узнаёт", () => {
    expect(
      hasPatronymicConflict("Дурова Мария Сергеевна", {
        lastName: "Дурова",
        lastNameVariants: [],
        patronymics: ["Валерьевна"],
      })
    ).toBe(true);
  });

  it("пустой текст не роняет", () => {
    expect(conflictingPatronymics("", SUBJECT)).toEqual([]);
  });
});

describe("справочная карточка — не доказательство темы", () => {
  it("снимает суффикс справочного источника", () => {
    expect(cleanExampleTitle("Дуров, Павел Валерьевич — Википедия")).toBe("Дуров, Павел Валерьевич");
    expect(cleanExampleTitle("Павел Валерьевич Дуров — Циклопедия")).toBe("Павел Валерьевич Дуров");
    expect(cleanExampleTitle("Дуров, Павел Валерьевич - ПЕРСОНА ТАСС")).toBe(
      "Дуров, Павел Валерьевич"
    );
  });

  it("карточка-справка доказательством не считается", () => {
    // Единственным «материалом» темы офшоров была статья Википедии.
    expect(isWeakExampleTitle("Дуров, Павел Валерьевич — Википедия")).toBe(true);
    expect(isWeakExampleTitle("Павел Валерьевич Дуров — Циклопедия")).toBe(true);
    expect(isWeakExampleTitle("Дуров, Павел Валерьевич - ПЕРСОНА ТАСС")).toBe(true);
  });

  it("настоящий заголовок доказательством остаётся", () => {
    for (const t of [
      "Кто такой Павел Дуров, и чем его арест грозит Казахстану",
      "Дуров покинул здание суда после предъявления обвинений",
      "Дуров Павел Валерьевич: биография, проекты, личная жизнь",
      "Арест Павла Дурова во Франции – 20 лет тюрьмы",
    ]) {
      expect(isWeakExampleTitle(t)).toBe(false);
    }
  });

  it("суффикс площадки не режется из середины заголовка", () => {
    const t = "Википедия удалила статью о предпринимателе после жалобы";
    expect(cleanExampleTitle(t)).toBe(t);
  });
});
