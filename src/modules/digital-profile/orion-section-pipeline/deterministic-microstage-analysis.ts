import type { OrionEvidencePack, OrionGpt55SectionAnalysis, OrionMicroStage } from "./types";
import {
  buildNarrativeBlocksFromAnalysis,
  normalizeMetricCards,
  normalizeSlideTableRows,
} from "./client-slide-contract";

function inferRiskLabel(counts: OrionEvidencePack["counts"]): "LOW" | "MEDIUM" | "HIGH" {
  if (counts.confirmed > 1 || counts.undesirable > 2) return "HIGH";
  if (counts.confirmed > 0 || counts.undesirable > 0 || counts.requiresReview > 3) return "MEDIUM";
  return "LOW";
}

function offerEmphasisLabel(emphasis: string): string {
  switch (emphasis) {
    case "compliance_db_correction":
      return "Корректировка compliance-базы и проверка сигналов Lexis/compliance.";
    case "wikipedia":
      return "Усиление публичного профиля и справочной видимости.";
    default:
      return "Мониторинг поисковой выдачи и репутационных сигналов.";
  }
}

function lexisClientSummary(lexisSignals: OrionEvidencePack["lexisParsedSafeSignals"]): string {
  if (!lexisSignals || lexisSignals.length === 0) {
    return "Импорт LexisNexis для кейса не обнаружен или недоступен.";
  }
  return "В источниках комплаенс-скрининга обнаружены санкционные/watchlist записи и связанные adverse-media упоминания. Это не является юридическим заключением, но требует ручной проверки и EDD.";
}

function buildEvidenceTables(evidencePack: OrionEvidencePack): Array<Record<string, unknown>> {
  const rows = evidencePack.topResults.slice(0, 6).map((item) => ({
    label: String(item.title ?? item.themeLabel ?? item.domain ?? "Источник").slice(0, 80),
    value: String(item.snippet ?? item.classification ?? "").slice(0, 180),
    evidenceRef: item.safeEvidenceId,
  }));
  return normalizeSlideTableRows(rows);
}

function buildLexisSignalTables(
  lexisSignals: NonNullable<OrionEvidencePack["lexisParsedSafeSignals"]>
): Array<Record<string, unknown>> {
  return normalizeSlideTableRows(
    lexisSignals.slice(0, 6).map((signal) => ({
      label: signal.title.slice(0, 80),
      value: signal.reason.slice(0, 180),
      note: signal.reviewRequired ? "Требует ручной проверки" : "Официальная запись / match",
    }))
  );
}

