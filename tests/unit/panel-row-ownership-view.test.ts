/**
 * Строка панели и её запись в артефакте выводятся вместе.
 *
 * Нарисованная рамка и запись `visibleItems` — два представления одной строки;
 * пока их считали порознь, картинка и текст страницы расходились. Поэтому
 * принадлежность применяется в одном месте, и оба представления берутся из
 * одного результата.
 */

import { describe, expect, it } from "vitest";
import {
  OTHER_SUBJECT_PANEL_TAG,
  panelRowWithOwnership,
} from "@/modules/digital-profile/services/canonical-visual-assets";

const OWN_SANCTIONS = "viktor rashnikov ofac";
const FOREIGN_SANCTIONS = "viktor feliksovich vekselberg ofac";

describe("строка панели и её запись выводятся вместе", () => {
  it("чужая строка: нейтральная рамка и тег вместо запроса", () => {
    const drawn = panelRowWithOwnership({
      item: { ref: "inventory:uae-foreign", title: FOREIGN_SANCTIONS, adverse: true },
      decision: "OTHER_SUBJECT",
      meta: "viktor rashnikov",
    });
    expect(drawn.svg).toEqual({
      label: FOREIGN_SANCTIONS,
      meta: OTHER_SUBJECT_PANEL_TAG,
      adverse: false,
    });
    expect(drawn.visible.adverse).toBe(false);
    expect(drawn.visible.subjectDecision).toBe("OTHER_SUBJECT");
  });

  it("своя строка: рамка и правая колонка как были", () => {
    const drawn = panelRowWithOwnership({
      item: { ref: "inventory:uae-own", title: OWN_SANCTIONS, adverse: true },
      decision: "SUBJECT_MATCH",
      meta: "viktor rashnikov",
    });
    expect(drawn.svg).toEqual({
      label: OWN_SANCTIONS,
      meta: "viktor rashnikov",
      adverse: true,
    });
  });

  it("решение неизвестно — запись строки не выдумывает его", () => {
    const drawn = panelRowWithOwnership({
      item: { ref: "inventory:uae-own", title: OWN_SANCTIONS, adverse: true },
      meta: "viktor rashnikov",
    });
    expect(JSON.parse(JSON.stringify(drawn.visible))).not.toHaveProperty("subjectDecision");
    expect(drawn.svg.adverse).toBe(true);
  });
});
