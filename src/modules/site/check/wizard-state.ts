/**
 * Какой экран мастера показать — выводится из проекции статуса, отказа ручки и
 * панели «Это вы?», а не хранится в браузере.
 *
 * Посетитель закрывает вкладку посреди ожидания и возвращается по ссылке:
 * экран обязан быть тем, что говорит проверка. Локально живут только шаги,
 * которых в данных нет, — открытая форма заявки и «спасибо».
 */

import { LEAD_ACCEPTING_STATUSES } from "@/modules/self-check/status";
import type { PublicStatusJson } from "./types";

export type { PublicStatusJson } from "./types";

export type WizardScreen =
  | "loading"
  | "persona-loading"
  | "persona"
  | "persona-empty"
  | "start"
  | "waiting"
  | "result-negative"
  | "result-clean"
  | "result-insufficient"
  | "lead"
  | "thanks"
  | "failed"
  | "blocked"
  | "disabled"
  | "limit"
  | "expired"
  | "no-cookie"
  | "not-found"
  | "offline";

/** Отказ ручки: код ответа (0 — сеть) и машинная причина из `details.reason`. */
export interface Refusal {
  status: number;
  reason: string | null;
}

export interface WizardInput {
  status: PublicStatusJson | null;
  refusal: Refusal | null;
  panel: { cards: readonly unknown[] } | null;
  view: "lead" | "thanks" | null;
}

/**
 * Можно ли оставить заявку. Правило ручки — `LEAD_ACCEPTING_STATUSES`; `BLOCKED`
 * экран не предлагает: запись в `BLOCKED` у сайта одна — пойманная ловушкой, и
 * ей ручка заявки отказывает.
 */
export function canLeaveLead(status: PublicStatusJson): boolean {
  return status.status !== "BLOCKED" && LEAD_ACCEPTING_STATUSES.includes(status.status);
}

/**
 * Отказ, который называет экран сам. `400` и `409` экрана не меняют: это
 * второе нажатие или устаревшая страница, и ответ даёт свежий статус.
 */
function refusalScreen(refusal: Refusal): WizardScreen | null {
  // 503 бывает и у настройки площадки (капча, секрет): рубильник при этом
  // включён, и «временно недоступно» было бы неправдой.
  if (refusal.status === 503) return refusal.reason === "SELF_CHECK_DISABLED" ? "disabled" : "offline";
  if (refusal.status === 410) return "expired";
  if (refusal.status === 403) return "no-cookie";
  if (refusal.status === 404) return "not-found";
  if (refusal.status === 429) return "limit";
  if (refusal.status === 0 || refusal.status >= 500) return "offline";
  return null;
}

const RESULT_SCREEN: Readonly<Record<string, WizardScreen>> = {
  NEGATIVE_FOUND: "result-negative",
  CLEAN: "result-clean",
  INSUFFICIENT_DATA: "result-insufficient",
};

export function wizardScreen(input: WizardInput): WizardScreen {
  const byRefusal = input.refusal ? refusalScreen(input.refusal) : null;
  if (byRefusal) return byRefusal;
  const status = input.status;
  if (!status) return "loading";

  switch (status.status) {
    case "CREATED":
      return "persona-loading";
    case "PERSONA_PENDING":
      if (!input.panel) return "persona-loading";
      return input.panel.cards.length > 0 ? "persona" : "persona-empty";
    case "PERSONA_DECIDED":
      return "start";
    case "RUNNING":
      return "waiting";
    case "DONE":
    case "FAILED":
      if (input.view && canLeaveLead(status)) return input.view;
      if (status.status === "FAILED") return "failed";
      // Результата без вердикта быть не должно; если он пуст, «чисто» было бы
      // успокоением без основания.
      return RESULT_SCREEN[status.result?.verdict ?? ""] ?? "result-insufficient";
    case "BLOCKED":
      return "blocked";
    case "EXPIRED":
      return "expired";
    default:
      return "offline";
  }
}

const STEP: Readonly<Partial<Record<WizardScreen, number>>> = {
  "persona-loading": 2,
  persona: 2,
  "persona-empty": 2,
  start: 2,
  waiting: 3,
  failed: 3,
  "result-negative": 4,
  "result-clean": 4,
  "result-insufficient": 4,
  lead: 4,
  thanks: 4,
};

/** Текущий шаг степпера «Данные → Уточнение → Проверка → Результат»; 0 — шагов нет. */
export function wizardStep(screen: WizardScreen): number {
  return STEP[screen] ?? 0;
}
