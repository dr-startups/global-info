/**
 * Строка выдачи, принадлежность которой не подтверждена, так и называется.
 *
 * Прогон DPA-2026-0049: в таблице ТОП-20 стояли страницы офтальмолога, депутата
 * и четырёх ИП с оценками «Нейтральный» и «Не проверено» — читатель понимал их
 * как материалы о себе. Оценка «Принадлежность не подтверждена» стоит **выше**
 * «Нежелательного» (решение владельца 04.09.2026): отчёт читает сам субъект, и
 * чужой негатив, покрашенный красным, дороже приглушённого сигнала, который всё
 * равно остаётся в приложении.
 */

import { describe, expect, it } from "vitest";
import { serpVerdictLabel } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  OTHER_SUBJECT_LABEL,
  RED_MARKER_LABEL,
  UNCONFIRMED_SUBJECT_LABEL,
  UNVERIFIED_LABEL,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

describe("оценка строки выдачи", () => {
  it("совпало только имя — принадлежность не подтверждена", () => {
    expect(
      serpVerdictLabel({ other: false, adverse: false, likely: false, verified: false, unconfirmed: true })
    ).toBe(UNCONFIRMED_SUBJECT_LABEL);
  });

  it("чужой негатив не красится красным", () => {
    expect(
      serpVerdictLabel({ other: false, adverse: true, likely: false, verified: true, unconfirmed: true })
    ).toBe(UNCONFIRMED_SUBJECT_LABEL);
  });

  it("материал другого лица называется прямо и стоит выше всех", () => {
    expect(
      serpVerdictLabel({ other: true, adverse: true, likely: false, verified: true, unconfirmed: true })
    ).toBe(OTHER_SUBJECT_LABEL);
  });

  it("подтверждённый негатив остаётся нежелательным", () => {
    expect(
      serpVerdictLabel({ other: false, adverse: true, likely: false, verified: true, unconfirmed: false })
    ).toBe(RED_MARKER_LABEL);
  });

  it("прежние оценки не двигаются", () => {
    expect(
      serpVerdictLabel({ other: false, adverse: false, likely: true, verified: false, unconfirmed: false })
    ).toBe("Вероятно");
    expect(
      serpVerdictLabel({ other: false, adverse: false, likely: false, verified: true, unconfirmed: false })
    ).toBe("Нейтральный");
    expect(
      serpVerdictLabel({ other: false, adverse: false, likely: false, verified: false, unconfirmed: false })
    ).toBe(UNVERIFIED_LABEL);
  });
});
