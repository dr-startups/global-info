import { lexisSummaryTakeaway } from "./lexis-asset-builder";
import {
  assertNoClientHostileTokens,
  sanitizeClientNarrativeText,
  sanitizeStringArray,
} from "./client-text-contract";
import type { EvidenceRelevanceReport } from "./evidence-relevance-classifier";
import { classifyEvidenceRelevance, excludedEvidenceSummary, keyResultEvidence } from "./evidence-relevance-classifier";
import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";
import type { NormalizedEvidenceV1 } from "../orion-report-spec/normalized-evidence";
import { riskThemeLabel } from "../orion-report-spec/normalized-evidence";
import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { resolveR98aCaseId } from "../orion-report-spec/legacy-report-qa-builder";
import type {
  ClientActionItem,
  ClientAssetRef,
  ClientEvidenceRef,
  ClientFindingCard,
  ClientMetricCard,
  ClientStoryboard,
  ClientStoryboardSection,
  ClientStoryboardSlide,
  GptStoryboardSectionAnalysis,
} from "./types";

const FIXTURE_NAMES = ["иван петров", "ivan petrov"];
const FIXTURE_DOMAINS = ["example.com", "example.ru"];

const NO_STRONG_SOURCES =
  "В открытых источниках не найдено достаточных подтверждённых материалов, однозначно относящихся к субъекту.";

function clientStatusLabel(ev: NormalizedEvidenceV1, humanReason?: string): string {
  if (humanReason) return humanReason.slice(0, 120);
  if (ev.riskTheme && ev.riskTheme !== "unknown" && ev.riskTheme !== "neutral_profile") {
    const label = riskThemeLabel(ev.riskTheme);
    if (ev.riskTheme === "pep") return "Политически значимое лицо — требует верификации";
    return label.replace(/\bPEP\b/gi, "политически значимое лицо");
  }
  if (ev.reviewStatus === "requires_review") return "Потенциальное совпадение — источник требует проверки";
  if (ev.reviewStatus === "official_record_found") return "Подтверждено в открытых источниках";
  return "Релевантность не подтверждена";
}

function mapEvidenceFromClassified(
  items: ReturnType<typeof keyResultEvidence>
): ClientEvidenceRef[] {
  return items.slice(0, 5).map((c) => ({
    evidenceRef: c.evidence.evidenceRef,
    label: sanitizeClientNarrativeText(c.evidence.title ?? c.evidence.domain ?? "Результат поисковой выдачи"),
    summary: sanitizeClientNarrativeText(
      (c.evidence.clientSafeSummary ?? c.evidence.snippet ?? c.humanReason).slice(0, 220)
    ),
    statusLabel: clientStatusLabel(c.evidence, c.humanReason),
  }));
}

function mapAssets(assets: ReportAssetV1[]): ClientAssetRef[] {
  return assets.map((a) => ({
    assetRef: a.assetRef,
    kind:
      a.kind === "synthetic_serp"
        ? "serp_snapshot"
        : a.kind === "image_grid"
          ? "image_grid"
          : a.kind === "video_cards"
            ? "video_cards"
            : a.kind === "knowledge_panel"
              ? "knowledge_panel"
              : a.kind === "lexis_visual_page"
                ? "lexis_page"
                : "other",
    title: sanitizeClientNarrativeText(a.title),
    status: a.status === "ready" ? "ready" : "unavailable",
  }));
}

function humanFindings(items: string[], prefix: string): ClientFindingCard[] {
  return sanitizeStringArray(items, 0)
    .slice(0, 3)
    .map((summary, i) => ({
      headline: `${prefix} ${i + 1}`,
      summary: summary.slice(0, 220),
      evidenceRefs: [],
    }));
}

function slideBase(
  partial: Omit<
    ClientStoryboardSlide,
    "metrics" | "findings" | "evidenceRefs" | "assetRefs" | "recommendedActions"
  > & {
    metrics?: ClientMetricCard[];
    findings?: ClientFindingCard[];
    evidenceRefs?: ClientEvidenceRef[];
    assetRefs?: ClientAssetRef[];
    recommendedActions?: ClientActionItem[];
  }
): ClientStoryboardSlide {
  const {
    metrics = [],
    findings = [],
    evidenceRefs = [],
    assetRefs = [],
    recommendedActions = [],
    ...rest
  } = partial;
  return {
    metrics,
    evidenceRefs,
    assetRefs,
    recommendedActions: recommendedActions.map((a) => ({
      label: sanitizeClientNarrativeText(a.label),
      rationale: sanitizeClientNarrativeText(a.rationale),
      priority: a.priority,
    })),
    findings: findings.map((f) => ({
      ...f,
      headline: sanitizeClientNarrativeText(f.headline),
      summary: sanitizeClientNarrativeText(f.summary),
    })),
    maxBullets: 5,
    ...rest,
    title: sanitizeClientNarrativeText(rest.title),
    subtitle: rest.subtitle ? sanitizeClientNarrativeText(rest.subtitle) : undefined,
    clientTakeaway: sanitizeClientNarrativeText(rest.clientTakeaway),
  };
}

