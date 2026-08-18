/**
 * Отказ ворот телеметрии возобновляется с чекпоинта рендера.
 *
 * `RENDER_FAILED` давно попадает в `RENDER_RESUME`: подготовка возобновляется с
 * рендера, а не с нуля. Два кода ворот шага (`CONTENT_DROPPED_BY_RENDERER`,
 * `RENDER_TELEMETRY_MISSING`) в этот путь не попали — восстановление отвечало
 * `FAILED_TERMINAL_NOT_RECOVERABLE`, то есть повтор рендера прогону с
 * испорченным документом не предлагался вовсе.
 *
 * Почему повтор законен для обоих кодов: рендер детерминирован и сам по себе
 * денег не стоит. `RENDER_TELEMETRY_MISSING` — это прежде всего окно деплоя
 * (новое приложение, старый рендерер ещё без поля телеметрии), и после выкатки
 * рендерера повтор проходит. `CONTENT_DROPPED_BY_RENDERER` упрётся в ту же
 * детерминированную потерю — быстро и с тем же исходом, что и пересборка.
 *
 * Насколько путь дешевле пересборки — вопрос не этого модуля и сегодня решён
 * не в его пользу: реюз собранной деки не срабатывает из-за расхождения
 * идентификаторов набора (§8 ENGINEERING.md).
 *
 * Модуль чистый: ни сети, ни базы, ни файлов.
 */

