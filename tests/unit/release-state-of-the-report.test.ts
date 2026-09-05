/**
 * У документа два состояния: черновик и выпуск.
 *
 * Сегодня у собранного отчёта состояние одно — он есть, — и «проверенный
 * аналитиком документ» неотличим от «только что собранного». Пока это так,
 * листу проверки не к чему прикладываться: непонятно, что проверено и что ушло
 * клиенту.
 *
 * Правило: любая сборка даёт черновик; выпуск — отдельное действие, которое
 * пересобирает отчёт и помечает результат. Пометить выпуском без пересборки
 * нельзя: иначе выпуском станет документ, собранный до последних решений.
 */

import { describe, expect, it } from "vitest";
import {
  isReleasedReport,
  releaseStateAfterPrepare,
  type ReportReleaseState,
} from "@/modules/digital-profile/services/report-release-state";
import { restoreStateAfterFailedRebuild } from "@/modules/digital-profile/services/unified-report-rebuild";

const NOW = "2026-09-06T10:00:00.000Z";

describe("состояние документа", () => {
  it("прежняя джоба без блока состояния читается как черновик", () => {
    expect(isReleasedReport(undefined)).toBe(false);
    expect(isReleasedReport(null)).toBe(false);
  });

  it("сборка без запроса выпуска даёт черновик", () => {
    const next = releaseStateAfterPrepare({
      previous: undefined,
      documentSha256: "abc",
      nowIso: NOW,
    });
    expect(next.state).toBe("draft");
    expect(isReleasedReport(next)).toBe(false);
    expect(next.releasedAt ?? null).toBeNull();
  });

  it("пересборка выпущенного отчёта возвращает его в черновик", () => {
    const released: ReportReleaseState = {
      state: "released",
      releasedAt: "2026-09-05T10:00:00.000Z",
      releasedBy: "analyst-1",
      documentSha256: "old",
    };
    const next = releaseStateAfterPrepare({
      previous: released,
      documentSha256: "new",
      nowIso: NOW,
    });
    expect(next.state).toBe("draft");
    expect(next.releasedBy ?? null).toBeNull();
  });

  it("сборка по запросу выпуска даёт выпуск с автором, временем и хешем", () => {
    const next = releaseStateAfterPrepare({
      previous: { state: "draft", requested: { by: "analyst-1", at: NOW } },
      documentSha256: "sha-of-pdf",
      nowIso: NOW,
    });
    expect(next.state).toBe("released");
    expect(next.releasedBy).toBe("analyst-1");
    expect(next.releasedAt).toBe(NOW);
    expect(next.documentSha256).toBe("sha-of-pdf");
    // Запрос израсходован: следующая пересборка не выпустит отчёт молча.
    expect(next.requested ?? null).toBeNull();
    expect(isReleasedReport(next)).toBe(true);
  });

  it("провал пересборки снимает запрос выпуска", () => {
    const restored = restoreStateAfterFailedRebuild(
      {
        stage: "REPORT_READY",
        status: "COMPLETED",
        progress: 1,
        completedAt: NOW,
        reportLinks: {},
        release: { state: "draft", requested: { by: "analyst-1", at: NOW } },
      },
      [],
      { code: "RENDER_FAILED", message: "renderer down" }
    );
    expect(restored.release?.state).toBe("draft");
    expect(restored.release?.requested ?? null).toBeNull();
  });
});
