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
import { numberSetting } from "@/modules/digital-profile/config/defaults";
import {
  clientRiskStep,
  type ClientRiskStep,
} from "@/modules/digital-profile/orion-golden/client/risk-scale";
import type { LightRunView } from "./light-run";
import { RUN_STAGE_LABELS, type RunStage } from "./run-stages";
import {
  selectedCardIdsOf,
  type PersonaCard,
  type PersonaCheckRow,
  type PersonaPanelSnapshot,
  type PersonaSourceFetchStatus,
  type PersonaSourceName,
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
    /** Отмеченные карточки одного человека; пусто — решение без персоны. */
    selectedCardIds: string[];
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
  return {
    checkId: row.id,
    cards: cards.map(publicPersonaCard),
    sources: (snapshot?.sources ?? []).map((s) => ({
      source: s.source,
      status: SOURCE_STATUS[s.status] ?? "unavailable",
    })),
    decision: row.decision
      ? { decision: row.decision, selectedCardIds: selectedCardIdsOf(row), decidedAt: row.decidedAt }
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

/** Интервал опроса статуса страницей проверки — настройка с нижней границей. */
export function selfCheckPollMs(env: Record<string, string | undefined> = process.env): number {
  return numberSetting("SELF_CHECK_POLL_INTERVAL_MS", env);
}

export interface PublicRunStatus {
  stage: RunStage;
  stageLabel: string;
  progress: number;
  nextPollMs: number;
  startedAt: Date | null;
}

export interface PublicResult {
  verdict: string;
  /** Ступень шкалы отчёта; у «данных недостаточно» уровня нет. */
  riskLevel: ClientRiskStep | null;
  materialsFound: number;
  findingsTotal: number;
  themes: Array<{ id: string; label: string; count: number; level: ClientRiskStep | null }>;
  partial: boolean;
  /** Ответившие группы источников: search, surfaces, open_sources, sanctions. */
  sourcesChecked: string[];
  checkedAt: Date | null;
}

export interface PublicSelfCheckStatus {
  publicId: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  /** Для заголовка «Проверка: ФИО, дата рождения». */
  subject: { fullName: string; birthDate: string } | null;
  persona: { decided: boolean; cardsCount: number };
  /** Ход прогона — только у идущей проверки. */
  run: PublicRunStatus | null;
  /** Результат — только у проверки с вердиктом. */
  result: PublicResult | null;
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

function runOf(
  check: SelfCheck,
  view: LightRunView | null,
  env: Record<string, string | undefined>
): PublicRunStatus | null {
  if (check.status !== "RUNNING") return null;
  const running = view?.kind === "running" ? view : { stage: "collecting" as const, progress: 0 };
  return {
    stage: running.stage,
    stageLabel: RUN_STAGE_LABELS[running.stage],
    progress: running.progress,
    nextPollMs: selfCheckPollMs(env),
    startedAt: check.runStartedAt,
  };
}

/**
 * Результат — уровнями шкалы отчёта: три ступени и одно место схлопывания
 * (`risk-scale.ts`). Своей таблицы уровней у сайта нет.
 */
function resultOf(check: SelfCheck): PublicResult | null {
  if (check.status !== "DONE" || !check.verdict) return null;
  const themes = Array.isArray(check.themesJson)
    ? (check.themesJson as Array<Record<string, unknown>>)
    : [];
  const sources = Array.isArray(check.sourcesJson) ? (check.sourcesJson as unknown[]).map(String) : [];
  return {
    verdict: check.verdict,
    riskLevel: check.riskLevel ? clientRiskStep(check.riskLevel) : null,
    materialsFound: check.materialsFound ?? 0,
    findingsTotal: check.findingsTotal ?? 0,
    themes: themes.map((theme) => ({
      id: String(theme.id),
      label: String(theme.label),
      count: Number(theme.count ?? 0),
      level: clientRiskStep(String(theme.level ?? "")),
    })),
    partial: check.partial,
    sourcesChecked: sources,
    checkedAt: check.verdictAt,
  };
}

export function publicSelfCheckStatus(
  check: SelfCheck,
  persona: PersonaCheckRow | null,
  run: LightRunView | null = null,
  env: Record<string, string | undefined> = process.env
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
    run: runOf(check, run, env),
    result: resultOf(check),
    lead: { submitted: check.leadAt !== null, at: check.leadAt },
    blocked: blockedOf(check),
  };
}
