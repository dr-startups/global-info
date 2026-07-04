import type { AiAnalystNarrative, AiAnalystDomainSummary, AiAnalystThemeSummary } from "../types";
import type { AiAnalystEvidencePack, AiAnalystEvidencePackRegion } from "./evidence-pack";

function regionThemes(region: AiAnalystEvidencePackRegion | undefined): AiAnalystThemeSummary[] {
  if (!region) return [];
  const rows = region.topThemes.map((t) => ({
    label: t.label,
    explanation:
      t.label.includes("классификации") || t.label.includes("classification")
        ? "Сигналы этой группы объединены и требуют ручной аналитической классификации."
        : "Группа отражает повторяющиеся сигналы по релевантным источникам.",
    evidenceCount: t.count,
    status: "requires_review" as const,
  }));
  const unknownRows = rows.filter((r) => r.label.includes("классификации") || r.label.includes("classification"));
  const knownRows = rows.filter((r) => !r.label.includes("классификации") && !r.label.includes("classification"));
  if (unknownRows.length <= 1) return rows.slice(0, 6);
  const mergedUnknown = {
    ...unknownRows[0],
    evidenceCount: unknownRows.reduce((acc, row) => acc + row.evidenceCount, 0),
  };
  return [...knownRows, mergedUnknown].slice(0, 6);
}

function regionDomains(region: AiAnalystEvidencePackRegion | undefined): AiAnalystDomainSummary[] {
  if (!region) return [];
  return region.topDomains.map((d) => ({
    domain: d.domain || "domain unavailable",
    label: d.domain || "domain unavailable",
    explanation: "Домен регулярно появляется в сигналах по данному региону.",
    evidenceCount: d.count,
    status: "requires_review",
  }));
}

function mediumRiskReason(pack: AiAnalystEvidencePack): string {
  if (pack.risk.overallLevel.toUpperCase() !== "MEDIUM") {
    return pack.language === "ru"
      ? "Уровень риска сформирован по подтверждённым и проверочным сигналам в доступных данных."
      : "Risk level is derived from confirmed and review-queue signals in available evidence.";
  }
  if (pack.totals.confirmedNegative === 0) {
    return "Предварительный уровень риска MEDIUM связан не с подтверждёнными негативными публикациями, а с материалами и сигналами, которые требуют ручной проверки.";
  }
  return pack.language === "ru"
    ? "Уровень MEDIUM поддерживается сочетанием подтверждённых и неподтверждённых сигналов, требующих дополнительной проверки."
    : "MEDIUM reflects a mix of confirmed and unresolved signals requiring additional review.";
}

function potentialReason(pack: AiAnalystEvidencePack): string {
  if (pack.totals.potentialNegative > 0 && pack.totals.confirmedNegative === 0) {
    return "Подтверждённых негативных материалов не выявлено, однако обнаружены материалы, требующие аналитической проверки.";
  }
  return pack.language === "ru"
    ? "Обнаруженные материалы разделены на подтверждённые и требующие проверки."
    : "Detected materials are separated into confirmed and review-required groups.";
}

function providerWarning(pack: AiAnalystEvidencePack): string[] {
  if (pack.providerAvailability.unavailableCount <= 0) return [];
  return [
    "Часть внешних источников была недоступна на момент проверки; выводы построены по доступным данным и требуют ручной проверки.",
  ];
}

