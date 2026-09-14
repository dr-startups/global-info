/**
 * Неудачная пересборка видна в шапке дела.
 *
 * QA MVP 14.09.2026, «Усманов»: «Пересобрать отчёт» и «Выпустить» дважды
 * заканчивались ASSEMBLY_QA_FAILED, джоба возвращалась к прежнему
 * REPORT_READY со старым PDF, запрос выпуска снимался — и админка не говорила
 * ни слова: готовый отчёт без ошибки. Причина жила только в `warnings` джобы
 * (`report-rebuild-failed:<код>`, `report-rebuild-failed-detail:<текст>`),
 * которые клиент получал и не показывал.
 *
 * Один разбор двух строк — `rebuildFailureOf`; шапка печатает его словами из
 * словаря, где ключ обязан существовать на обоих языках.
 */

import { describe, expect, it } from "vitest";
import { rebuildFailureOf } from "@/modules/digital-profile/client/rebuild-failure-notice";
import { ru } from "@/modules/digital-profile/i18n/dictionaries/ru";
import { en } from "@/modules/digital-profile/i18n/dictionaries/en";
import { warningsForNewRebuild } from "@/modules/digital-profile/services/unified-report-rebuild";

describe("неудачная пересборка видна", () => {
  it("две строки предупреждений дают код и текст", () => {
    expect(
      rebuildFailureOf([
        "arsenkin-provider-refused:paa:403",
        "report-rebuild-failed:ASSEMBLY_QA_FAILED",
        "report-rebuild-failed-detail:ASSEMBLY_QA_FAILED: таблица YANDEX: материал не напечатан",
      ])
    ).toEqual({
      code: "ASSEMBLY_QA_FAILED",
      detail: "ASSEMBLY_QA_FAILED: таблица YANDEX: материал не напечатан",
    });
  });

  it("без строк — null; без detail — код и пустой текст", () => {
    expect(rebuildFailureOf([])).toBeNull();
    expect(rebuildFailureOf(["report-rebuild-accepted"])).toBeNull();
    expect(rebuildFailureOf(["report-rebuild-failed:RENDER_FAILED"])).toEqual({ code: "RENDER_FAILED", detail: "" });
  });

  it("словарь знает плашку на обоих языках", () => {
    expect(typeof ru.unified.rebuildFailed).toBe("string");
    expect(ru.unified.rebuildFailed).toContain("{code}");
    expect(typeof en.unified.rebuildFailed).toBe("string");
  });

  it("новая пересборка снимает отметки прежней неудачи и ставит свою", () => {
    expect(
      warningsForNewRebuild([
        "arsenkin-provider-refused:paa:403",
        "report-rebuild-failed:ASSEMBLY_QA_FAILED",
        "report-rebuild-failed-detail:ASSEMBLY_QA_FAILED: таблица",
        "report-rebuild-accepted",
      ])
    ).toEqual(["arsenkin-provider-refused:paa:403", "report-rebuild-accepted"]);
  });
});