export function buildDeterministicMicrostageAnalysis(input: {
  microStage: OrionMicroStage;
  evidencePack: OrionEvidencePack;
  reason?: string;
}): OrionGpt55SectionAnalysis {
  const { microStage, evidencePack } = input;
  const counts = evidencePack.counts;
  const topThemes = evidencePack.themeGroups.map((x) => x.label);
  const stageKey = microStage.microStageKey;
  const lexisVisualCount = evidencePack.lexisVisualPageRefs?.length ?? 0;
  const lexisSignals = evidencePack.lexisParsedSafeSignals ?? [];
  const hasOfficialLexis = lexisSignals.some((s) => !s.reviewRequired);

  const whatWasFound: string[] = [];
  if (counts.confirmed > 0) whatWasFound.push(`Подтверждено сигналов: ${counts.confirmed}.`);
  if (counts.undesirable > 0) whatWasFound.push(`Нежелательных сигналов: ${counts.undesirable}.`);
  if (counts.potential > 0) whatWasFound.push(`Потенциальных сигналов: ${counts.potential}.`);
  if (lexisSignals.length > 0) {
    whatWasFound.push("Загруженный отчёт LexisNexis обработан; структурированные сигналы включены в аналитику.");
    if (hasOfficialLexis) {
      whatWasFound.push("В материалах комплаенс-скрининга есть официальные записи / database matches.");
    }
  }
  if (lexisVisualCount > 0) {
    whatWasFound.push(`Визуальные страницы LexisNexis готовы к включению в отчёт: ${lexisVisualCount}.`);
  }
  if (evidencePack.keyDomains.length > 0) {
    whatWasFound.push(`Ключевые домены: ${evidencePack.keyDomains.slice(0, 5).join(", ")}.`);
  }
  for (const item of evidencePack.topResults.slice(0, 3)) {
    if (item.title && item.snippet) {
      whatWasFound.push(`${item.title}: ${item.snippet.slice(0, 140)}`);
    }
  }

  const whatRequiresReview: string[] = [];
  if (counts.requiresReview > 0) {
    whatRequiresReview.push(`Материалов в очереди ручной проверки: ${counts.requiresReview}.`);
  }
  if (lexisSignals.some((s) => s.reviewRequired)) {
    whatRequiresReview.push("Часть сигналов LexisNexis требует аналитической верификации.");
  }
  if (whatRequiresReview.length === 0) {
    whatRequiresReview.push("Явных элементов на ручную проверку в этом разделе не выделено.");
  }

  const whatWasNotConfirmed: string[] =
    counts.confirmed === 0
      ? ["Подтверждённые негативные факты в рамках этого раздела не установлены."]
      : ["Часть материалов осталась в статусе потенциальных и не подтверждена как факт."];
  const sourceLimited = String(input.reason ?? "").toLowerCase().includes("unavailable");

  const riskLabel = inferRiskLabel(counts);
  let plainConclusion =
    counts.confirmed > 0 || counts.undesirable > 0
      ? "Обнаружены материалы, влияющие на риск-профиль; вывод требует аналитического подтверждения."
      : counts.requiresReview > 0
        ? "Подтверждённых негативных материалов не выявлено, однако часть результатов требует ручной проверки."
        : "По доступным данным существенных подтверждённых негативных сигналов не выявлено.";
  if (sourceLimited) {
    plainConclusion =
      "Часть источников была недоступна на момент проверки; выводы построены по доступным данным.";
  }
  if (stageKey === "executive_narrative_summary") {
    plainConclusion = `Итоговая оценка риска: ${riskLabel}. ${plainConclusion} Рекомендуется сверить материалы из очереди ручной проверки до финального клиентского вывода.`;
  }
  if (stageKey === "lexisnexis_profile_overview") {
    plainConclusion = lexisClientSummary(lexisSignals);
  }
  if (stageKey === "lexisnexis_visual_pages") {
    plainConclusion =
      lexisVisualCount > 0
        ? `Импортированный документ LexisNexis содержит ${lexisVisualCount} визуальных страниц; каждая страница включена как отдельный слайд.`
        : "Визуальные страницы LexisNexis недоступны; текстовая аналитика сохранена.";
  }
  if (stageKey.startsWith("uae_")) {
    plainConclusion = `${plainConclusion} Упоминания sanctions/OFAC/EU/watchlist трактуются как чувствительный поисковый контекст до подтверждения аналитиком.`;
  }
  if (stageKey.startsWith("ru_")) {
    plainConclusion = `${plainConclusion} Результаты поиска сгруппированы по подтверждённым, потенциальным и требующим проверки сигналам.`;
  }
  if (microStage.macroSectionKey === "offer") {
    const snippet = evidencePack.topResults.map((x) => String(x.snippet ?? "")).join(" ");
    const picked = snippet.includes("compliance_db_correction")
      ? "compliance_db_correction"
      : snippet.includes("wikipedia")
        ? "wikipedia"
        : "digital_profile";
    plainConclusion = `Коммерческая рекомендация адаптирована к выявленным сигналам: ${offerEmphasisLabel(picked)}`;
  }

  const tables =
    stageKey.includes("lexisnexis") && lexisSignals.length > 0
      ? buildLexisSignalTables(lexisSignals)
      : buildEvidenceTables(evidencePack);

  const metricCards = normalizeMetricCards([
    ...(counts.total > 0 ? [{ label: "Всего сигналов", value: counts.total }] : []),
    ...(counts.confirmed > 0 ? [{ label: "Подтверждено", value: counts.confirmed }] : []),
    ...(counts.requiresReview > 0 ? [{ label: "На проверку", value: counts.requiresReview }] : []),
    ...(lexisSignals.length > 0 ? [{ label: "Lexis сигналов", value: lexisSignals.length }] : []),
  ]);

  const analysis: OrionGpt55SectionAnalysis = {
    microStageKey: microStage.microStageKey,
    macroSectionKey: microStage.macroSectionKey,
    sectionNumber: microStage.sectionNumber,
    titleRu: microStage.titleRu,
    status: "fallback",
    generatedBy: "deterministic",
    clientNarrative: {
      plainConclusion,
      whatWasFound,
      whatWasNotConfirmed,
      whatRequiresReview,
      whyItMatters:
        "Этот раздел влияет на итоговую интерпретацию отчёта и должен читаться совместно с соседними разделами той же секции.",
      recommendedActions: [
        "Сверить ключевые источники и домены вручную.",
        "Проверить материалы из очереди review до финального клиентского вывода.",
      ],
    },
    evidenceSummary: {
      total: counts.total,
      confirmed: counts.confirmed,
      undesirable: counts.undesirable,
      potential: counts.potential,
      requiresReview: counts.requiresReview,
      excludedNoise: counts.excludedNoise,
      keyDomains: evidencePack.keyDomains,
      keyThemes: topThemes,
    },
    slideContent: {
      headline: microStage.titleRu,
      subheadline: plainConclusion.slice(0, 140),
      metricCards,
      tables,
      narrativeBlocks: [],
      screenshotRefs: evidencePack.topResults.map((x) => x.screenshotRef).filter((x): x is string => Boolean(x)),
      visualRefs:
        lexisVisualCount > 0 && stageKey === "lexisnexis_visual_pages"
          ? (evidencePack.lexisVisualPageRefs ?? [])
          : evidencePack.topResults.map((x) => x.visualRef).filter((x): x is string => Boolean(x)),
      evidenceRefs: evidencePack.topResults.map((x) => x.safeEvidenceId),
    },
    warnings: [input.reason ?? "gpt-5.5-unavailable-fallback"],
  };

  analysis.slideContent.narrativeBlocks = buildNarrativeBlocksFromAnalysis(analysis).map((block) => ({
    title: block.title,
    text: block.text,
  }));

  return analysis;
}