export function buildDeterministicAiAnalystNarrative(
  pack: AiAnalystEvidencePack,
  options: { status?: "fallback" | "unavailable"; warnings?: string[] } = {}
): AiAnalystNarrative {
  const language = pack.language;
  const ru = pack.regions.ru;
  const intl = pack.regions.intl;
  const status = options.status ?? "fallback";
  const providerWarnings = providerWarning(pack);
  const manualReviewCore = pack.totals.reviewRequired > 0
    ? [
        language === "ru"
          ? "В отчёте есть сигналы, которые требуют ручной аналитической проверки перед выводами."
          : "The report contains signals that require analyst review before conclusions.",
      ]
    : [];

  const lexisReady = Boolean(pack.lexisNexis?.importReady);
  const lexisNarrative = pack.lexisNexis
    ? {
        importStatus: lexisReady
          ? "Загруженный отчёт LexisNexis обработан и включён в анализ."
          : "Импорт LexisNexis недоступен или не завершён.",
        screeningConclusion: lexisReady
          ? "Материалы LexisNexis отражены как аналитические сигналы и не трактуются как автоматически подтверждённые выводы."
          : "Выводы по LexisNexis ограничены из-за отсутствия готового импортированного отчёта.",
        matchesSummary: lexisReady
          ? `Сигналы: ${pack.lexisNexis.totalSignals}; документов: ${pack.lexisNexis.totalDocuments}.`
          : "Сигналы LexisNexis отсутствуют в готовом состоянии.",
        reviewRequiredSummary:
          pack.lexisNexis.reviewRequired > 0
            ? `По LexisNexis ${pack.lexisNexis.reviewRequired} сигнал(ов) требуют ручной проверки.`
            : "По LexisNexis подтверждённых значимых совпадений не выявлено, но ручная верификация сохраняется обязательной.",
        visualPagesSummary: lexisReady
          ? `Визуальные страницы LexisNexis: ${pack.lexisNexis.visualPages}.`
          : "Визуальные страницы LexisNexis недоступны.",
      }
    : undefined;

  return {
    status,
    generatedBy: "deterministic",
    provider: "none",
    language,
    generatedAt: new Date().toISOString(),
    meta: {
      evidenceItemsUsed: pack.meta.evidenceItemsUsed,
      truncatedInput: pack.meta.truncatedInput,
      warnings: [...pack.meta.warnings, ...(options.warnings ?? [])],
    },
    executiveSummary: {
      plainConclusion:
        language === "ru"
          ? `Общая оценка риска: ${pack.risk.overallLevel}.`
          : `Overall risk assessment: ${pack.risk.overallLevel}.`,
      riskExplanation: mediumRiskReason(pack),
      whyNotLow:
        pack.totals.reviewRequired > 0
          ? language === "ru"
            ? "Наличие очереди материалов на проверку не позволяет снижать риск до LOW без дополнительной аналитики."
            : "An active review queue prevents downgrading risk to LOW without additional analyst checks."
          : language === "ru"
            ? "Недостаток подтверждённых рисков снижает итоговую оценку."
            : "Limited confirmed risks support a lower final estimate.",
      whatWasFound: [
        potentialReason(pack),
        `Потенциально негативные материалы: ${pack.totals.potentialNegative}/${pack.totals.organicTotal}.`,
        `Сигналы в медиа: изображения ${pack.totals.imagesFlagged}/${pack.totals.imagesTotal}, видео ${pack.totals.videosFlagged}/${pack.totals.videosTotal}.`,
      ],
      whatWasNotConfirmed: [
        language === "ru"
          ? "Подтверждённых негативных материалов в текущем наборе данных не зафиксировано."
          : "No confirmed negative materials are recorded in the current dataset.",
        language === "ru"
          ? "Контекст международных санкционных запросов трактуется как чувствительная зона поиска, а не подтверждённый факт."
          : "Sanctions query context is treated as sensitive search scope, not a confirmed fact.",
      ],
      manualReviewRequired: [...manualReviewCore, `Очередь на проверку: ${pack.totals.reviewRequired}.`],
      nextActions: [
        language === "ru"
          ? "Провести ручную проверку материалов из очереди review-required."
          : "Run manual analyst review for review-required items.",
        language === "ru"
          ? "Подтвердить или снять сигналы по ключевым доменам и темам."
          : "Confirm or dismiss signals for key domains and themes.",
        language === "ru"
          ? "Повторно оценить итоговый уровень риска после ручной верификации."
          : "Reassess overall risk after manual verification.",
      ],
    },
    regionNarratives: {
      ru: ru
        ? {
            confirmedNegativeSummary:
              language === "ru"
                ? `Подтверждённые негативные материалы: ${ru.organicConfirmedNegative}.`
                : `Confirmed negative materials: ${ru.organicConfirmedNegative}.`,
            potentialNegativeSummary:
              language === "ru"
                ? `Потенциально негативные материалы: ${ru.organicPotentialNegative}/${ru.organicTotal}.`
                : `Potentially negative materials: ${ru.organicPotentialNegative}/${ru.organicTotal}.`,
            reviewRequiredSummary:
              language === "ru"
                ? `Требуют ручной проверки: ${ru.organicReviewRequired}; исключено как шум: ${ru.organicExcludedNoise}.`
                : `Require review: ${ru.organicReviewRequired}; excluded as noise: ${ru.organicExcludedNoise}.`,
            topThemes: regionThemes(ru),
            keyDomains: regionDomains(ru),
            riskExplanation: mediumRiskReason(pack),
            recommendedActions: [
              "Уточнить принадлежность неоднозначных публикаций субъекту.",
              "Проверить визуальные сигналы и источники перед фиксацией выводов.",
            ],
          }
        : undefined,
      intl: intl
        ? {
            confirmedNegativeSummary: `Подтверждённые негативные материалы: ${intl.organicConfirmedNegative}.`,
            potentialNegativeSummary: `Потенциально негативные материалы: ${intl.organicPotentialNegative}/${intl.organicTotal}.`,
            reviewRequiredSummary: `Требуют ручной проверки: ${intl.organicReviewRequired}.`,
            sanctionsWatchlistContext:
              "Международные запросы по санкционному контексту используются как чувствительная зона поиска и не считаются подтверждёнными совпадениями без верификации.",
            topThemes: regionThemes(intl),
            keyDomains: regionDomains(intl),
            riskExplanation:
              intl.organicReviewRequired > 0
                ? "Даже при отсутствии подтверждённых негативных публикаций международные сигналы требуют ручной аналитики."
                : "Международный сегмент не дал подтверждённых негативных выводов на текущем этапе.",
            recommendedActions: [
              "Проверить международные сигналы на предмет идентичности персоны.",
              "Переоценить санкционный контекст после ручной верификации.",
            ],
          }
        : undefined,
    },
    lexisNexisNarrative: lexisNarrative,
    evidenceInterpretation: {
      confirmed:
        language === "ru"
          ? `Подтверждённые материалы отделены от сигналов на проверке; текущий объём подтверждённых: ${pack.totals.confirmedNegative}.`
          : `Confirmed materials are separated from review signals; current confirmed volume: ${pack.totals.confirmedNegative}.`,
      reviewRequired:
        language === "ru"
          ? `Материалы в статусе review-required: ${pack.totals.reviewRequired}.`
          : `Items in review-required status: ${pack.totals.reviewRequired}.`,
      excludedNoise:
        language === "ru"
          ? `Исключено как шум/тёзки: ${pack.totals.excludedNoise}.`
          : `Excluded as noise/namesakes: ${pack.totals.excludedNoise}.`,
      confidence:
        language === "ru"
          ? "Оценка предварительная и должна быть подтверждена аналитиком на уровне первичных источников."
          : "Assessment is preliminary and must be confirmed by an analyst at primary-source level.",
    },
    clientSafeWarnings: [...providerWarnings],
  };
}
