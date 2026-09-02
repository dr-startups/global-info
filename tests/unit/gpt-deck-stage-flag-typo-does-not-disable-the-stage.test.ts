/**
 * Стадии GPT над пакетами секций включаются кодом, а не переменной окружения.
 *
 * `gpt-enhanced-deck-build.ts` читал `ORION_GPT_DECK_EDITOR` и
 * `ORION_GPT_DECK_COMPOSER` своим разбором:
 * `String(process.env.X ?? "1") !== "0"`. У такого разбора понятна ровно одна
 * форма «выключено», а всё остальное — включено; зато сама настройка жила в
 * окружении, где по правилу проекта живут только секреты. Это та же форма
 * дефекта, что закрыта на `OPEN_SANCTIONS_ENABLED`: решение о стадии
 * принималось не там, где записаны умолчания.
 *
 * Разрешение здесь — ключ, а не флаг: без слоя GPT (`input.gpt`) обе стадии не
 * выполняются вовсе, поэтому умолчание «включено» ничего не открывает.
 *
 * Свойство: умолчание записано в `config/defaults.ts`, читается общим
 * `boolSetting`, осознанное «0» стадию выключает, а опечатка — нет.
 */

import { describe, expect, it } from "vitest";
import {
  BOOLEAN_DEFAULTS,
  boolSetting,
} from "@/modules/digital-profile/config/defaults";
import {
  deckComposerEnabled,
  deckEditorEnabled,
} from "@/modules/digital-profile/orion-golden/deck-sections/gpt-enhanced-deck-build";

describe("умолчания стадий GPT живут в config/defaults.ts", () => {
  it("обе стадии записаны среди настроек-переключателей", () => {
    expect(BOOLEAN_DEFAULTS.ORION_GPT_DECK_EDITOR).toBe(true);
    expect(BOOLEAN_DEFAULTS.ORION_GPT_DECK_COMPOSER).toBe(true);
  });

  it("при пустом окружении обе стадии включены", () => {
    expect(deckEditorEnabled({})).toBe(true);
    expect(deckComposerEnabled({})).toBe(true);
  });

  it("читаются тем же разбором, что и остальные переключатели", () => {
    expect(boolSetting("ORION_GPT_DECK_EDITOR", {})).toBe(true);
    expect(boolSetting("ORION_GPT_DECK_COMPOSER", {})).toBe(true);
  });
});

describe("выключить стадию можно только осознанно", () => {
  it.each(["0", "false", "off", "no"])("ORION_GPT_DECK_EDITOR=%s выключает редактор", (value) => {
    expect(deckEditorEnabled({ ORION_GPT_DECK_EDITOR: value })).toBe(false);
  });

  it.each(["0", "false", "off", "no"])("ORION_GPT_DECK_COMPOSER=%s выключает композер", (value) => {
    expect(deckComposerEnabled({ ORION_GPT_DECK_COMPOSER: value })).toBe(false);
  });

  it.each(["maybe", "yes!", "ага", "enabled"])(
    "непонятое значение %j редактор не выключает",
    (value) => {
      expect(deckEditorEnabled({ ORION_GPT_DECK_EDITOR: value })).toBe(true);
    }
  );

  it.each(["maybe", "yes!", "ага", "enabled"])(
    "непонятое значение %j композер не выключает",
    (value) => {
      expect(deckComposerEnabled({ ORION_GPT_DECK_COMPOSER: value })).toBe(true);
    }
  );

  it("стадии выключаются по отдельности", () => {
    expect(deckEditorEnabled({ ORION_GPT_DECK_COMPOSER: "0" })).toBe(true);
    expect(deckComposerEnabled({ ORION_GPT_DECK_EDITOR: "0" })).toBe(true);
  });
});
