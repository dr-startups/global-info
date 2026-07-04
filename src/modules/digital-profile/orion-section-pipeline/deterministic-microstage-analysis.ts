import type { OrionEvidencePack, OrionGpt55SectionAnalysis, OrionMicroStage } from "./types";

function inferRiskLabel(counts: OrionEvidencePack["counts"]): "LOW" | "MEDIUM" | "HIGH" {
  if (counts.confirmed > 1 || counts.undesirable > 2) return "HIGH";
  if (counts.confirmed > 0 || counts.undesirable > 0 || counts.requiresReview > 3) return "MEDIUM";
  return "LOW";
}

function offerEmphasisLabel(emphasis: string): string {
  switch (emphasis) {
    case "compliance_db_correction":
      return "Compliance DB correction — корректировка compliance-базы и проверка Lexis/compliance сигналов.";
    case "wikipedia":
      return "Wikipedia — усиление публичного профиля и справочной видимости.";
    default:
      return "Digital Profile — мониторинг поисковой выдачи и репутационных сигналов.";
  }
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

  const whatWasFound: string[] = [];
  if (counts.confirmed > 0) whatWasFound.push(`Подтверждено сигналов: ${counts.confirmed}.`);
  if (counts.undesirable > 0) whatWasFound.push(`Нежелательных сигналов: ${counts.undesirable}.`);
  if (counts.potential > 0) whatWasFound.push(`Потенциальных сигналов: ${counts.potential}.`);
  if (lexisSignals.length > 0) {
    whatWasFound.push("Загруженный отчёт LexisNexis обработан; разобранные сигналы включены в аналитику.");
  }
  if (lexisVisualCount > 0) {
    whatWasFound.push(`Визуальные страницы LexisNexis готовы к включению в отчёт: ${lexisVisualCount}.`);
  }
  if (evidencePack.keyDomains.length > 0) {
    whatWasFound.push(`Ключевые домены: ${evidencePack.keyDomains.slice(0, 5).join(", ")}.`);
  }

  const whatRequiresReview: string[] = [];
  if (counts.requiresReview > 0) {
    whatRequiresReview.push(`Требует ручной проверки: ${counts.requiresReview}.`);
  } else if (lexisSignals.some((s) => s.reviewRequired)) {
    whatRequiresReview.push("Сигналы LexisNexis содержат материалы, требующие аналитической проверки.");
  } else {
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
    plainConclusion =
      lexisSignals.length > 0
        ? "Загруженный отчёт LexisNexis обработан. Разобранные сигналы и аналитика представлены ниже; неоднозначные совпадения требуют ручной проверки."
        : "Импорт LexisNexis для кейса не обнаружен или недоступен; раздел содержит только клиент-безопасный fallback.";
  }
  if (stageKey === "lexisnexis_visual_pages") {
    plainConclusion =
      lexisVisualCount > 0
        ? `Импортированный документ LexisNexis содержит ${lexisVisualCount} визуальных страниц; каждая страница включена как отдельный слайд.`
        : "Визуальные страницы LexisNexis недоступны; показан клиент-безопасный fallback без заявления о наличии страниц.";
  }
  if (stageKey.startsWith("uae_") || stageKey.startsWith("uae")) {
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

  return {
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
        "Этот micro-stage влияет на итоговую интерпретацию раздела и должен читаться совместно с соседними stage в том же macro section.",
      recommendedActions: [
        "Сверить ключевые источники и домены вручную.",
        "Проверить материалы из review-очереди до финального клиентского вывода.",
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
      subheadline: "Этап анализа",
      metricCards: [
        { label: "Всего", value: counts.total },
        { label: "Подтверждено", value: counts.confirmed },
        { label: "Требует проверки", value: counts.requiresReview },
      ],
      tables: [],
      narrativeBlocks: [
        { title: "Вывод", text: plainConclusion },
        ...(stageKey === "executive_narrative_summary"
          ? [
              { title: "Что делать дальше", text: "Сверить ключевые источники, закрыть review-очередь и подтвердить итоговый риск-профиль." },
            ]
          : []),
      ],
      screenshotRefs: evidencePack.topResults.map((x) => x.screenshotRef).filter((x): x is string => Boolean(x)),
      visualRefs:
        lexisVisualCount > 0 && stageKey === "lexisnexis_visual_pages"
          ? (evidencePack.lexisVisualPageRefs ?? [])
          : evidencePack.topResults.map((x) => x.visualRef).filter((x): x is string => Boolean(x)),
      evidenceRefs: evidencePack.topResults.map((x) => x.safeEvidenceId),
    },
    warnings: [input.reason ?? "gpt-5.5-unavailable-fallback"],
  };
}

