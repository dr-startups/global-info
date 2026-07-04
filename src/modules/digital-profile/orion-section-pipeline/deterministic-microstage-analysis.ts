import type { OrionEvidencePack, OrionGpt55SectionAnalysis, OrionMicroStage } from "./types";

export function buildDeterministicMicrostageAnalysis(input: {
  microStage: OrionMicroStage;
  evidencePack: OrionEvidencePack;
  reason?: string;
}): OrionGpt55SectionAnalysis {
  const { microStage, evidencePack } = input;
  const counts = evidencePack.counts;
  const topThemes = evidencePack.themeGroups.map((x) => x.label);

  const whatWasFound: string[] = [];
  if (counts.confirmed > 0) whatWasFound.push(`Подтверждено сигналов: ${counts.confirmed}.`);
  if (counts.undesirable > 0) whatWasFound.push(`Нежелательных сигналов: ${counts.undesirable}.`);
  if (counts.potential > 0) whatWasFound.push(`Потенциальных сигналов: ${counts.potential}.`);

  const whatRequiresReview: string[] = [];
  if (counts.requiresReview > 0) {
    whatRequiresReview.push(`Требует ручной проверки: ${counts.requiresReview}.`);
  } else {
    whatRequiresReview.push("Явных элементов на ручную проверку в этом micro-stage не выделено.");
  }

  const whatWasNotConfirmed: string[] =
    counts.confirmed === 0
      ? ["Подтверждённые негативные факты в рамках этого micro-stage не установлены."]
      : ["Часть материалов осталась в статусе потенциальных и не подтверждена как факт."];
  const sourceLimited = String(input.reason ?? "").toLowerCase().includes("unavailable");

  let plainConclusion =
    counts.confirmed > 0 || counts.undesirable > 0
      ? "Обнаружены материалы, влияющие на риск-профиль; вывод требует аналитического подтверждения."
      : "Подтверждённых негативных материалов не выявлено, однако часть результатов требует ручной проверки.";
  if (sourceLimited) {
    plainConclusion =
      "Часть источников была недоступна на момент проверки; выводы построены по доступным данным.";
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
      subheadline: `Micro-stage ${microStage.microStageKey}`,
      metricCards: [
        { label: "Всего", value: counts.total },
        { label: "Подтверждено", value: counts.confirmed },
        { label: "Требует проверки", value: counts.requiresReview },
      ],
      tables: [],
      narrativeBlocks: [
        { title: "Вывод", text: "Детерминированная аналитика используется как fallback при недоступности GPT-5.5." },
      ],
      screenshotRefs: evidencePack.topResults.map((x) => x.screenshotRef).filter((x): x is string => Boolean(x)),
      visualRefs: evidencePack.topResults.map((x) => x.visualRef).filter((x): x is string => Boolean(x)),
      evidenceRefs: evidencePack.topResults.map((x) => x.safeEvidenceId),
    },
    warnings: [input.reason ?? "gpt-5.5-unavailable-fallback"],
  };
}

