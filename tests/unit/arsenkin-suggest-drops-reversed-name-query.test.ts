import { describe, expect, it } from "vitest";
import { selectCanonicalSuggestQuery } from "@/modules/digital-profile/providers/arsenkin/adapters/suggest";

/**
 * Подсказки заказываются ровно одной строкой, и выбор этой строки — платное
 * решение. Перевёрнутое ФИО получало здесь второй по величине балл, то есть
 * считалось почти каноническим написанием имени; человек такую строку не
 * набирает, и заказывать по ней подсказки нельзя.
 */

const CANONICAL = "Тиньков Олег Юрьевич";
const REVERSED = "Юрьевич Олег Тиньков";

describe("отбор запроса подсказок не знает перевёрнутого имени", () => {
  it("канонический запрос побеждает как канонический", () => {
    const picked = selectCanonicalSuggestQuery({
      se: 1,
      candidates: [REVERSED, "Олег Тиньков", CANONICAL],
      primaryLocalized: CANONICAL,
    });

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.selection.selectedQuery).toBe(CANONICAL);
    expect(picked.selection.selectionReason).toBe("canonical-localized-primary");
  });

  it("перевёртыш не обгоняет обычную кириллическую строку", () => {
    // Утверждение о балле, а не о победителе: при равном балле победа
    // достаётся алфавиту, и на другом имени («Абрамович Роман Аркадьевич»)
    // первой встала бы как раз перевёрнутая строка — это законный
    // детерминированный разрыв ничьей, а не привилегия перевёртыша.
    const picked = selectCanonicalSuggestQuery({
      se: 1,
      candidates: [REVERSED, "Олег Тиньков"],
      primaryLocalized: CANONICAL,
    });

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.selection.selectionReason).toBe("cyrillic-identity");
  });

  it("перевёртыш проходит обычной кириллической личностью, а не почти каноническим", () => {
    const picked = selectCanonicalSuggestQuery({
      se: 1,
      candidates: [REVERSED],
      primaryLocalized: CANONICAL,
    });

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.selection.selectionReason).toBe("cyrillic-identity");
  });

  it("«Имя Отчество Фамилия» проходит обычной кириллической личностью", () => {
    const picked = selectCanonicalSuggestQuery({
      se: 1,
      candidates: ["Олег Юрьевич Тиньков"],
      primaryLocalized: CANONICAL,
    });

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.selection.selectionReason).toBe("cyrillic-identity");
  });
});
