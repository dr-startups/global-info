import type { ReportAssetV1 } from "./asset-builder";
import type { NormalizedEvidenceV1, EvidenceReviewStatus } from "./normalized-evidence";
import { reviewStatusLabel, riskThemeLabel } from "./normalized-evidence";
import type {
  OrionReportSectionKey,
  OrionReportSectionSpecV1,
  SectionAnalysisResult,
} from "./report-spec-schema";
import { SECTION_TITLES } from "./report-spec-schema";
import { composeTargetSectionSlides } from "./slide-composer";

function countByReview(evidence: NormalizedEvidenceV1[]): Record<EvidenceReviewStatus, number> {
  const out: Record<EvidenceReviewStatus, number> = {
    official_record_found: 0,
    requires_review: 0,
    confirmed_low_risk: 0,
    excluded_noise: 0,
    not_available: 0,
  };
  for (const e of evidence) {
    out[e.reviewStatus] = (out[e.reviewStatus] ?? 0) + 1;
  }
  return out;
}

function topDomains(evidence: NormalizedEvidenceV1[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const e of evidence) {
    if (!e.domain) continue;
    counts.set(e.domain, (counts.get(e.domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([d]) => d);
}

function buildSectionBody(input: {
  sectionKey: OrionReportSectionKey;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): Omit<OrionReportSectionSpecV1, "slides"> {
  const counts = countByReview(input.evidence);
  const domains = topDomains(input.evidence);
  const highlights = input.evidence
    .filter((e) => e.reviewStatus !== "excluded_noise" && e.reviewStatus !== "not_available")
    .slice(0, 6)
    .map((e) => ({
      label: e.title ?? e.domain ?? e.sourceLabel,
      summary: e.clientSafeSummary ?? e.snippet ?? "",
      evidenceRef: e.evidenceRef,
      status: reviewStatusLabel(e.reviewStatus),
    }));

  const found: string[] = [];
  const notConfirmed: string[] = [];
  const manualQueue: string[] = [];

  for (const e of input.evidence.slice(0, 20)) {
    if (e.reviewStatus === "official_record_found") {
      found.push(`${e.sourceLabel}: ${e.title ?? e.domain ?? "сигнал"} — подтверждённый сигнал.`);
    } else if (e.reviewStatus === "requires_review") {
      manualQueue.push(`${e.title ?? e.domain ?? e.sourceLabel}: ${riskThemeLabel(e.riskTheme)}`);
    } else if (e.reviewStatus === "not_available") {
      notConfirmed.push(String(e.clientSafeSummary ?? e.snippet ?? "Данные недоступны."));
    } else if (e.reviewStatus === "confirmed_low_risk") {
      found.push(`${e.title ?? e.sourceLabel}: низкий риск по доступным данным.`);
    }
  }

  if (found.length === 0) {
    found.push("По доступным открытым источникам существенных подтверждённых сигналов не выявлено.");
  }
  if (notConfirmed.length === 0) {
    notConfirmed.push("Юридические выводы и вина субъекта не подтверждаются автоматическим анализом.");
  }

  const metrics: OrionReportSectionSpecV1["metrics"] = [
    { label: "Всего элементов", value: input.evidence.length, tone: "neutral" as const },
    { label: "Требует проверки", value: counts.requires_review, tone: "warning" as const },
    { label: "Подтверждённые сигналы", value: counts.official_record_found, tone: "high" as const },
    { label: "Низкий риск", value: counts.confirmed_low_risk, tone: "low" as const },
  ];

  if (input.sectionKey === "ru_search_results") {
    const yandexCount = input.evidence.filter((e) => e.provider === "yandex" && e.sourceKind === "search_result").length;
    const googleCount = input.evidence.filter((e) => e.provider === "google" && e.sourceKind === "search_result").length;
    metrics.push({ label: "Яндекс", value: yandexCount, tone: "neutral" as const });
    metrics.push({ label: "Google", value: googleCount, tone: "neutral" as const });
    if (domains.length > 0) {
      metrics.push({ label: "Ключевые домены", value: domains.slice(0, 3).join(", "), tone: "neutral" as const });
    }
  }

  const headline =
    input.sectionKey === "executive_summary"
      ? `Executive Summary — ${input.subjectName}`
      : input.sectionKey === "ru_audit_summary"
        ? `Сводка аудита по России — ${input.subjectName}`
        : `Поисковая выдача по России — ${input.subjectName}`;

  return {
    sectionKey: input.sectionKey,
    title: SECTION_TITLES[input.sectionKey],
    subtitle:
      input.sectionKey === "executive_summary"
        ? "Обобщение ключевых сигналов и зон проверки"
        : input.sectionKey === "ru_audit_summary"
          ? "RU 2.1 — структурированная сводка"
          : "RU 2.2 — обзор SERP и медиа-поверхностей",
    clientNarrative: {
      headline,
      summary: `Анализ основан на ${input.evidence.length} нормализованных элементах доказательной базы. ${
        counts.official_record_found > 0
          ? "Выявлены сигналы, требующие внимания комплаенс-команды."
          : "Критических подтверждённых сигналов по доступным данным не зафиксировано."
      }`,
      whatWasFound: found.slice(0, 6),
      whatWasNotConfirmed: notConfirmed.slice(0, 4),
      whyItMatters:
        input.sectionKey === "executive_summary"
          ? "Executive summary задаёт рамку для последующих разделов и приоритетов ручной проверки."
          : input.sectionKey === "ru_audit_summary"
            ? "RU 2.1 фиксирует, что подтверждено открытыми источниками и что требует отдельной верификации."
            : "RU 2.2 показывает, как субъект представлен в поисковой выдаче и связанных медиа-поверхностях.",
      riskInterpretation:
        counts.official_record_found > 0
          ? "Имеются элементы повышенного внимания; окончательная оценка возможна только после ручной верификации."
          : "По текущему набору данных доминирует нейтральный или неоднозначный профиль без автоматически подтверждённых негативных выводов.",
      manualReviewQueue: manualQueue.slice(0, 6),
      recommendedNextSteps: [
        "Провести ручную верификацию элементов из очереди проверки.",
        "Сопоставить открытые источники с официальными базами и LexisNexis.",
        "Зафиксировать решение по каждому спорному сигналу в карточке кейса.",
      ],
    },
    metrics,
    evidenceHighlights: highlights,
  };
}

export function buildDeterministicSectionAnalysis(input: {
  sectionKey: OrionReportSectionKey;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): SectionAnalysisResult {
  const body = buildSectionBody(input);
  const slides = composeTargetSectionSlides({
    sectionKey: input.sectionKey,
    section: body,
    evidence: input.evidence,
    assets: input.assets,
  });
  return {
    sectionKey: input.sectionKey,
    generatedBy: "deterministic",
    section: { ...body, slides },
    warnings: [],
  };
}
