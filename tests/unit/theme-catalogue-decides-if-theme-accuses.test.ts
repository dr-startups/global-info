/**
 * Обвиняет тема или описывает — свойство каталога тем, а не список рядом с кодом.
 *
 * Каталог переопределяется файлом с диска: в нём меняют формулировки тем,
 * ключевые слова и состав. Пока признак описательности лежал константой в
 * модуле, любой такой файл молча возвращал дефект — «Деловой профиль» снова
 * становился обвиняющим, и нейтрально прочитанная страница переставала быть
 * доказательством темы, для которой она законное доказательство.
 *
 * Умолчание при этом остаётся строгим: тема, про которую каталог ничего не
 * сказал, считается обвиняющей.
 */

import { describe, expect, it } from "vitest";
import {
  compileFindingThemesConfig,
  getDefaultFindingThemesConfigJson,
  getFindingThemes,
  isAccusingTheme,
  type ThemeDef,
} from "@/modules/digital-profile/config/finding-themes";

function themeOf(themes: ThemeDef[], themeId: string): ThemeDef {
  const found = themes.find((t) => t.themeId === themeId);
  if (!found) throw new Error(`темы ${themeId} нет в каталоге`);
  return found;
}

function compiled(json = getDefaultFindingThemesConfigJson()): ThemeDef[] {
  return compileFindingThemesConfig(json, {
    source: "override",
    overridePath: "/dev/null/themes.json",
  }).themes;
}

describe("описательность темы приходит из каталога", () => {
  it("умолчание каталога: описательных тем три, остальные обвиняют", () => {
    const themes = getFindingThemes();
    expect(isAccusingTheme(themeOf(themes, "business_profile"))).toBe(false);
    expect(isAccusingTheme(themeOf(themes, "political_exposure"))).toBe(false);
    // Покупка компании — то, что описывают, а не то, в чём обвиняют.
    expect(isAccusingTheme(themeOf(themes, "corporate_ownership"))).toBe(false);
    for (const id of [
      "criminal_legal",
      "pep_rca_watchlist",
      "offshore_structures",
      "family_associates",
      "financial_claims",
      "security_scrutiny",
    ]) {
      expect(isAccusingTheme(themeOf(themes, id))).toBe(true);
    }
  });

  it("файл переопределения меняет ответ вместе с каталогом", () => {
    const json = getDefaultFindingThemesConfigJson();
    const themes = compiled({
      ...json,
      themes: json.themes.map((t) =>
        t.themeId === "criminal_legal" ? { ...t, accusing: false } : t
      ),
    });
    expect(isAccusingTheme(themeOf(themes, "criminal_legal"))).toBe(false);
    expect(isAccusingTheme(themeOf(themes, "offshore_structures"))).toBe(true);
  });

  it("тема, про которую каталог молчит, считается обвиняющей", () => {
    const json = getDefaultFindingThemesConfigJson();
    // Форма файла на диске: признака в нём нет вовсе — так выглядит любое
    // переопределение, написанное до его появления. Приведение здесь то же,
    // каким читает файл сам загрузчик: разбирает схема, а не типы.
    const themes = compiled({
      ...json,
      themes: json.themes.map(({ accusing: _accusing, ...rest }) => rest),
    } as ReturnType<typeof getDefaultFindingThemesConfigJson>);
    expect(isAccusingTheme(themeOf(themes, "business_profile"))).toBe(true);
    expect(isAccusingTheme(undefined)).toBe(true);
  });
});
