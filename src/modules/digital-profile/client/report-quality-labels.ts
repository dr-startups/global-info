/**
 * Human-readable Russian labels for report-quality empty-state / GPT codes.
 * Pure helpers — no React; used by ReportQualityPanel and offline smoke.
 */

import type { JobReportQualityDTO } from "./api";

const EMPTY_STATE_REASONS: Record<string, string> = {
  "no-data": "Нет данных по поверхности после завершённого сбора",
  "no-suggestions": "Подсказки поиска не найдены (или не дошли до composite)",
  "no-images": "Изображения не найдены",
  "no-images-continued": "Нет дополнительных изображений для продолжения",
  "no-related": "Блок «Связанные вопросы» пуст",
  "no-ai-answers": "AI-ответы не найдены",
  "no-organic-data": "Органическая выдача пуста",
  "no-identity-data": "Нет материалов для блока идентичности / Wikipedia",
  "no-regional-findings": "Нет подтверждённых находок по региону",
  "no-verified-findings": "Нет верифицированных adverse-находок",
  "no-appendix-material": "Нет материалов для приложения",
  "executive-summary-artifact-missing": "Не сформирован артефакт executive summary",
  VISUAL_ASSET_UNAVAILABLE: "Визуальный актив недоступен (показан текстовый fallback)",
};

const GPT_STAGE1: Record<string, string> = {
  APPLIED: "Применён",
  FAILED: "Fallback (ошибка / валидация)",
  SKIPPED: "Пропущен (AI выключен)",
  MISSING: "Нет артефакта",
};

export function describeEmptyStateReason(reason: string): string {
  const key = String(reason ?? "").trim();
  if (!key) return "Причина не указана";
  if (EMPTY_STATE_REASONS[key]) return EMPTY_STATE_REASONS[key]!;
  // Soft-match prefixes used by builders
  for (const [code, label] of Object.entries(EMPTY_STATE_REASONS)) {
    if (key === code || key.startsWith(`${code}:`)) return label;
  }
  return `Неизвестная причина: ${key}`;
}

export function describeGptStage1Status(status: string): string {
  return GPT_STAGE1[status] ?? status;
}

export function gptStage1Tone(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "APPLIED") return "ok";
  if (status === "FAILED") return "danger";
  if (status === "SKIPPED") return "neutral";
  return "warn";
}

export function formatFunnelValue(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return String(n);
}

/** Normalize payloads from jobs saved before §0.4 (no emptyState array). */
export function normalizeJobReportQuality(
  quality: JobReportQualityDTO
): JobReportQualityDTO {
  const slides = quality.slides ?? {
    total: 0,
    withContent: 0,
    emptyStateCount: 0,
    emptyState: [],
  };
  const emptyState = Array.isArray(slides.emptyState) ? slides.emptyState : [];
  return {
    ...quality,
    counts: quality.counts ?? ({} as JobReportQualityDTO["counts"]),
    gpt: quality.gpt ?? {
      stage1Status: "MISSING",
      stage2Applied: 0,
      stage2FallbackError: 0,
      stage2FallbackValidation: 0,
      caseAnalysisUsed: false,
    },
    visuals: quality.visuals ?? { built: 0, failed: 0, warning: null },
    arsenkin: quality.arsenkin ?? {
      enrichmentComplete: null,
      enrichmentObservationCount: null,
      agentsOk: 0,
      agentsFailed: 0,
    },
    slides: {
      total: slides.total ?? 0,
      withContent: slides.withContent ?? 0,
      emptyStateCount: slides.emptyStateCount ?? emptyState.length,
      emptyState,
    },
    render: quality.render ?? {
      pdfExportMode: null,
      warningCount: 0,
      sidebarDegradedCount: 0,
    },
  };
}
