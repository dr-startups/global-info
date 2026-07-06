import { lexisSummaryTakeaway } from "./lexis-asset-builder";
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

function clientStatusLabel(ev: NormalizedEvidenceV1): string {
  if (ev.riskTheme && ev.riskTheme !== "unknown" && ev.riskTheme !== "neutral_profile") {
    const label = riskThemeLabel(ev.riskTheme);
    if (ev.riskTheme === "pep") return "Политически значимое лицо";
    return label.replace(/\bPEP\b/gi, "политически значимое лицо");
  }
  if (ev.reviewStatus === "requires_review") return "Требует проверки";
  if (ev.reviewStatus === "official_record_found") return "Подтверждено в открытых источниках";
  return "Нейтральный сигнал";
}

function mapEvidence(evidence: NormalizedEvidenceV1[]): ClientEvidenceRef[] {
  return evidence.slice(0, 12).map((e) => ({
    evidenceRef: e.evidenceRef,
    label: e.title ?? e.domain ?? "Источник",
    summary: (e.clientSafeSummary ?? e.snippet ?? "").slice(0, 220),
    statusLabel: clientStatusLabel(e),
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
    title: a.title,
    status: a.status === "ready" ? "ready" : "unavailable",
  }));
}

function slideBase(partial: Omit<ClientStoryboardSlide, "metrics" | "findings" | "evidenceRefs" | "assetRefs" | "recommendedActions"> & {
  metrics?: ClientMetricCard[];
  findings?: ClientFindingCard[];
  evidenceRefs?: ClientEvidenceRef[];
  assetRefs?: ClientAssetRef[];
  recommendedActions?: ClientActionItem[];
}): ClientStoryboardSlide {
  return {
    metrics: [],
    findings: [],
    evidenceRefs: [],
    assetRefs: [],
    recommendedActions: [],
    maxBullets: 5,
    ...partial,
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

export function composeClientStoryboard(input: {
  caseContext: OrionRealCaseContext;
  caseResolution: Awaited<ReturnType<typeof resolveR98aCaseId>>;
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
  gptAnalyses: GptStoryboardSectionAnalysis[];
  requireAi: boolean;
}): ClientStoryboard {
  const subjectName = input.caseContext.subject.fullName;
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

  const searchRows = input.evidence.filter((e) => e.sourceKind === "search_result");
  const imageAssets = input.assets.filter((a) => a.kind === "image_grid" && a.status === "ready");
  const videoAssets = input.assets.filter((a) => a.kind === "video_cards" && a.status === "ready");
  const knowledgeAssets = input.assets.filter((a) => a.kind === "knowledge_panel" && a.status === "ready");
  const yandexSerp = input.assets.find((a) => a.assetRef === "ru_yandex_serp_snapshot" && a.status === "ready");
  const googleSerp = input.assets.find((a) => a.assetRef === "ru_google_serp_snapshot" && a.status === "ready");
  const hasRuData = searchRows.length > 0 || input.caseContext.searchSurfaces.length > 0;

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
        { label: "Источников проверено", value: input.evidence.length, tone: "neutral" },
        { label: "Поисковых сигналов", value: searchRows.length, tone: "neutral" },
        {
          label: "На ручной проверке",
          value: (exec?.manualReviewQueue ?? []).length,
          tone: (exec?.manualReviewQueue ?? []).length > 0 ? "warning" : "low",
        },
      ],
      findings: (exec?.confirmedFacts ?? []).slice(0, 3).map((f, i) => ({
        headline: `Находка ${i + 1}`,
        summary: f.slice(0, 220),
        evidenceRefs: [],
      })),
      recommendedActions: (exec?.recommendedActions ?? []).slice(0, 2).map((a) => ({
        label: a,
        rationale: "",
      })),
      riskLevel: (exec?.manualReviewQueue ?? []).length > 2 ? "medium" : "low",
      layoutIntent: "executive-cards",
      omitIfNoData: false,
      visualDensityTarget: "rich",
    })
  );

  if (hasRuData) {
    slides.push(
      slideBase({
        slideId: sid("ru-summary"),
        sectionKey: "ru_audit",
        slideType: "region_summary",
        title: "Россия — сводка аудита",
        subtitle: "RU 2.1",
        clientTakeaway: ruAudit?.executiveTakeaway ?? ruAudit?.clientExplanation ?? "",
        findings: (ruAudit?.confirmedFacts ?? []).slice(0, 3).map((f, i) => ({
          headline: `Сигнал ${i + 1}`,
          summary: f.slice(0, 220),
          evidenceRefs: [],
        })),
        recommendedActions: (ruAudit?.recommendedActions ?? []).slice(0, 2).map((l) => ({ label: l, rationale: "" })),
        riskLevel: "medium",
        layoutIntent: "region-summary",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    slides.push(
      slideBase({
        slideId: sid("search-overview"),
        sectionKey: "ru_search",
        slideType: "search_overview",
        title: "Поисковая выдача — обзор",
        subtitle: "RU 2.2",
        clientTakeaway: ruSearch?.executiveTakeaway ?? ruSearch?.clientExplanation ?? "",
        metrics: [
          { label: "Результатов", value: searchRows.length, tone: "neutral" },
          {
            label: "Требуют проверки",
            value: (ruSearch?.manualReviewQueue ?? []).length,
            tone: "warning",
          },
        ],
        evidenceRefs: mapEvidence(searchRows).slice(0, 5),
        riskLevel: "medium",
        layoutIntent: "search-overview",
        omitIfNoData: false,
        visualDensityTarget: "standard",
      })
    );

    if (yandexSerp) {
      slides.push(
        slideBase({
          slideId: sid("serp-yandex"),
          sectionKey: "ru_search",
          slideType: "serp_screenshot",
          title: "Яндекс — снимок выдачи",
          clientTakeaway: ruSearch?.riskInterpretation ?? "Визуализация поисковой выдачи по ключевому запросу",
          assetRefs: [{ assetRef: yandexSerp.assetRef, kind: "serp_snapshot", title: yandexSerp.title, status: "ready" }],
          riskLevel: "medium",
          layoutIntent: "serp-full-bleed-image",
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
          clientTakeaway: "Международная поисковая выдача по субъекту",
          assetRefs: [{ assetRef: googleSerp.assetRef, kind: "serp_snapshot", title: googleSerp.title, status: "ready" }],
          riskLevel: "medium",
          layoutIntent: "serp-full-bleed-image",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }

    if (searchRows.length > 0) {
      slides.push(
        slideBase({
          slideId: sid("search-table"),
          sectionKey: "ru_search",
          slideType: "search_results_table",
          title: "Ключевые результаты поиска",
          clientTakeaway: "Структурированная таблица топ-результатов",
          evidenceRefs: mapEvidence(searchRows).slice(0, 5),
          riskLevel: "medium",
          layoutIntent: "results-table",
          omitIfNoData: true,
          visualDensityTarget: "standard",
        })
      );
    }

    const adverse = searchRows.filter(
      (e) => e.riskTheme === "adverse_media" || e.riskTheme === "sanctions_watchlist" || e.riskTheme === "pep"
    );
    if (adverse.length > 0) {
      slides.push(
        slideBase({
          slideId: sid("adverse"),
          sectionKey: "ru_search",
          slideType: "adverse_media_summary",
          title: "Негативные и чувствительные публикации",
          clientTakeaway: ruSearch?.riskInterpretation ?? "Сигналы, требующие аналитической верификации",
          findings: adverse.slice(0, 4).map((e) => ({
            headline: e.title ?? "Публикация",
            summary: e.clientSafeSummary ?? e.snippet ?? "",
            evidenceRefs: [e.evidenceRef],
            severity: "medium",
          })),
          riskLevel: "high",
          layoutIntent: "adverse-cards",
          omitIfNoData: true,
          visualDensityTarget: "standard",
        })
      );
    }

    if (imageAssets.length > 0 && imageAssets[0]?.imageData) {
      slides.push(
        slideBase({
          slideId: sid("images"),
          sectionKey: "ru_search",
          slideType: "image_grid",
          title: "Изображения в поисковой выдаче",
          clientTakeaway: "Визуальные результаты, связанные с субъектом",
          assetRefs: mapAssets(imageAssets),
          riskLevel: "low",
          layoutIntent: "orion-image-grid",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }

    if (videoAssets.length > 0 && videoAssets[0]?.imageData) {
      slides.push(
        slideBase({
          slideId: sid("videos"),
          sectionKey: "ru_search",
          slideType: "video_cards",
          title: "Видеоматериалы",
          clientTakeaway: "Видеорезультаты с упоминанием субъекта",
          assetRefs: mapAssets(videoAssets),
          riskLevel: "low",
          layoutIntent: "video-cards",
          omitIfNoData: true,
          visualDensityTarget: "standard",
        })
      );
    }

    if (knowledgeAssets.length > 0 && knowledgeAssets[0]?.imageData) {
      slides.push(
        slideBase({
          slideId: sid("knowledge"),
          sectionKey: "ru_search",
          slideType: "knowledge_panel",
          title: "Справочная карточка",
          clientTakeaway: "Блок знаний из поисковой выдачи",
          assetRefs: mapAssets(knowledgeAssets),
          riskLevel: "low",
          layoutIntent: "knowledge-card",
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
        clientTakeaway: "По региону RU не собрано достаточно подтверждённых материалов для отдельных визуальных слайдов",
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
        title: "LexisNexis — сводка",
        subtitle: "Compliance",
        clientTakeaway: lexisSummaryTakeaway(input.caseContext),
        riskLevel: input.caseContext.lexis.parsedSignals > 0 ? "medium" : "low",
        layoutIntent: "lexis-summary",
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
          title: asset.title,
          clientTakeaway: "Визуальная страница импортированного отчёта LexisNexis",
          assetRefs: mapAssets([asset]),
          riskLevel: "medium",
          layoutIntent: "lexis-visual-page",
          omitIfNoData: true,
          visualDensityTarget: "rich",
        })
      );
    }
  }

  slides.push(
    slideBase({
      slideId: sid("actions"),
      sectionKey: "appendix",
      slideType: "recommended_actions",
      title: "Рекомендуемые действия",
      clientTakeaway: "Следующие шаги для клиента и команды проверки",
      recommendedActions: [
        ...(exec?.recommendedActions ?? []),
        ...(ruAudit?.recommendedActions ?? []),
        ...(ruSearch?.recommendedActions ?? []),
      ]
        .slice(0, 5)
        .map((l) => ({ label: l, rationale: "" })),
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

  const realCaseQualityEligible = evaluateRealCaseQualityEligible({
    caseId: input.caseResolution.caseId,
    caseSource: input.caseResolution.source,
    caseContext: input.caseContext,
    generatedBy,
    requireAi: input.requireAi,
    assets: input.assets,
    subjectName,
  });

  return {
    version: "orion-client-storyboard-v1",
    subject: { displayName: subjectName, locale: "ru" },
    generatedAt: new Date().toISOString(),
    sections,
    slides,
    qa: {
      generatedBy,
      requireAi: input.requireAi,
      realCaseQualityEligible,
      caseId: input.caseResolution.caseId,
      caseSource: input.caseResolution.source,
      warnings: input.gptAnalyses.flatMap((a) => a.warnings),
    },
  };
}
