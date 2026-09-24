/**
 * Ответы публичных ручек так, как их видит браузер: даты — строками ISO.
 *
 * Сайт не импортирует серверные модули проверки даже типами, поэтому форма
 * ответа описана здесь. Расхождение с проекцией сервера (`public-dto.ts`) ловит
 * проверка типов: тест экрана ожидания присваивает JSON проекции этим типам.
 */

import type { RunStage } from "@/modules/self-check/run-stages";

export type RiskStep = "low" | "medium" | "high";

export interface RunJson {
  stage: RunStage;
  stageLabel: string;
  progress: number;
  nextPollMs: number;
  startedAt: string | null;
}

export interface ResultJson {
  verdict: string;
  /** Ступень шкалы отчёта; у «данных недостаточно» уровня нет. */
  riskLevel: RiskStep | null;
  materialsFound: number;
  findingsTotal: number;
  themes: Array<{ id: string; label: string; count: number; level: RiskStep | null }>;
  partial: boolean;
  /** Ответившие группы источников: search, surfaces, open_sources, sanctions. */
  sourcesChecked: string[];
  checkedAt: string | null;
}

export interface PublicStatusJson {
  publicId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  subject: { fullName: string; birthDate: string } | null;
  persona: { decided: boolean; cardsCount: number };
  run: RunJson | null;
  result: ResultJson | null;
  lead: { submitted: boolean; at: string | null };
  blocked: { reason: string; message: string } | null;
}

export type PersonaSourceName = "wikipedia" | "knowledge_graph" | "opensanctions";

export interface PersonaCardJson {
  cardId: string;
  source: PersonaSourceName;
  title: string;
  description: string | null;
  imageUrl: string | null;
  url: string | null;
  birthDates: string[];
  birthDateMatches: boolean;
}

export interface PersonaSourceJson {
  source: PersonaSourceName;
  status: "ok" | "unavailable" | "not_configured" | "timeout";
}

export interface PersonaPanelJson {
  checkId: string;
  cards: PersonaCardJson[];
  sources: PersonaSourceJson[];
  decision: null | { decision: string; selectedCardIds: string[]; decidedAt: string | null };
}

/** Что статическая страница узнаёт у `GET /api/site/config`. */
export interface SitePublicConfig {
  selfCheckEnabled: boolean;
  captchaClientKey: string | null;
  metrikaId: string | null;
}
