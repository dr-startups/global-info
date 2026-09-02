/**
 * Отказ на сборке отчёта не требует платить за сбор заново.
 *
 * Наблюдалось у заказчика 28.07: прогон дошёл до конца, упал на сборке
 * («deck assembly failed: required sections failed: EXECUTIVE/EXECUTIVE_SUMMARY:
 * FAILED»), восстановление исчерпало попытки — и единственной кнопкой осталась
 * «Начать новый аудит с повторным сбором данных». То есть выбросить весь
 * оплаченный сбор и заплатить заново из-за ошибки в тексте резюме.
 *
 * Сбор стоит денег у Arsenkin, Serper и Yandex; сборка отчёта — только у GPT и
 * делается на уже собранных наблюдениях. Правило проекта: отказ одного шага не
 * обнуляет оплаченный сбор.
 */

import { describe, expect, it } from "vitest";
import {
  paidRecollectionRequired,
  fullAuditBlockReason,
} from "../../src/modules/digital-profile/services/unified-action-policy";

const STUCK_AFTER_ASSEMBLY = {
  preserved: true,
  recoveryAllowed: false,
  recoveryBlockerReason: "STEP_ATTEMPTS_EXHAUSTED",
  suggestionsMissingResult: false,
};

describe("что предлагать после отказа на сборке отчёта", () => {
  it("пересборка снимает требование платить за новый сбор", () => {
    // Ровно наблюдавшееся состояние.
    expect(paidRecollectionRequired(STUCK_AFTER_ASSEMBLY)).toBe(true);
    expect(paidRecollectionRequired({ ...STUCK_AFTER_ASSEMBLY, rebuildAllowed: true })).toBe(false);
  });

  it("бесплатное действие называется раньше платного", () => {
    expect(fullAuditBlockReason({ ...STUCK_AFTER_ASSEMBLY, rebuildAllowed: true })).toBe(
      "USE_REPORT_REBUILD"
    );
    expect(fullAuditBlockReason(STUCK_AFTER_ASSEMBLY)).toBe(
      "PRESERVED_STAGES_REQUIRE_PAID_RECOLLECTION"
    );
  });

  it("восстановление всё ещё важнее пересборки", () => {
    // Продолжить прогон с места отказа лучше, чем пересобирать его целиком.
    const state = { ...STUCK_AFTER_ASSEMBLY, recoveryAllowed: true, rebuildAllowed: true };
    expect(fullAuditBlockReason(state)).toBe("USE_RECOVERY");
    expect(paidRecollectionRequired(state)).toBe(false);
  });

  it("работающий прогон по-прежнему не зовёт вмешаться", () => {
    for (const reason of ["JOB_PROGRESSING", "JOB_ALREADY_RUNNING", "ACTIVE_LEASE"]) {
      expect(
        paidRecollectionRequired({ ...STUCK_AFTER_ASSEMBLY, recoveryBlockerReason: reason })
      ).toBe(false);
    }
  });
});