export function evaluateRealCaseQualityEligible(input: {
  caseId: string;
  caseSource: "env" | "db" | "fixture";
  caseContext: OrionRealCaseContext;
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  requireAi: boolean;
  assets: ReportAssetV1[];
  subjectName: string;
}): boolean {
  if (input.caseSource === "fixture") return false;
  if (FIXTURE_NAMES.some((n) => input.subjectName.toLowerCase().includes(n))) return false;
  if (input.requireAi && input.generatedBy !== "gpt-5.5") return false;
  if (input.caseContext.searchResults.length === 0) return false;
  const hasSerp = input.assets.some(
    (a) => a.kind === "synthetic_serp" && a.status === "ready" && Boolean(a.imageData || a.imageUrl)
  );
  if (!hasSerp) return false;
  const hasFixtureDomain = input.caseContext.searchResults.some((r) =>
    FIXTURE_DOMAINS.some((d) => r.url.toLowerCase().includes(d))
  );
  if (hasFixtureDomain) return false;
  return true;
}

function deriveRiskLevel(exec?: GptStoryboardSectionAnalysis): "low" | "medium" | "high" | "unknown" {
  const level = exec?.structuredRisk?.level;
  if (level === "high") return "high";
  if (level === "medium") return "medium";
  if (level === "low") return "low";
  if ((exec?.manualReviewQueue ?? []).length > 2) return "medium";
  return "low";
}

