/**
 * Экран ожидания: прошедшее время, прогресс и две стадии.
 *
 * Только то, что отдаёт ручка: стадия, прогресс, время запуска. Счётчиков
 * страниц и лога запросов на живой проверке нет — ручка их не отдаёт, и рисовать
 * их значило бы выдумывать данные. Что входит в стадию — постоянный состав
 * лёгкого прогона, а не состояние опроса.
 */

import { RUN_STAGE_LABELS, RUN_STAGES, type RunStage } from "@/modules/self-check/run-stages";
import type { RunJson } from "./types";

export type { RunJson } from "./types";

export interface WaitingStage {
  key: RunStage;
  label: string;
  what: string;
  state: "done" | "current" | "pending";
  stateWord: string;
}

export interface WaitingView {
  elapsedText: string;
  percent: number;
  currentLabel: string;
  stages: WaitingStage[];
}

const STAGE_WHAT: Readonly<Record<RunStage, string>> = {
  collecting:
    "Первые страницы выдачи, картинки, видео и подсказки, энциклопедии, справочники, санкционные и PEP‑списки",
  verdict: "Темы находок и уровень риска",
};

const STATE_WORDS = { done: "готово", current: "идёт", pending: "ожидает" } as const;

/** «1:23» — минуты и секунды с запуска. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function waitingView(run: RunJson, nowMs: number): WaitingView {
  const currentIndex = RUN_STAGES.indexOf(run.stage);
  const progress = Number.isFinite(run.progress) ? Math.min(1, Math.max(0, run.progress)) : 0;
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  return {
    elapsedText: formatElapsed(Number.isFinite(started) ? nowMs - started : 0),
    percent: Math.round(progress * 100),
    currentLabel: RUN_STAGE_LABELS[run.stage],
    stages: RUN_STAGES.map((key, index) => {
      const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
      return { key, label: RUN_STAGE_LABELS[key], what: STAGE_WHAT[key], state, stateWord: STATE_WORDS[state] };
    }),
  };
}
