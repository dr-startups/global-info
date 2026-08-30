/**
 * Абзац находки сравнивает предложениями, а не целыми полями.
 *
 * Дедуп в `composeFindingProse` клал в «уже сказанное» **строку целиком**,
 * поэтому срабатывал только при побайтном равенстве `narrative` и
 * `whatWasFound`. На эталоне 72 равенство выполняется (запрос выдачи в
 * артефактах не записан, лида нет) — и повторов не видно; на любом прогоне с
 * записанным запросом лид сдвигает строку, равенство пропадает, и вывод
 * страницы печатается вторым экземпляром подряд.
 *
 * Второй источник дубля — таблица самой страницы: «Почему важно» и «Что
 * сделать» профильной карточки комплаенса стоят строками «Параметр | Значение»
 * и тем же текстом уезжали в абзац.
 */

import { describe, expect, it } from "vitest";
import { composeFindingProse } from "@/modules/digital-profile/orion-golden/deck-sections/page-narrative";

/** Сколько раз нормализованная фраза встречается в тексте. */
function occurrences(text: string, phrase: string): number {
  return text.split(phrase).length - 1;
}

const THEME_LINE = "«Криминальные / судебные материалы» — высокий уровень внимания.";
const LEAD = "Показана выдача Яндекса по запросу «Андерс Хольмстрём».";
const WHY = "На странице 2 темы повышенного внимания — эти материалы видны при первой же проверке субъекта.";

describe("склейка абзаца находки", () => {
  it("ведущее предложение перед выводом не превращает вывод в повтор", () => {
    const narrative = `${LEAD} ${THEME_LINE}`;
    const out = composeFindingProse({
      narrative,
      whatWasFound: THEME_LINE,
      whyItMatters: WHY,
    });
    expect(out).toBe(WHY);
    expect(occurrences(`${narrative}\n${out ?? ""}`, THEME_LINE)).toBe(1);
  });

  it("случай эталона 72 не сломан: поля совпадают побайтно", () => {
    const out = composeFindingProse({
      narrative: THEME_LINE,
      whatWasFound: THEME_LINE,
      whyItMatters: WHY,
    });
    expect(out).toBe(WHY);
  });

  it("предложение из ячейки таблицы слайда в абзац не попадает", () => {
    // Строки карточки Dow Jones — те же, что построитель кладёт в поля слайда.
    const CELL_WHY =
      "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.";
    const CELL_ACTION =
      "Запросить полную карточку записи Dow Jones, включая связанных лиц (RCA), и сверить идентификаторы субъекта.";
    const out = composeFindingProse({
      narrative:
        "Профиль по данным Dow Jones: существующий комплаенс-контент, источники не расширялись.",
      whatWasFound:
        "Потенциальное совпадение по субъекту; совпадение не подтверждено и требует ручной проверки.",
      whyItMatters: CELL_WHY,
      whatToCheck: CELL_ACTION,
      tableCells: [
        "Совпадение по имени",
        "Глинка Сергей Михайлович",
        "Статус проверки",
        "Не подтверждено (статус в артефактах прогона не зафиксирован)",
        "Почему важно",
        CELL_WHY,
        "Что сделать",
        CELL_ACTION,
      ],
    });
    expect(out).toBe(
      "Потенциальное совпадение по субъекту; совпадение не подтверждено и требует ручной проверки."
    );
  });

  it("частичное совпадение с ячейкой абзац не режет", () => {
    // Ячейка «Не подтверждено (…)» — часть предложения о статусе, а не оно
    // само: сравнение по вхождению унесло бы носитель правила PENDING.
    const SENTENCE =
      "Потенциальное совпадение по субъекту; совпадение не подтверждено и требует ручной проверки.";
    const out = composeFindingProse({
      whatWasFound: SENTENCE,
      tableCells: ["Статус проверки", "Не подтверждено (статус в артефактах прогона не зафиксирован)"],
    });
    expect(out).toBe(SENTENCE);
  });

  it("пустой остаток не оставляет от абзаца пустой строки", () => {
    const out = composeFindingProse({
      narrative: `${LEAD} ${THEME_LINE}`,
      whatWasFound: THEME_LINE,
      whatToCheck: "Проверить актуальные статусы дел.",
    });
    expect(out).toBe("Проверить актуальные статусы дел.");
  });

  it("остаток, пустой целиком, даёт undefined", () => {
    expect(
      composeFindingProse({
        narrative: `${LEAD} ${THEME_LINE} ${WHY}`,
        whatWasFound: THEME_LINE,
        whyItMatters: WHY,
      })
    ).toBeUndefined();
  });
});
