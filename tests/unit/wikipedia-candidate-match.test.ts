import { describe, expect, it } from "vitest";
import {
  isMatch,
  pickWikipediaCandidate,
} from "@/modules/digital-profile/providers/wikipedia-provider";

const TERMS = ["Керимов Сулейман Абусаидович", "Suleyman Kerimov"];

describe("совпадение статьи Википедии с субъектом", () => {
  it("страница-разрешение неоднозначностей статьёй о субъекте не считается", () => {
    // «керимов сулейман абусаидович» начинается с «керимов» — на этом старое
    // правило и ловилось, подставляя в отчёт список однофамильцев.
    expect(isMatch("Керимов", TERMS)).toBe(false);
  });

  it("статья о субъекте узнаётся по фамилии и имени", () => {
    expect(isMatch("Керимов, Сулейман Абусаидович", TERMS)).toBe(true);
    expect(isMatch("Suleyman Kerimov", TERMS)).toBe(true);
  });

  it("однофамилец с другим именем не проходит", () => {
    expect(isMatch("Керимов, Саид Сулейманович", TERMS)).toBe(false);
    expect(isMatch("Керимов, Керим Алиевич", TERMS)).toBe(false);
  });

  it("уточнение в скобках совпадению не мешает", () => {
    expect(isMatch("Suleyman Kerimov (businessman)", TERMS)).toBe(true);
  });

  it("субъект из одного слова сравнивается по этому слову", () => {
    expect(isMatch("Мадонна", ["Мадонна"])).toBe(true);
    expect(isMatch("Мадонна (значения)", ["Мадонна"])).toBe(true);
  });
});

describe("выбор кандидата из результатов поиска", () => {
  it("берёт статью о человеке, даже если поиск поставил её не первой", () => {
    const candidates = [
      { title: "Керимов" },
      { title: "Керимов, Саид Сулейманович" },
      { title: "Керимов, Сулейман Абусаидович" },
    ];
    expect(pickWikipediaCandidate(candidates, TERMS)?.title).toBe(
      "Керимов, Сулейман Абусаидович"
    );
  });

  it("предпочитает более полное совпадение имени", () => {
    const candidates = [{ title: "Suleyman Kerimov" }, { title: "Керимов, Сулейман Абусаидович" }];
    expect(pickWikipediaCandidate(candidates, TERMS)?.title).toBe(
      "Керимов, Сулейман Абусаидович"
    );
  });

  it("без подходящих кандидатов ничего не выдумывает", () => {
    expect(pickWikipediaCandidate([{ title: "Керимов" }, { title: "Дербент" }], TERMS)).toBeNull();
    expect(pickWikipediaCandidate([], TERMS)).toBeNull();
  });
});
