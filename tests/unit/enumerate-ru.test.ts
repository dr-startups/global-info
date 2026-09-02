import { describe, expect, it } from "vitest";
import { enumerateRu } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Домены склеивались через запятую, и строка читалась как выгрузка списка.
 * Союз перед последним элементом — мелочь, из которых складывается ощущение
 * бланка, поэтому она закреплена тестом.
 */
describe("перечисление по-русски", () => {
  it("один элемент — без союза", () => {
    expect(enumerateRu(["rbc.ru"])).toBe("rbc.ru");
  });

  it("два элемента — через «и»", () => {
    expect(enumerateRu(["rbc.ru", "forbes.ru"])).toBe("rbc.ru и forbes.ru");
  });

  it("три элемента — запятая и «и» перед последним", () => {
    expect(enumerateRu(["a.ru", "b.ru", "c.ru"])).toBe("a.ru, b.ru и c.ru");
  });

  it("сверх лимита — «и ещё N», а не обрыв списка", () => {
    expect(enumerateRu(["a", "b", "c", "d", "e"])).toBe("a, b, c и ещё 2");
  });

  it("лимит настраивается", () => {
    expect(enumerateRu(["a", "b", "c", "d"], 4)).toBe("a, b, c и d");
  });

  it("пустые значения не создают висящих запятых", () => {
    expect(enumerateRu(["a", "", "  ", "b"])).toBe("a и b");
    expect(enumerateRu([])).toBe("");
  });
});
