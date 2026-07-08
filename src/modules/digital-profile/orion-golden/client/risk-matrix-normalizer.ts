/**
 * R10.2 — Client-safe risk matrix normalization with Russian fallbacks.
 */

import {
  humanizeRiskLevel,
  humanizeRiskTheme,
  sanitizeOrionGoldenClientText,
} from "./client-text-sanitizer";

export type ClientRiskMatrixRow = {
  theme: string;
  level: string;
  summary: string;
};

export type InternalRiskLevel = "low" | "medium" | "high" | "critical" | "review_required";

const GENERIC_THEME = "Потенциальное совпадение, требующее дополнительной верификации";

export function mapInternalRiskLevel(value: unknown): InternalRiskLevel {
  const raw = String(value ?? "").toLowerCase();
  if (["low", "низк", "minimal"].some((k) => raw.includes(k))) return "low";
  if (["medium", "умерен", "moderate", "средн"].some((k) => raw.includes(k))) return "medium";
  if (["critical", "крит"].some((k) => raw.includes(k))) return "critical";
  if (["high", "повыш", "elevated", "высок"].some((k) => raw.includes(k))) return "high";
  return "review_required";
}

function fallbackSummary(levelLabel: string, theme: string): string {
  const lvl = levelLabel.toLowerCase();
  if (lvl.includes("крит")) {
    return "Выявлен сигнал повышенной значимости; требуется срочная ручная проверка первоисточников и подтверждение связи с субъектом.";
  }
  if (lvl.includes("высок")) {
    return "Обнаружены признаки повышенного риска; необходимо подтвердить релевантность и содержание источников до принятия решения.";
  }
  if (lvl.includes("средн")) {
    return "Имеются предварительные индикаторы, требующие дополнительной верификации и сопоставления с идентификаторами субъекта.";
  }
  if (lvl.includes("низк")) {
    return "Сигнал оценивается как ограниченный; рекомендуется подтвердить контекст совпадения при наличии связи с субъектом.";
  }
  if (theme.includes("комплаенс") || theme.includes("Lexis")) {
    return "Требуется ручная проверка записей в compliance-базах и подтверждение идентификации субъекта.";
  }
  return "Требуется ручная проверка найденных совпадений и источников.";
}

function isWeakTheme(theme: string): boolean {
  const t = theme.trim().toLowerCase();
  return !t || t === "риск" || t === "risk" || t.length < 4;
}

function isWeakSummary(summary: string): boolean {
  const s = summary.trim();
  return !s || s.length < 12;
}

/** Keeps internal enum levels for GPT/schema validation; improves Russian theme/summary. */
export function normalizeInternalRiskMatrixRow(row: ClientRiskMatrixRow): ClientRiskMatrixRow {
  const internalLevel = mapInternalRiskLevel(row.level);
  let theme = humanizeRiskTheme(row.theme);
  if (isWeakTheme(theme)) theme = GENERIC_THEME;

  let summary = sanitizeOrionGoldenClientText(row.summary);
  if (isWeakSummary(summary)) {
    summary = fallbackSummary(humanizeRiskLevel(internalLevel), theme);
  }

  return { theme, level: internalLevel, summary };
}

export function normalizeInternalRiskMatrix(rows: ClientRiskMatrixRow[]): ClientRiskMatrixRow[] {
  const normalized = rows.map(normalizeInternalRiskMatrixRow);
  if (normalized.length > 0) return normalized;

  const level: InternalRiskLevel = "review_required";
  return [
    {
      theme: GENERIC_THEME,
      level,
      summary: fallbackSummary(humanizeRiskLevel(level), GENERIC_THEME),
    },
  ];
}

/** Humanizes levels/themes for client-facing deck/report text. */
export function humanizeClientRiskMatrixRow(row: ClientRiskMatrixRow): ClientRiskMatrixRow {
  const internalLevel = mapInternalRiskLevel(row.level);
  let theme = row.theme.trim();
  if (isWeakTheme(theme)) theme = GENERIC_THEME;
  else theme = humanizeRiskTheme(theme);

  let summary = sanitizeOrionGoldenClientText(row.summary);
  if (isWeakSummary(summary)) {
    summary = fallbackSummary(humanizeRiskLevel(internalLevel), theme);
  }

  return {
    theme,
    level: humanizeRiskLevel(internalLevel),
    summary,
  };
}

export function sanitizeExecutiveClientFields(input: {
  executiveSummary: string;
  globalRiskLevel: InternalRiskLevel;
  mainRisks: string[];
  possibleConsequences: string[];
  finalRecommendations: string[];
  nextSteps: string[];
}): typeof input {
  return {
    executiveSummary: sanitizeOrionGoldenClientText(input.executiveSummary),
    globalRiskLevel: input.globalRiskLevel,
    mainRisks: input.mainRisks.map(sanitizeOrionGoldenClientText).filter(Boolean),
    possibleConsequences: input.possibleConsequences.map(sanitizeOrionGoldenClientText).filter(Boolean),
    finalRecommendations: input.finalRecommendations.map(sanitizeOrionGoldenClientText).filter(Boolean),
    nextSteps: input.nextSteps.map(sanitizeOrionGoldenClientText).filter(Boolean),
  };
}

export function humanizeExecutiveSummaryForClient(
  executive: {
    executiveSummary: string;
    globalRiskLevel: InternalRiskLevel;
    mainRisks: string[];
    possibleConsequences: string[];
    finalRecommendations: string[];
    nextSteps: string[];
  }
): {
  executiveSummary: string;
  globalRiskLevel: string;
  mainRisks: string[];
  possibleConsequences: string[];
  finalRecommendations: string[];
  nextSteps: string[];
} {
  return {
    ...executive,
    executiveSummary: sanitizeOrionGoldenClientText(executive.executiveSummary),
    globalRiskLevel: humanizeRiskLevel(executive.globalRiskLevel),
    mainRisks: executive.mainRisks.map(sanitizeOrionGoldenClientText),
    possibleConsequences: executive.possibleConsequences.map(sanitizeOrionGoldenClientText),
    finalRecommendations: executive.finalRecommendations.map(sanitizeOrionGoldenClientText),
    nextSteps: executive.nextSteps.map(sanitizeOrionGoldenClientText),
  };
}
