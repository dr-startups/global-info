/**
 * «Нежелательный» — обвинение, и оно ставится только подтверждённому материалу.
 *
 * Лестница ярлыков уже ставила принадлежность выше содержания (решение
 * владельца 04.09.2026), но спрашивала о ней узко: два кода причины из
 * `UNCONFIRMED_SUBJECT_REASONS`. Материал с решением `AMBIGUOUS` по коду
 * `surname_query_no_anchor` или `INSUFFICIENT_IDENTIFIERS` по коду
 * `no_subject_tokens` печатался «Нежелательным» — то есть отчёт обвинял
 * читателя в том, что нашлось по одной фамилии или вовсе без его имени.
 *
 * Правка достраивает ту же лестницу: обвинение требует решения `SUBJECT_MATCH`.
 * Ярлыки нейтральных и непроверенных строк не двигаются — там утверждения нет.
 */

import { describe, expect, it } from "vitest";
import { serpVerdictLabel } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  OTHER_SUBJECT_LABEL,
  RED_MARKER_LABEL,
  UNCONFIRMED_SUBJECT_LABEL,
  UNVERIFIED_LABEL,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

const base = {
  other: false,
  adverse: false,
  likely: false,
  verified: false,
  unconfirmed: false,
  confirmed: false,
};

describe("оценка строки: принадлежность спрашивается раньше негатива", () => {
  it("негатив без подтверждённой принадлежности обвинением не печатается", () => {
    expect(serpVerdictLabel({ ...base, adverse: true, verified: true })).toBe(
      UNCONFIRMED_SUBJECT_LABEL
    );
  });

  it("подтверждённый негатив остаётся нежелательным", () => {
    expect(
      serpVerdictLabel({ ...base, adverse: true, verified: true, confirmed: true })
    ).toBe(RED_MARKER_LABEL);
  });

  it("материал другого лица называется прямо и стоит выше всех", () => {
    expect(
      serpVerdictLabel({ ...base, other: true, adverse: true, verified: true, confirmed: true })
    ).toBe(OTHER_SUBJECT_LABEL);
  });

  it("ненегативная строка ярлык не меняет: утверждения в ней нет", () => {
    expect(serpVerdictLabel({ ...base, verified: true })).toBe("Нейтральный");
    expect(serpVerdictLabel({ ...base })).toBe(UNVERIFIED_LABEL);
    expect(serpVerdictLabel({ ...base, likely: true })).toBe("Вероятно");
  });

  it("прежний узкий признак «совпало только имя» продолжает работать", () => {
    expect(serpVerdictLabel({ ...base, unconfirmed: true, verified: true })).toBe(
      UNCONFIRMED_SUBJECT_LABEL
    );
  });
});
