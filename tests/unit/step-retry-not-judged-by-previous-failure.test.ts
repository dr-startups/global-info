/**
 * Новая попытка шага не судится вердиктом прошлой.
 *
 * Третий дефект боевого прогона 28.07, найденный после двух первых. Шаг
 * `ARSENKIN_ENRICHMENT` сжигал все десять попыток за 45 секунд, с одним и тем
 * же текстом и **без единой записи об исполнении** в логе воркера:
 *
 *     ARSENKIN_POLL_ATTEMPTS_EXCEEDED
 *     «Arsenkin не показывает продвижения 41 опросов подряд»
 *     при этом pollAttempt на джобе = 0 (сброшен вручную для проверки)
 *
 * Причина: `outcomeFromJob` спрашивает **стадию джобы**, а джоба помнит
 * прошлый отказ. Каждая новая попытка читала чужой вердикт со старым текстом
 * и падала мгновенно, не начав работы.
 *
 * Это тот же класс, что и два предыдущих дефекта этого прогона: на вопрос
 * «упал ли этот шаг» отвечали двое — состояние шага и стадия джобы, — и шаг
 * проиграть был обязан. Перепостановка шага (`requeueStep`) при этом
 * бессмысленна: она чинит один ответ из двух.
 *
 * Свойство: перед исполнением попытки стадия джобы, оставшаяся от прошлого
 * отказа, не должна решать её исход. Отказ прошлой попытки — не свидетельство
 * о новой.
 */

import { describe, expect, it } from "vitest";
import {
  outcomeFromJob,
  stageForRetryAttempt,
} from "../../src/modules/digital-profile/workflow/unified-step-handlers";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";
import type { UnifiedCollectionJob } from "../../src/modules/digital-profile/services/unified-collection-types";

const NOW = new Date("2026-07-28T18:30:00.000Z");

function step(): WorkflowStepRow {
  return {
    id: "s2",
    caseId: "c1",
    jobId: "j1",
    name: "ARSENKIN_ENRICHMENT",
    position: 2,
    state: "RUNNING",
    attempts: 1,
    maxAttempts: 10,
    nextRunAt: NOW,
    leaseOwner: "w1",
    leaseUntil: NOW,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
  } as WorkflowStepRow;
}

function job(over: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  return {
    unifiedJobId: "j1",
    caseId: "c1",
    stage: "ARSENKIN_ENRICHMENT",
    status: "RUNNING",
    warnings: [],
    ...over,
  } as UnifiedCollectionJob;
}

describe("вердикт прошлой попытки и исход новой", () => {
  it("наблюдавшийся случай: стадия отказа отдаёт чужой текст как исход шага", () => {
    // Так это и выглядело: шаг ничего не делал, а получал вердикт из джобы.
    const stale = job({
      stage: "FAILED_RETRYABLE",
      lastError: "Arsenkin не показывает продвижения 41 опросов подряд",
      lastErrorCode: "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
    } as Partial<UnifiedCollectionJob>);
    const o = outcomeFromJob(step(), stale, stale, NOW);
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") {
      expect(o.code).toBe("ARSENKIN_POLL_ATTEMPTS_EXCEEDED");
      expect(o.retryable).toBe(true);
    }
  });

  it("стадия отказа, снятая перед попыткой, исход не решает", () => {
    // После сброса стадии тот же шаг оценивается по своей работе, а не по
    // памяти о прошлом отказе.
    const fresh = job({ stage: "ARSENKIN_ENRICHMENT", lastError: null, lastErrorCode: null });
    const o = outcomeFromJob(step(), fresh, fresh, NOW);
    expect(o.kind).not.toBe("failed");
  });

  it("терминальный отказ остаётся терминальным", () => {
    // Граница «повторим сами» / «нужно решение оператора» не размывается.
    const dead = job({
      stage: "FAILED_TERMINAL",
      lastError: "источник отказал окончательно",
      lastErrorCode: "X",
    } as Partial<UnifiedCollectionJob>);
    const o = outcomeFromJob(step(), dead, dead, NOW);
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") expect(o.retryable).toBe(false);
  });

  it("пауза останавливает шаг, а не пропускает его", () => {
    // До шага 0027 отмена давала `skipped`. Пропуск считается улаженным
    // состоянием: `completeStep` будит следующий шаг, тот тоже пропускается,
    // и каскад `SKIPPED` уносил прогон в «всё готово» — возобновить паузу было
    // бы нечем. Отказ конвейер останавливает и место остановки сохраняет.
    const paused = job({ stage: "CANCELLED" });
    expect(outcomeFromJob(step(), paused, paused, NOW).kind).toBe("failed");
  });

  it("перед новой попыткой повторяемый отказ джобы снимается", () => {
    // Ровно наблюдавшийся случай: джоба помнит FAILED_RETRYABLE, шаг начинает
    // новую попытку — вердикт обязан быть снят, иначе он её и решит.
    expect(stageForRetryAttempt("ARSENKIN_ENRICHMENT", "FAILED_RETRYABLE")).toBe(
      "ARSENKIN_ENRICHMENT"
    );
    expect(stageForRetryAttempt("BASE_COLLECTION", "FAILED_RETRYABLE")).toBe("BASE_COLLECTION");
  });

  it("терминальный отказ и отмена не снимаются", () => {
    // Там граница «нужно решение оператора», и стирать её нельзя.
    expect(stageForRetryAttempt("ARSENKIN_ENRICHMENT", "FAILED_TERMINAL")).toBeNull();
    expect(stageForRetryAttempt("ARSENKIN_ENRICHMENT", "CANCELLED")).toBeNull();
  });

  it("обычная стадия не трогается", () => {
    expect(stageForRetryAttempt("ARSENKIN_ENRICHMENT", "ARSENKIN_ENRICHMENT")).toBeNull();
    expect(stageForRetryAttempt("ARSENKIN_ENRICHMENT", null)).toBeNull();
  });

  it("неизвестный шаг стадию не выдумывает", () => {
    expect(stageForRetryAttempt("НЕТ_ТАКОГО_ШАГА", "FAILED_RETRYABLE")).toBeNull();
  });
});
