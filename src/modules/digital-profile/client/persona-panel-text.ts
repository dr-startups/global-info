/**
 * Слова панели выбора персоны — по коду причины, а не готовой фразой.
 *
 * Снимок панели несёт машинный код и параметры; текст для человека живёт в
 * словарях `i18n/dictionaries/{ru,en}.ts`. Пока фразу собирал сервер, она
 * печаталась как есть в обоих кабинетах: в английском выходило
 * `Wikipedia: failed — Википедия не ответила: HTTP 429`.
 *
 * Здесь же живут решения панели о том, что показать, когда карточек нет: их
 * можно проверить исполнением, а разметку — нельзя, и молчаливое «панель ещё
 * не собиралась» вместо непрочитанного состояния родилось именно там.
 */

import { DigitalProfileApiError, type PersonaSourceStateDTO } from "./api";

/** Якорь блока панели на странице дела: имя одно на обе стороны перехода. */
export const PERSONA_PANEL_ANCHOR = "subject-persona-panel";

export interface PersonaPhrase {
  key: string;
  vars?: Record<string, string | number>;
}

export interface PersonaCardTail {
  key: string;
  snippet: string;
}

export type PersonaPanelView = "LOADING" | "LOAD_FAILED" | "NOT_BUILT" | "BUILT";

/** Причина, по которой источник не дал карточек; null — источник ответил. */
export function personaSourceReason(source: PersonaSourceStateDTO): PersonaPhrase | null {
  switch (source.code) {
    case null:
      return null;
    case "NETWORK_CALLS_DISABLED":
      return { key: "persona.reasonOffline" };
    case "PERSONA_PANEL_BUDGET_EXCEEDED":
      // Миллисекунды — машинная величина: оператор читает секунды.
      return {
        key: "persona.reasonTimeout",
        vars: { seconds: Math.round((source.waitedMs ?? 0) / 1000) },
      };
    case "PROVIDER_NOT_CONFIGURED":
      return { key: "persona.reasonNotConfigured" };
    default:
      return source.detail
        ? { key: "persona.reasonFailed", vars: { detail: source.detail } }
        : { key: "persona.reasonUnknown" };
  }
}

/**
 * Что показать под заголовком карточки Википедии, когда лида нет.
 *
 * «Не спрашивали» и «спрашивали и не получили» — разные ответы: у Википедии
 * на плотной серии обычен 429, и карточка из одного заголовка не говорит
 * оператору ничего. Сниппет поиска показывается в обоих случаях.
 */
export function personaWikipediaTail(card: {
  lead: string | null;
  leadRequested: boolean;
  snippet: string;
}): PersonaCardTail | null {
  if (card.lead) return null;
  return {
    key: card.leadRequested ? "persona.tailLeadMissing" : "persona.tailNoLead",
    snippet: card.snippet,
  };
}

/**
 * Что панель показывает вместо карточек.
 *
 * Непрочитанное состояние — не «панель ещё не собиралась»: она, возможно,
 * собиралась и решение принято. Выдумывать состояние, которого мы не знаем,
 * запрещено тем же правилом, что и пустой слайд без причины.
 */
export function personaPanelView(input: {
  state: { check: unknown } | null;
  loadFailed: boolean;
}): PersonaPanelView {
  if (input.loadFailed) return "LOAD_FAILED";
  if (!input.state) return "LOADING";
  return input.state.check ? "BUILT" : "NOT_BUILT";
}

/** Причина ворот → ключ словаря. Ворота считает сервер; здесь только слова. */
const GATE_BLOCK_KEYS: Record<string, string> = {
  PERSONA_NOT_CONFIRMED: "persona.blockedNotConfirmed",
  PERSONA_DECISION_STALE: "persona.blockedStale",
  PERSONA_GATE_UNAVAILABLE: "persona.blockedUnavailable",
};

/** Ключ словаря для отказа старта по воротам; null — отказ не про персону. */
export function personaBlockKey(err: unknown): string | null {
  if (!(err instanceof DigitalProfileApiError) || err.code !== "CONFLICT") return null;
  const reason = (err.details as { reason?: string } | undefined)?.reason;
  return (reason ? GATE_BLOCK_KEYS[reason] : null) ?? null;
}