export function composeClientStoryboard(input: {
  caseContext: OrionRealCaseContext;
  caseResolution: Awaited<ReturnType<typeof resolveR98aCaseId>>;
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
  gptAnalyses: GptStoryboardSectionAnalysis[];
  relevanceReport?: EvidenceRelevanceReport;
  requireAi: boolean;
}): ClientStoryboard {
  const subjectName = input.caseContext.subject.fullName;
  const relevanceReport =
    input.relevanceReport ??
    classifyEvidenceRelevance(input.evidence, subjectName);
  const generatedBy =
    input.gptAnalyses.every((a) => a.generatedBy === "gpt-5.5")
      ? "gpt-5.5"
      : input.gptAnalyses.every((a) => a.generatedBy === "deterministic")
        ? "deterministic"
        : "mixed";

  const slides: ClientStoryboardSlide[] = [];
  let slideNum = 0;
  const sid = (type: string) => {
    slideNum += 1;
    return `${String(slideNum).padStart(2, "0")}-${type}`;
  };

  const exec = input.gptAnalyses.find((a) => a.sectionKey === "executive_summary");
  const ruAudit = input.gptAnalyses.find((a) => a.sectionKey === "ru_audit_summary");
  const ruSearch = input.gptAnalyses.find((a) => a.sectionKey === "ru_search_results");
  const lexisGpt = input.gptAnalyses.find((a) => a.sectionKey === "lexis_summary");
  const actionsGpt = input.gptAnalyses.find((a) => a.sectionKey === "recommended_actions");

  const keyResults = keyResultEvidence(relevanceReport);
  const excluded = excludedEvidenceSummary(relevanceReport);
  const searchRows = input.evidence.filter((e) => e.sourceKind === "search_result");
  const yandexSerp = input.assets.find((a) => a.assetRef === "ru_yandex_serp_snapshot" && a.status === "ready");
  const googleSerp = input.assets.find((a) => a.assetRef === "ru_google_serp_snapshot" && a.status === "ready");
  const hasRuData = searchRows.length > 0 || input.caseContext.searchSurfaces.length > 0;
  const riskLevel = deriveRiskLevel(exec);

  slides.push(
    slideBase({
      slideId: sid("cover"),
      sectionKey: "cover",
      slideType: "cover",
      title: "ORION Digital Profile",
      subtitle: subjectName,
      clientTakeaway: exec?.executiveTakeaway ?? "Аудит цифрового профиля субъекта",
      riskLevel: "unknown",
      layoutIntent: "cover-brand",
      omitIfNoData: false,
      visualDensityTarget: "standard",
    })
  );

  slides.push(
    slideBase({
      slideId: sid("toc"),
      sectionKey: "executive_summary",
      slideType: "global_toc",
      title: "Содержание отчёта",
      clientTakeaway: "Ключевые разделы аудита",
      riskLevel: "unknown",
      layoutIntent: "compact-toc",
      omitIfNoData: false,
      visualDensityTarget: "compact",
    })
  );

  slides.push(
    slideBase({
      slideId: sid("executive"),
      sectionKey: "executive_summary",
      slideType: "executive_summary",
      title: "Executive Summary",
      subtitle: subjectName,
      clientTakeaway: exec?.executiveTakeaway ?? exec?.clientExplanation ?? "",
      metrics: [
        { label: "Релевантных источников", value: keyResults.length, tone: "neutral" },
        { label: "Исключено как шум", value: excluded.length, tone: "neutral" },
        {
          label: "На верификации",
          value: (exec?.whatRequiresManualReview ?? exec?.manualReviewQueue ?? []).length,
          tone: (exec?.manualReviewQueue ?? []).length > 0 ? "warning" : "low",
        },
      ],
      recommendedActions: (exec?.recommendedActions ?? []).slice(0, 1).map((a) => ({ label: a, rationale: "" })),
      riskLevel,
      layoutIntent: "executive-safe-v2",
      omitIfNoData: false,
      visualDensityTarget: "standard",
    })
  );

  slides.push(
    slideBase({
      slideId: sid("scope"),
      sectionKey: "executive_summary",
      slideType: "scope_overview",
      title: "Что проверялось",
      clientTakeaway: exec?.clientExplanation ?? "Проверка открытых источников и compliance-материалов по субъекту",
      findings: humanFindings(
        exec?.whatWasChecked ?? [
          "Поисковая выдача (Яндекс, Google)",
          "Цифровой профиль и публикации",
          "Импорт LexisNexis",
        ],
        "Область"
      ),
      riskLevel: "unknown",
      layoutIntent: "scope-bullets",
      omitIfNoData: false,
      visualDensityTarget: "compact",
    })
  );

  slides.push(
    slideBase({
      slideId: sid("risk"),
      sectionKey: "risk_overview",
      slideType: "risk_conclusion",
      title: "Главные выводы и уровень риска",
      clientTakeaway:
        exec?.structuredRisk?.plainLanguageReason ??
        exec?.riskInterpretation ??
        "Автоматически подтверждённых критических выводов не сформировано",
      findings: humanFindings(
        exec?.whatItMeans ?? exec?.confirmedFacts ?? [],
        "Вывод"
      ),
      recommendedActions: (exec?.whatRequiresManualReview ?? exec?.manualReviewQueue ?? [])
        .slice(0, 2)
        .map((l) => ({ label: l, rationale: "" })),
      riskLevel,
      layoutIntent: "risk-conclusion-safe",
      omitIfNoData: false,
      visualDensityTarget: "standard",
    })
  );

  if (hasRuData) {
    slides.push(
      slideBase({
        slideId: sid("ru-summary"),
        sectionKey: "ru_audit",
        slideType: "region_summary",
        title: "Россия — сводка цифрового профиля",
        subtitle: "RU 2.1",
        clientTakeaway: ruAudit?.executiveTakeaway ?? ruAudit?.clientExplanation ?? "",
        findings: humanFindings(
          ruAudit?.whatWasFound ?? ruAudit?.confirmedFacts ?? [],
          "Сигнал"
        ),
        riskLevel: "medium",
        layoutIntent: "region-summary-safe",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    slides.push(
      slideBase({
        slideId: sid("relevant"),
        sectionKey: "ru_search",
        slideType: "relevant_sources",
        title: "Россия — поисковые результаты: релевантные источники",
        subtitle: "RU 2.2",
        clientTakeaway:
          keyResults.length > 0
            ? (ruSearch?.executiveTakeaway ?? "Ключевые источники с обоснованием релевантности")
            : NO_STRONG_SOURCES,
        evidenceRefs: mapEvidenceFromClassified(keyResults),
        riskLevel: keyResults.length > 0 ? "medium" : "low",
        layoutIntent: "relevant-sources",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    slides.push(
      slideBase({
        slideId: sid("excluded"),
        sectionKey: "ru_search",
        slideType: "excluded_matches",
        title: "Россия — исключённые / слабые совпадения",
        clientTakeaway:
          sanitizeClientNarrativeText(
            (ruSearch?.excludedNoiseSummary ?? []).join(" ") ||
              "Нерелевантные товарные, маркетплейс и общие портальные результаты исключены из ключевых выводов"
          ),
        findings: excluded.slice(0, 5).map((c, i) => ({
          headline: `Исключено ${i + 1}`,
          summary: sanitizeClientNarrativeText(`${c.evidence.title ?? c.evidence.domain ?? "Источник"} — ${c.humanReason}`).slice(
            0,
            220
          ),
          evidenceRefs: [],
        })),
        riskLevel: "low",
        layoutIntent: "excluded-list",
        omitIfNoData: false,
        visualDensityTarget: "compact",
      })
    );

    if (yandexSerp) {
      slides.push(
        slideBase({
          slideId: sid("serp-yandex"),
          sectionKey: "ru_search",
          slideType: "serp_screenshot",
          title: "Яндекс — снимок выдачи",
          clientTakeaway:
            ruSearch?.riskInterpretation ??
            "На снимке отмечены результаты для ручной оценки релевантности; нерелевантные позиции исключены из ключевых выводов",
          assetRefs: [
            { assetRef: yandexSerp.assetRef, kind: "serp_snapshot", title: yandexSerp.title, status: "ready" },
          ],
          riskLevel: "medium",
          layoutIntent: "serp-full-width",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }

    if (googleSerp) {
      slides.push(
        slideBase({
          slideId: sid("serp-google"),
          sectionKey: "ru_search",
          slideType: "serp_screenshot",
          title: "Google — снимок выдачи",
          clientTakeaway: "Международная поисковая выдача — релевантность каждого результата требует отдельной проверки",
          assetRefs: [
            { assetRef: googleSerp.assetRef, kind: "serp_snapshot", title: googleSerp.title, status: "ready" },
          ],
          riskLevel: "medium",
          layoutIntent: "serp-full-width",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }

    const adverse = keyResults.filter(
      (c) =>
        c.evidence.riskTheme === "adverse_media" ||
        c.evidence.riskTheme === "sanctions_watchlist" ||
        c.evidence.riskTheme === "pep"
    );
    if (adverse.length > 0) {
      slides.push(
        slideBase({
          slideId: sid("adverse"),
          sectionKey: "ru_search",
          slideType: "adverse_media_summary",
          title: "Негативные / чувствительные публикации",
          clientTakeaway:
            ruSearch?.structuredRisk?.plainLanguageReason ??
            ruSearch?.riskInterpretation ??
            "Сигналы потенциальной чувствительности — связь с субъектом не подтверждена автоматически",
          findings: adverse.slice(0, 4).map((c) => ({
            headline: sanitizeClientNarrativeText(c.evidence.title ?? "Публикация"),
            summary: sanitizeClientNarrativeText(c.humanReason).slice(0, 220),
            evidenceRefs: [],
            severity: "medium" as const,
          })),
          riskLevel: "high",
          layoutIntent: "adverse-cards-safe",
          omitIfNoData: true,
          visualDensityTarget: "standard",
        })
      );
    }
  } else {
    slides.push(
      slideBase({
        slideId: sid("no-ru-data"),
        sectionKey: "ru_audit",
        slideType: "no_data_compact",
        title: "Россия — недостаточно данных",
        clientTakeaway: NO_STRONG_SOURCES,
        riskLevel: "unknown",
        layoutIntent: "compact-no-data",
        omitIfNoData: false,
        visualDensityTarget: "compact",
      })
    );
  }

  const lexisDoc = input.caseContext.lexis.latestReady ?? input.caseContext.lexis.latestAny;
  const lexisAssets = input.assets.filter((a) => a.kind === "lexis_visual_page" && a.status === "ready");
  if (lexisDoc || input.caseContext.lexis.uploadExists) {
    slides.push(
      slideBase({
        slideId: sid("lexis-summary"),
        sectionKey: "lexisnexis",
        slideType: "lexisnexis_summary",
        title: "LexisNexis — аналитическая сводка",
        subtitle: "Compliance",
        clientTakeaway:
          lexisGpt?.executiveTakeaway ??
          lexisGpt?.clientExplanation ??
          lexisSummaryTakeaway(input.caseContext),
        metrics: [
          {
            label: "Статус импорта",
            value: input.caseContext.lexis.uploadExists ? "Импортирован" : "Ожидает",
            tone: "neutral",
          },
          {
            label: "Сигналов",
            value: input.caseContext.lexis.parsedSignals,
            tone: input.caseContext.lexis.parsedSignals > 0 ? "warning" : "neutral",
          },
          {
            label: "Страниц",
            value: lexisAssets.length || input.caseContext.lexis.visualPageCount,
            tone: "neutral",
          },
        ],
        findings: humanFindings(
          lexisGpt?.whatWasFound ?? lexisGpt?.confirmedFacts ?? [],
          "Сигнал"
        ),
        riskLevel: input.caseContext.lexis.parsedSignals > 0 ? "medium" : "low",
        layoutIntent: "lexis-analytical-summary",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    const signalCards =
      lexisGpt?.evidenceExamples ??
      (input.caseContext.lexis.parsedSignals > 0
        ? [
            {
              humanTitle: "Потенциальный compliance-сигнал",
              source: "LexisNexis",
              domain: "lexisnexis",
              whyIncluded: "Импортированный отчёт содержит записи, требующие ручной верификации",
              clientSafeStatus: "requires_review" as const,
            },
          ]
        : []);

    slides.push(
      slideBase({
        slideId: sid("lexis-signals"),
        sectionKey: "lexisnexis",
        slideType: "lexisnexis_signals",
        title: "LexisNexis — ключевые сигналы",
        clientTakeaway:
          signalCards.length > 0
            ? "Потенциальные совпадения требуют проверки идентификаторов субъекта"
            : "Данные требуют ручной проверки — недостаточно структурированных сигналов для автоматического вывода",
        findings: signalCards.slice(0, 5).map((s, i) => ({
          headline: sanitizeClientNarrativeText(s.humanTitle || `Сигнал ${i + 1}`),
          summary: sanitizeClientNarrativeText(`${s.whyIncluded}. Источник: ${s.source}`).slice(0, 220),
          evidenceRefs: [],
        })),
        riskLevel: "medium",
        layoutIntent: "lexis-signals-cards",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    for (const asset of lexisAssets.slice(0, 8)) {
      slides.push(
        slideBase({
          slideId: sid(`lexis-page-${asset.assetRef}`),
          sectionKey: "lexisnexis",
          slideType: "lexisnexis_visual_page",
          title: `Приложение: исходная страница LexisNexis`,
          subtitle: sanitizeClientNarrativeText(asset.title),
          clientTakeaway:
            "Оригинальная страница включена как визуальное подтверждение импорта; детальная проверка выполняется по исходному DOCX/PDF",
          assetRefs: mapAssets([asset]),
          riskLevel: "medium",
          layoutIntent: "lexis-appendix-large",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }
  }

  const actionLabels = [
    ...(actionsGpt?.recommendedActions ?? []),
    ...(exec?.recommendedActions ?? []),
    ...(ruAudit?.recommendedActions ?? []),
    ...(ruSearch?.recommendedActions ?? []),
  ]
    .filter((label, index, arr) => arr.indexOf(label) === index)
    .slice(0, 5);

  slides.push(
    slideBase({
      slideId: sid("actions"),
      sectionKey: "appendix",
      slideType: "recommended_actions",
      title: "Рекомендуемые действия",
      clientTakeaway:
        actionsGpt?.executiveTakeaway ?? "Следующие шаги для клиента и команды проверки",
      recommendedActions: actionLabels.map((label) => ({ label, rationale: "" })),
      riskLevel: "medium",
      layoutIntent: "action-list",
      omitIfNoData: false,
      visualDensityTarget: "standard",
    })
  );

  const sections: ClientStoryboardSection[] = [];
  const sectionKeys = [...new Set(slides.map((s) => s.sectionKey))];
  for (const key of sectionKeys) {
    sections.push({
      sectionKey: key,
      title: key,
      slides: slides.filter((s) => s.sectionKey === key),
    });
  }

  const storyboard: ClientStoryboard = {
    version: "orion-client-storyboard-v1",
    subject: { displayName: subjectName, locale: "ru" },
    generatedAt: new Date().toISOString(),
    sections,
    slides,
    qa: {
      generatedBy,
      requireAi: input.requireAi,
      realCaseQualityEligible: evaluateRealCaseQualityEligible({
        caseId: input.caseResolution.caseId,
        caseSource: input.caseResolution.source,
        caseContext: input.caseContext,
        generatedBy,
        requireAi: input.requireAi,
        assets: input.assets,
        subjectName,
      }),
      caseId: input.caseResolution.caseId,
      caseSource: input.caseResolution.source,
      warnings: input.gptAnalyses.flatMap((a) => a.warnings),
    },
  };

  const clientText = slides
    .flatMap((s) => [
      s.title,
      s.subtitle ?? "",
      s.clientTakeaway,
      ...s.findings.map((f) => f.summary),
      ...s.evidenceRefs.map((e) => e.summary),
    ])
    .join("\n");
  const hostile = assertNoClientHostileTokens(clientText, "storyboard");
  if (hostile.length > 0) {
    storyboard.qa.warnings.push(...hostile.slice(0, 8));
  }

  return storyboard;
}
