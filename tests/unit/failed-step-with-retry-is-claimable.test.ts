/**
 * Шаг, которому назначен повтор, воркер обязан забрать.
 *
 * Поймано на боевом прогоне 28.07 (Тиньков, полный аудит). База собралась —
 * все семь провайдеров `completed`, Arsenkin отдал 522 наблюдения, — а прогон
 * встал на 35% и не двигался четырнадцать минут:
 *
 *     ARSENKIN_ENRICHMENT  state=FAILED  attempts=1/10  nextRunAt=17:58:16
 *     ...  18:12  стадия=FAILED_RETRYABLE  статус=WAITING  прогресс=0.35
 *
 * `applyStepOutcome` при повторяемом отказе пишет ровно «повторить тогда-то, шаг
 * не закончен»: `state: FAILED`, `nextRunAt: now + backoff`, `finished: false`.
 * `autoResumeState` — то, что показывает кабинет, — считает такой шаг
 * возобновляемым и обещает пользователю «продолжится само», прямо поясняя в
 * комментарии: «воркер возьмёт его на ближайшем обороте».
 *
 * А выборка воркера состояния `FAILED` не читала вовсе.
 *
 * Один вопрос — «будет ли шаг повторён сам» — и два ответа, которые расходятся.
 * Кабинет обещал то, чего воркер не сделал бы никогда, а пользователю
 * оставалось дожимать прогон руками — при том что правило проекта прямо
 * обратное.
 *
 * Свойство: состояния, которые считают шаг возобновляемым, и состояния,
 * которые воркер забирает, — это один список.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyStepOutcome } from "../../src/modules/digital-profile/workflow/step-plan";
import { autoResumeState } from "../../src/modules/digital-profile/workflow/auto-resume";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";

const STORE_SRC = readFileSync(
  join(process.cwd(), "src/modules/digital-profile/workflow/step-store.ts"),
  "utf8"
);

/** Состояния, которые забирает выборка воркера. */
function claimableStates(): string[] {
  const m = STORE_SRC.match(/c\."state"\s+IN\s*\(([^)]*)\)/u);
  if (!m) throw new Error("не найден список состояний в выборке шагов");
  return [...m[1]!.matchAll(/'([A-Z_]+)'/gu)].map((x) => x[1]!);
}

const NOW = new Date("2026-07-28T17:58:00.000Z");

function stepRow(over: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  return {
    id: "s1",
    caseId: "c1",
    jobId: "j1",
    name: "ARSENKIN_ENRICHMENT",
    position: 2,
    state: "FAILED",
    attempts: 1,
    maxAttempts: 10,
    nextRunAt: new Date(NOW.getTime() + 60_000),
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: "Arsenkin не показывает продвижения",
    lastErrorCode: "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
    ...over,
  } as WorkflowStepRow;
}

describe("повторяемый отказ шага и выборка воркера", () => {
  it("повторяемый отказ назначает повтор и не закрывает шаг", () => {
    const t = applyStepOutcome(
      { attempts: 0, maxAttempts: 10, name: "ARSENKIN_ENRICHMENT", startedAt: NOW },
      { kind: "failed", retryable: true, message: "провайдер молчит", code: "X" },
      NOW
    );
    expect(t.state).toBe("FAILED");
    expect(t.finished).toBe(false);
    expect(t.nextRunAt).not.toBeNull();
  });

  it("исчерпанный бюджет попыток повтора не назначает", () => {
    const t = applyStepOutcome(
      { attempts: 9, maxAttempts: 10, name: "ARSENKIN_ENRICHMENT", startedAt: NOW },
      { kind: "failed", retryable: true, message: "провайдер молчит", code: "X" },
      NOW
    );
    expect(t.finished).toBe(true);
    expect(t.nextRunAt).toBeNull();
  });

  it("кабинет обещает авто-возврат для такого шага", () => {
    const s = autoResumeState([stepRow()], NOW);
    expect(s.pending).toBe(true);
    expect(s.stepName).toBe("ARSENKIN_ENRICHMENT");
  });

  it("воркер забирает те же состояния, которые обещают авто-возврат", () => {
    // Наблюдавшийся случай: кабинет говорил «продолжится само», а `FAILED`
    // в выборке не было — и прогон стоял, пока его не дожали руками.
    expect(claimableStates()).toContain("FAILED");
  });

  it("исчерпанный отказ выборке недоступен: у него нет срока повтора", () => {
    // Единственный ограничитель здесь — `nextRunAt IS NOT NULL`, и он же
    // отделяет «повторить» от «всё, руками». Проверяем, что он на месте.
    expect(STORE_SRC).toMatch(/c\."nextRunAt"\s+IS\s+NOT\s+NULL/u);
    const exhausted = autoResumeState([stepRow({ attempts: 10 })], NOW);
    expect(exhausted.pending).toBe(false);
  });
});
