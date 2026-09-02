/**
 * Human-readable labels for report-quality empty-state / GPT codes.
 * Pure helpers — no React; used by ReportQualityPanel and offline smoke.
 *
 * Локаль передаётся аргументом, а не берётся из контекста: модуль остаётся
 * чистым и вызывается из офлайн-смока. По умолчанию — русский, как было до
 * шага 11.4, чтобы существующие вызовы не меняли поведение.
 */

import type { JobReportQualityDTO } from "./api";
import type { Locale } from "../i18n";

const EMPTY_STATE_REASONS: Record<Locale, Record<string, string>> = {
  ru: {
    "no-data": "Нет данных по поверхности после завершённого сбора",
    "no-suggestions": "Подсказки поиска не найдены (или не дошли до сводного набора)",
    "no-images": "Изображения не найдены",
    "no-images-continued": "Нет дополнительных изображений для продолжения",
    "no-related": "Блок «Связанные вопросы» пуст",
    "no-ai-answers": "AI-ответы не найдены",
    "no-organic-data": "Органическая выдача пуста",
    "no-identity-data": "Нет материалов для блока идентичности / Wikipedia",
    "no-regional-findings": "Нет подтверждённых находок по региону",
    "no-verified-findings": "Нет проверенных негативных находок",
    "no-appendix-material": "Нет материалов для приложения",
    "no-compliance-records": "Проверка выполнена, записей о субъекте нет",
    "compliance-check-not-performed": "Проверка по базе не выполнялась — это не результат «совпадений нет»",
    "compliance-records-excluded": "Проверка выполнена; найденные записи в отчёт не включены",
    "executive-summary-artifact-missing": "Не сформирован артефакт итогового резюме",
    VISUAL_ASSET_UNAVAILABLE: "Визуальный материал недоступен, показан текст",
  },
  en: {
    "no-data": "No data for this surface after the collection finished",
    "no-suggestions": "No search suggestions found (or they never reached the merged set)",
    "no-images": "No images found",
    "no-images-continued": "No further images to continue with",
    "no-related": "The “related questions” block is empty",
    "no-ai-answers": "No AI answers found",
    "no-organic-data": "Organic results are empty",
    "no-identity-data": "No material for the identity / Wikipedia block",
    "no-regional-findings": "No confirmed findings for this region",
    "no-verified-findings": "No verified adverse findings",
    "no-appendix-material": "No material for the appendix",
    "no-compliance-records": "Checked; no records about the subject",
    "compliance-check-not-performed": "The database was not screened — this is not a «no matches» result",
    "compliance-records-excluded": "Screened; the records found are not included in the report",
    "executive-summary-artifact-missing": "The executive summary artifact was not produced",
    VISUAL_ASSET_UNAVAILABLE: "The visual asset is unavailable, text is shown instead",
  },
};

const GPT_STAGE1: Record<Locale, Record<string, string>> = {
  ru: {
    APPLIED: "Применён",
    FAILED: "Резервный вариант (ошибка или неверный формат)",
    SKIPPED: "Пропущен (AI выключен)",
    MISSING: "Нет артефакта",
  },
  en: {
    APPLIED: "Applied",
    FAILED: "Fallback (error or validation)",
    SKIPPED: "Skipped (AI disabled)",
    MISSING: "No artifact",
  },
};

const NO_REASON: Record<Locale, string> = {
  ru: "Причина не указана",
  en: "No reason given",
};

const UNKNOWN_REASON: Record<Locale, string> = {
  ru: "Неизвестная причина",
  en: "Unknown reason",
};

export function describeEmptyStateReason(reason: string, locale: Locale = "ru"): string {
  const key = String(reason ?? "").trim();
  if (!key) return NO_REASON[locale];
  const table = EMPTY_STATE_REASONS[locale];
  if (table[key]) return table[key]!;
  // Soft-match prefixes used by builders
  for (const [code, label] of Object.entries(table)) {
    if (key === code || key.startsWith(`${code}:`)) return label;
  }
  return `${UNKNOWN_REASON[locale]}: ${key}`;
}

export function describeGptStage1Status(status: string, locale: Locale = "ru"): string {
  return GPT_STAGE1[locale][status] ?? status;
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
