/**
 * «Что будет дальше» — один список на двух экранах: заявка обещает шаги, а
 * «спасибо» показывает тот же список с отметкой о приёме.
 *
 * Жило в `LeadScreen.tsx`, переехало сюда: экран «спасибо» рисует ход доской
 * («шаг 1 из 4»), а доля хода — счёт, который стоит проверить тестом, а не
 * глазами. TSX vitest проекта не собирает, поэтому счёт живёт вне разметки.
 */

import { NEXT_STEPS } from "@/modules/site/content/check";
import type { PublicStatusJson } from "./types";

export type NextSteps = ReadonlyArray<readonly [string, string]>;

export function nextStepsFor(status: PublicStatusJson): NextSteps {
  if (status.status === "DONE" && status.result?.verdict === "NEGATIVE_FOUND") return NEXT_STEPS.NEGATIVE_FOUND;
  if (status.status === "DONE" && status.result?.verdict === "CLEAN") return NEXT_STEPS.CLEAN;
  return NEXT_STEPS.MANUAL;
}

export interface ThanksProgress {
  step: number;
  total: number;
  fraction: number;
}

/** Приём заявки — первый шаг того же списка, поэтому шагов на один больше. */
export function thanksProgress(steps: NextSteps): ThanksProgress {
  const total = steps.length + 1;
  return { step: 1, total, fraction: 1 / total };
}
