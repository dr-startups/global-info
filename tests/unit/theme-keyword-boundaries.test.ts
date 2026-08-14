import { describe, expect, it } from "vitest";
import {
  getAdversePatterns,
  getFindingThemes,
} from "@/modules/digital-profile/config/finding-themes";

function theme(themeId: string) {
  const t = getFindingThemes().find((x) => x.themeId === themeId);
  if (!t) throw new Error(`нет темы ${themeId}`);
  return t.keywords;
}

describe("слово темы совпадает с началом слова", () => {
  /**
   * Разбор живого прогона: по криминальной теме набралось 27 материалов, и
   * среди них не было ни одного судебного сюжета — «суд» находился внутри
   * «го-суд-арственной». Так под тему «Криминальные / судебные материалы»
   * попали «Структура | Совет Федерации» и «20 самых богатых людей России».
   */
  it("«государственной» не делает материал судебным", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("представитель органа государственной власти Республики Дагестан")).toBe(
      false
    );
    expect(crim.test("стал депутатом Государственной думы")).toBe(false);
  });

  it("настоящие судебные и криминальные слова остаются", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("суд Франции освободил его под подписку")).toBe(true);
    expect(crim.test("возбуждено уголовное дело")).toBe(true);
    expect(crim.test("служба судебных приставов")).toBe(true);
    expect(crim.test("прокуратура Ниццы начала расследование")).toBe(true);
  });

  it("«судьба» судом не является", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("непростая судьба предпринимателя")).toBe(false);
    expect(crim.test("Судьбоносным это время стало и для него")).toBe(false);
  });

  it("«администрация» не делает материал политическим, а «министр» делает", () => {
    const pol = theme("political_exposure");
    expect(pol.test("администрация подписала распоряжение")).toBe(false);
    expect(pol.test("министр финансов выступил")).toBe(true);
  });

  it("«долгое время» не является долговым спором", () => {
    const fin = theme("financial_claims");
    expect(fin.test("личная жизнь долгое время обсуждалась")).toBe(false);
    expect(fin.test("суд постановил взыскать долги")).toBe(true);
    expect(fin.test("задолженность перед банком")).toBe(true);
  });
});

describe("признак негативного материала", () => {
  it("не срабатывает на «судьбе»", () => {
    expect(getAdversePatterns().test("непростая судьба предпринимателя")).toBe(false);
  });

  it("срабатывает на суде и санкциях", () => {
    expect(getAdversePatterns().test("суд признал требования обоснованными")).toBe(true);
    expect(getAdversePatterns().test("введены санкции")).toBe(true);
  });
});