import { describe, expect, it } from "vitest";
import { evaluateLegacyRecoveryEligibility } from "@/modules/digital-profile/services/unified-recovery-legacy-heuristic";
import type {
  BaseCollectionManifest,
  UnifiedCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-types";

const CASE = "unit-free-rerender";
const JOB = "unified-free-rerender";

const MANIFEST: BaseCollectionManifest = {
  version: "base-collection-manifest-v1",
  unifiedJobId: JOB,
  caseId: CASE,
  capturedAt: "2026-08-18T00:00:00.000Z",
  baseReportRunId: "base-run-1",
  searchResultIds: ["sr-1", "sr-2"],
  searchSurfaceItemIds: ["si-1"],
  baseCount: 3,
  actualProviders: [],
  realCollectionSufficient: true,
};

/** Прогон, доехавший до рендера: сбор оплачен, составной набор цел. */
function jobAfterRender(patch: Partial<UnifiedCollectionJob>): UnifiedCollectionJob {
  return {
    version: "unified-orion-collection-job-v1",
    jobId: JOB,
    unifiedJobId: JOB,
    caseId: CASE,
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    progress: 0.9,
    versionNum: 7,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T01:00:00.000Z",
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T01:00:00.000Z",
    requestedBy: "unit-tester",
    arsenkinMode: "full-first36",
    baseReportRunId: "base-run-1",
    arsenkinReportRunId: null,
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    arsenkinEnrichmentState: { enrichmentComplete: true } as UnifiedCollectionJob["arsenkinEnrichmentState"],
    compositeDatasetId: "composite-1",
    actualProviders: [],
    coverage: null,
    warnings: ["CANONICAL_PREPARE_BLOCKED"],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    ...patch,
  };
}

async function reasonFor(patch: Partial<UnifiedCollectionJob>) {
  return await evaluateLegacyRecoveryEligibility({
    job: jobAfterRender(patch),
    manifest: MANIFEST,
  });
}

describe("восстановление после отказа ворот телеметрии", () => {
  it("потеря содержимого лечится повторным рендером", async () => {
    const elig = await reasonFor({
      lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
      lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
    });

    expect(elig.recoveryReason).toBe("RENDER_RESUME");
    expect(elig.recoveryAllowed).toBe(true);
    expect(elig.recoveryBlockerReason).toBeNull();
  });

  it("окно деплоя без телеметрии тоже лечится повторным рендером", async () => {
    const elig = await reasonFor({
      lastErrorCode: "RENDER_TELEMETRY_MISSING",
      lastError: "прогон остановлен: телеметрия разметки недоступна после рендера",
    });

    expect(elig.recoveryReason).toBe("RENDER_RESUME");
    expect(elig.recoveryAllowed).toBe(true);
  });

  it("без составного набора повтор рендера не предлагается", async () => {
    // Повторный рендер переиспользует собранную деку; без составного набора
    // переиспользовать нечего, и кнопка стала бы приглашением к пустой работе.
    const elig = await reasonFor({
      lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
      compositeDatasetId: null,
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryAllowed).toBe(false);
  });

  it("отказ сбора повторным рендером не лечится", async () => {
    // Контроль: `RENDER_RESUME` получают именно отказы рендера. Код, к рендеру
    // отношения не имеющий, обязан остаться при прежнем ответе.
    const elig = await reasonFor({
      lastErrorCode: "ARSENKIN_ENRICHMENT_FAILED",
      lastError: "обогащение Arsenkin не завершилось",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("FAILED_TERMINAL_NOT_RECOVERABLE");
  });

  it("прежние отказы рендера отвечают как раньше", async () => {
    // Семантика `RENDER_RESUME` для чужих случаев не поехала: `RENDER_FAILED`
    // приходит возобновляемым и с чекпоинтом рендера — ответ тот же, что и до
    // добавления новых кодов.
    const elig = await reasonFor({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      resumeCheckpoint: "RENDER",
      lastErrorCode: "RENDER_FAILED",
      lastError: "render failed",
    });

    expect(elig.recoveryReason).toBe("RENDER_RESUME");
  });

  it("детерминированный гейт не подменяется повторным рендером", async () => {
    // Порядок ветвей — часть решения: гейт, вычисляемый из собранных данных,
    // повтором не лечится, и чекпоинт рендера на джобе не должен превращать
    // честное «повтор не поможет» в приглашение нажать.
    const elig = await reasonFor({
      resumeCheckpoint: "RENDER",
      lastErrorCode: "MATERIAL_THEME_COVERAGE",
      lastError: "prepare gate failed: MATERIAL_THEME_COVERAGE=87.5",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
  });

  it("возобновляемый отказ не рендера остаётся общим повтором", async () => {
    const elig = await reasonFor({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      lastErrorCode: "PREPARE_DB_UNAVAILABLE",
      lastError: "database unavailable",
    });

    expect(elig.recoveryReason).toBe("FAILED_RETRYABLE_RESUME");
  });
});

/**
 * Приглашение к повтору рендера ключуется **кодом отказа**, а не признаком
 * «похоже на рендер». Признак `isRenderFailure` шире трёх кодов: он истинен и
 * при чекпоинте `RENDER` (терминальные патчи подготовки чекпоинт не чистят, и
 * он остаётся от прошлой попытки), и при свободном тексте «render failed» в
 * сообщении. Отказы, случившиеся до рендера, повтором рендера не лечатся:
 * кнопка была бы приглашением к работе, которая не может помочь, и стоила бы
 * полного прохода GPT — реюз собранной деки сегодня не срабатывает.
 */
describe("повтор рендера предлагается ровно трём кодам", () => {
  it.each(["RENDER_FAILED", "CONTENT_DROPPED_BY_RENDERER", "RENDER_TELEMETRY_MISSING"])(
    "%s остаётся возобновляемым с рендера",
    async (lastErrorCode) => {
      const elig = await reasonFor({ lastErrorCode });

      expect(elig.recoveryReason).toBe("RENDER_RESUME");
      expect(elig.recoveryAllowed).toBe(true);
    }
  );

  it("нехватка входных данных подготовки повтором рендера не лечится", async () => {
    // Отказ случился до рендера, а чекпоинт `RENDER` остался на джобе от
    // прошлой попытки: терминальный патч подготовки его не сбрасывает.
    const elig = await reasonFor({
      resumeCheckpoint: "RENDER",
      lastErrorCode: "PREPARE_INPUT_MISSING",
      lastError: "missing binding/merge/manifest before prepare",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("FAILED_TERMINAL_NOT_RECOVERABLE");
  });

  it("негодные счётчики сборки и рендера повтором рендера не лечатся", async () => {
    const elig = await reasonFor({
      resumeCheckpoint: "RENDER",
      lastErrorCode: "ASSEMBLY_RENDER_COUNT_INVALID",
      lastError: "expected valid assembly/render counts, got assembly=2 render=1",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("FAILED_TERMINAL_NOT_RECOVERABLE");
  });

  it("слова «render failed» в чужом сообщении кнопку не открывают", async () => {
    // Код отказа — свой, а совпадение по свободному тексту опознанием рендера
    // не является: сообщение подготовки может пересказывать что угодно.
    const elig = await reasonFor({
      lastErrorCode: "CANONICAL_PREPARE_FAILED",
      lastError: "prepare aborted: upstream render failed earlier in the chain",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("FAILED_TERMINAL_NOT_RECOVERABLE");
  });

  it("отказ ворот готовности отчёта повтором рендера не лечится", async () => {
    const elig = await reasonFor({
      resumeCheckpoint: "RENDER",
      lastErrorCode: "REPORT_READY_GATE_FAILED",
      lastError: "client content dataset mismatch",
    });

    expect(elig.recoveryReason).not.toBe("RENDER_RESUME");
    expect(elig.recoveryBlockerReason).toBe("FAILED_TERMINAL_NOT_RECOVERABLE");
  });
});
