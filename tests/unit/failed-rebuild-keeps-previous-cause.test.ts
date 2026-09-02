/**
 * Неудачная пересборка возвращает прогон вместе с его причиной.
 *
 * `restoreAfterFailedRebuild` обещает вернуть джобу «ровно как было» и при этом
 * обнуляла `lastError`/`lastErrorCode`. Пока пересборка запускалась только с
 * готового отчёта, это было верно: отчёт цел, причины у него нет. Теперь она
 * запускается и с `FAILED_TERMINAL` — владелец жмёт «Пересобрать», рендерер
 * снова роняет содержимое, и джоба возвращается отказом **без причины**:
 * оператор видит красную строку ни о чём, а прежняя эвристика с пустым кодом
 * предлагает «Возобновить сбор Arsenkin» — ровно тот дефект, который чинили в
 * стороже возраста.
 *
 * Что случилось с самой попыткой, сказано предупреждениями
 * (`report-rebuild-failed:<код>`): у поля одно значение — почему прогон в этом
 * состоянии.
 */

import { describe, expect, it } from "vitest";
import { restoreStateAfterFailedRebuild } from "@/modules/digital-profile/services/unified-report-rebuild";

const SNAPSHOT = {
  stage: "FAILED_TERMINAL",
  status: "FAILED",
  progress: 0.9,
  completedAt: "2026-08-19T22:00:00.000Z",
  reportLinks: {},
  startedAt: "2026-08-19T15:00:00.000Z",
  lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
  lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
};

describe("возврат после неудачной пересборки", () => {
  it("причина прежнего отказа возвращается вместе со стадией", () => {
    const patch = restoreStateAfterFailedRebuild(SNAPSHOT, ["report-rebuild-accepted"], {
      code: "CONTENT_DROPPED_BY_RENDERER",
      message: "рендерер выбросил содержимое (стр. 11)",
    });

    expect(patch.stage).toBe("FAILED_TERMINAL");
    expect(patch.lastErrorCode).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(String(patch.lastError)).toContain("рендерер выбросил содержимое");
  });

  it("готовый отчёт возвращается без причины отказа", () => {
    // Прогон, с которого начинали пересборку, отказом не был: приписывать ему
    // код неудавшейся попытки значило бы выдать целый отчёт за сломанный.
    const patch = restoreStateAfterFailedRebuild(
      {
        ...SNAPSHOT,
        stage: "REPORT_READY",
        status: "COMPLETED",
        lastError: null,
        lastErrorCode: null,
      },
      ["report-rebuild-accepted"],
      { code: "RENDER_FAILED", message: "render failed" }
    );

    expect(patch.stage).toBe("REPORT_READY");
    expect(patch.lastErrorCode).toBeNull();
  });

  it("отметка возраста возвращается к прежней", () => {
    // Иначе прогон, вернувшийся в готовый отчёт, унёс бы с собой право
    // работать ещё шесть часов, которого у него не было.
    const patch = restoreStateAfterFailedRebuild(SNAPSHOT, [], {
      code: "RENDER_FAILED",
      message: "render failed",
    });

    expect(patch.startedAt).toBe(SNAPSHOT.startedAt);
  });

  it("что случилось с попыткой, сказано предупреждениями", () => {
    const patch = restoreStateAfterFailedRebuild(SNAPSHOT, ["report-rebuild-accepted", "иное"], {
      code: "RENDER_FAILED",
      message: "render failed",
    });

    expect(patch.warnings).toContain("report-rebuild-failed:RENDER_FAILED");
    expect(patch.warnings).not.toContain("report-rebuild-accepted");
    expect(patch.warnings).toContain("иное");
  });
});
