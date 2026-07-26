/**
 * Шаг 12.4 плана.
 *
 * «Где мы остановились» — один вопрос, и ответ на него должен быть один.
 *
 * До этого ответ выводился эвристиками из шести полей джобы: `stage`,
 * `resumeCheckpoint`, длины `enrichmentRunIds`, флага `enrichmentComplete`
 * внутри блоба, `lastErrorCode` и наличия `compositeDatasetId`. Там и жили
 * дефекты: «пять прогонов зарегистрировано, задач две» проходило проверку
 * `enrichmentCount >= 5`, и восстановление уходило опрашивать несуществующие
 * задачи до исчерпания бюджета.
 *
 * Со строками шагов вопрос тривиален: первый незавершённый шаг и есть место
 * остановки. Модуль чистый — ни БД, ни сети.
 */

import { nextRunnableStep } from "./step-plan";
import type { WorkflowStepRow } from "./step-types";

/**
 * Причины возобновления. Значения совпадают с прежними `recoveryReason`,
 * чтобы контракт API и подписи кнопок в интерфейсе не поехали.
 */
export const RESUME_REASON_BY_STEP: Readonly<Record<string, string>> = {
  BASE_COLLECTION: "BASE_RESUME",
  ARSENKIN_ENRICHMENT: "ARSENKIN_INGEST_RESUME",
  COMPOSITE_MERGE: "ASSEMBLY_RESUME",
  REPORT_PREPARE: "RENDER_RESUME",
};

export type StepResumePlan =
  | { kind: "resume"; stepName: string; reason: string; requeue: boolean }
  | { kind: "completed" }
  | { kind: "in_progress"; stepName: string }
  | { kind: "exhausted"; stepName: string; reason: string };

/**
 * Что делать с прогоном, судя по его шагам.
 *
 * `requeue` отвечает на отдельный вопрос: нужно ли вернуть шаг в очередь. Шаг,
 * который упал, воркер сам не подберёт — его надо разбудить. Шаг, который
 * просто ждёт своего времени, будить не нужно и вредно: это участило бы опрос
 * провайдера.
 */
export function planResumeFromSteps(
  steps: readonly WorkflowStepRow[],
  now: Date
): StepResumePlan {
  if (steps.length === 0) return { kind: "completed" };

  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const pending = ordered.find((s) => s.state !== "DONE" && s.state !== "SKIPPED");
  if (!pending) return { kind: "completed" };

  const reason = RESUME_REASON_BY_STEP[pending.name] ?? "FAILED_RETRYABLE_RESUME";

  if (pending.state === "FAILED") {
    // Исчерпанный бюджет — не «нажмите ещё раз»: причина не в невезении, и
    // повтор без разбора сожжёт ещё один бюджет.
    if (pending.attempts >= pending.maxAttempts) {
      return { kind: "exhausted", stepName: pending.name, reason };
    }
    return { kind: "resume", stepName: pending.name, reason, requeue: true };
  }

  // Живая лиза — шаг прямо сейчас исполняется другим процессом.
  if (pending.leaseUntil && pending.leaseUntil.getTime() > now.getTime()) {
    return { kind: "in_progress", stepName: pending.name };
  }

  // Расписание в силе и время ещё не пришло — работа идёт штатно.
  if (nextRunnableStep(ordered, now) === null && pending.nextRunAt) {
    return { kind: "in_progress", stepName: pending.name };
  }

  // Шаг готов к исполнению, но никем не взят — например, процесс умер, не
  // сняв лизу, или расписание потерялось. Разбудить безопасно.
  return { kind: "resume", stepName: pending.name, reason, requeue: !pending.nextRunAt };
}

/** Есть ли у прогона шаги вообще — старые прогоны созданы до шага 12. */
export function hasStepPipeline(steps: readonly WorkflowStepRow[]): boolean {
  return steps.length > 0;
}
