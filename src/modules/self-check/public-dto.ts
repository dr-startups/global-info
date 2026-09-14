/**
 * Что из записи проверки и панели персоны видит посетитель.
 *
 * Снимок панели и статус конвейера написаны для оператора: строки выдачи со
 * ссылками и доменами, коды причин, подробности провайдеров, оценки совпадения,
 * адрес и браузер посетителя, связь с кейсом. Посетителю отдаётся только то,
 * что рисует экран, — и собирается здесь, в одном месте, а не вычёркивается
 * по месту в каждой ручке.
 */

import type { SelfCheck } from "@prisma/client";
import type {
  PersonaCard,
  PersonaCheckRow,
  PersonaPanelSnapshot,
  PersonaSourceFetchStatus,
  PersonaSourceName,
} from "@/modules/digital-profile/services/subject-persona-check";

// ---------------------------------------------------------------------------
// Панель персоны
// ---------------------------------------------------------------------------

export type PublicSourceStatus = "ok" | "unavailable" | "not_configured" | "timeout";

const SOURCE_STATUS: Record<PersonaSourceFetchStatus, PublicSourceStatus> = {
  SUCCESS: "ok",
  NOT_CONFIGURED: "not_configured",
  TIMEOUT: "timeout",
  FAILED: "unavailable",
  // Офлайн — наше внутреннее состояние; посетителю это «источник не ответил».
  OFFLINE: "unavailable",
};

const DESCRIPTION_LIMIT = 300;

export interface PublicPersonaCard {
  cardId: string;
  source: PersonaSourceName;
  title: string;
  description: string | null;
  imageUrl: string | null;
  /** Только у статьи Википедии: у остальных источников ссылку не отдаём. */
  url: string | null;
  /** Только у санкционной карточки: у неё одной дата рождения структурная. */
  birthDates: string[];
  birthDateMatches: boolean;
}

export interface PublicPersonaPanel {
  checkId: string;
  cards: PublicPersonaCard[];
  sources: Array<{ source: PersonaSourceName; status: PublicSourceStatus }>;
  decision: null | {
    decision: string;
    selectedCardId: string | null;
    decidedAt: Date | string | null;
  };
}

function shortText(text: string | null | undefined): string | null {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return null;
  return flat.length <= DESCRIPTION_LIMIT ? flat : `${flat.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

function httpsOnly(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\//iu.test(url) ? url : null;
}

export function publicPersonaCard(card: PersonaCard): PublicPersonaCard {
  switch (card.source) {
    case "wikipedia":
      return {
        cardId: card.cardId,
        source: card.source,
        title: card.title,
        description: shortText(card.lead || card.snippet),
        imageUrl: null,
        url: httpsOnly(card.articles[0]?.url),
        birthDates: [],
        birthDateMatches: false,
      };
    case "knowledge_graph":
      return {
        cardId: card.cardId,
        source: card.source,
        title: card.title,
        description: shortText(card.description),
        imageUrl: httpsOnly(card.imageUrl),
        url: null,
        birthDates: [],
        birthDateMatches: false,
      };
    case "opensanctions":
      return {
        cardId: card.cardId,
        source: card.source,
        title: card.matchedName,
        description: shortText(card.topicLabels.join(", ")),
        imageUrl: null,
        url: null,
        birthDates: [...card.datesOfBirth],
        birthDateMatches: Boolean(card.birthDateMatches),
      };
  }
}

export function publicPersonaPanel(row: PersonaCheckRow): PublicPersonaPanel {
  const snapshot = row.personasJson as PersonaPanelSnapshot | null;
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards : [];
  const selected =
    (row.selectedPersonaJson as { card?: { cardId?: string } } | null)?.card?.cardId ?? null;
  return {
    checkId: row.id,
    cards: cards.map(publicPersonaCard),
    sources: (snapshot?.sources ?? []).map((s) => ({
      source: s.source,
      status: SOURCE_STATUS[s.status] ?? "unavailable",
    })),
    decision: row.decision
      ? { decision: row.decision, selectedCardId: selected, decidedAt: row.decidedAt }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Статус проверки
// ---------------------------------------------------------------------------

/**
 * Тексты отказов для посетителя — по машинной причине записи. Без внутренней
 * кухни: ни кодов провайдеров, ни слова «лимит IP».
 */
const BLOCKED_MESSAGES: Record<string, string> = {
  SELF_CHECK_DISABLED: "Проверка временно недоступна. Попробуйте позже.",
  RATE_LIMITED: "Сегодня проверок больше, чем мы можем обработать. Попробуйте завтра.",
  DAILY_LIMIT: "Сегодня проверок больше, чем мы можем обработать. Попробуйте завтра.",
  CAPTCHA_FAILED: "Не удалось подтвердить, что вы не робот. Обновите страницу.",
};
const BLOCKED_FALLBACK = "Проверку не удалось запустить. Попробуйте позже.";
const FAILED_MESSAGE = "Не удалось завершить проверку. Оставьте контакты — проверим вручную.";

export interface PublicSelfCheckStatus {
  publicId: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  /** Для заголовка «Проверка: ФИО, дата рождения». */
  subject: { fullName: string; birthDate: string } | null;
  persona: { decided: boolean; cardsCount: number };
  /** Прогона пока нет. */
  run: null;
  /** Вердикта пока нет. */
  result: null;
  lead: { submitted: boolean; at: Date | null };
  blocked: { reason: string; message: string } | null;
}

function subjectOf(check: SelfCheck): PublicSelfCheckStatus["subject"] {
  const input = check.inputJson as { fullName?: unknown; birthDate?: unknown } | null;
  if (typeof input?.fullName !== "string" || typeof input.birthDate !== "string") return null;
  return { fullName: input.fullName, birthDate: input.birthDate };
}

function blockedOf(check: SelfCheck): PublicSelfCheckStatus["blocked"] {
  if (check.status === "BLOCKED") {
    const reason = check.blockedReason ?? "UNKNOWN";
    return { reason, message: BLOCKED_MESSAGES[reason] ?? BLOCKED_FALLBACK };
  }
  if (check.status === "FAILED") {
    return { reason: check.blockedReason ?? "RUN_FAILED", message: FAILED_MESSAGE };
  }
  return null;
}

export function publicSelfCheckStatus(
  check: SelfCheck,
  persona: PersonaCheckRow | null
): PublicSelfCheckStatus {
  const snapshot = persona?.personasJson as PersonaPanelSnapshot | null | undefined;
  return {
    publicId: check.publicId,
    status: check.status,
    createdAt: check.createdAt,
    expiresAt: check.expiresAt,
    subject: subjectOf(check),
    persona: {
      // Собранная, но нерешённая панель — не решение.
      decided: Boolean(persona?.decision),
      cardsCount: Array.isArray(snapshot?.cards) ? snapshot.cards.length : 0,
    },
    run: null,
    result: null,
    lead: { submitted: check.leadAt !== null, at: check.leadAt },
    blocked: blockedOf(check),
  };
}
