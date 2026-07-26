import type { ReportJson } from "../types";
import type { ReportLanguage } from "../report/i18n/report-dictionary";

export interface AiAnalystEvidenceItem {
  id: string;
  title: string;
  domain: string;
  snippet: string;
  status: "confirmed" | "requires_review" | "excluded_noise" | "not_confirmed";
  theme?: string;
  source?: string;
}

export interface AiAnalystEvidencePackRegion {
  code: "RU" | "INTL";
  organicTotal: number;
  organicPotentialNegative: number;
  organicConfirmedNegative: number;
  organicReviewRequired: number;
  organicExcludedNoise: number;
  imagesTotal: number;
  imagesFlagged: number;
  videosTotal: number;
  videosFlagged: number;
  topThemes: Array<{ label: string; count: number }>;
  topDomains: Array<{ domain: string; count: number }>;
  topItems: AiAnalystEvidenceItem[];
}

export interface AiAnalystEvidencePack {
  language: ReportLanguage;
  subject: {
    fullName: string;
    aliases: string[];
    dateOfBirth?: string | null;
    nationality?: string | null;
    country?: string | null;
  };
  risk: {
    overallLevel: string;
    deterministicSignals: string[];
    riskReasons: string[];
  };
  totals: {
    organicTotal: number;
    potentialNegative: number;
    confirmedNegative: number;
    reviewRequired: number;
    excludedNoise: number;
    imagesTotal: number;
    imagesFlagged: number;
    videosTotal: number;
    videosFlagged: number;
  };
  regions: {
    ru?: AiAnalystEvidencePackRegion;
    intl?: AiAnalystEvidencePackRegion;
  };
  selectedEvidence: {
    confirmedCount: number;
    excludedCount: number;
    rows: AiAnalystEvidenceItem[];
  };
  excludedNoiseSummary: {
    count: number;
    note: string;
  };
  compliance: {
    activeMatches: number;
    pendingReview: number;
    conclusion: string;
    manualImportSignals: string[];
  };
  lexisNexis?: {
    importReady: boolean;
    importStatus: string;
    totalDocuments: number;
    totalSignals: number;
    reviewRequired: number;
    visualPages: number;
    executiveSummaryClient: string;
  };
  providerAvailability: {
    summary: string;
    unavailableCount: number;
  };
  meta: {
    evidenceItemsUsed: number;
    truncatedInput: boolean;
    warnings: string[];
    caps: {
      maxInputItems: number;
      maxTitleLength: number;
      maxSnippetLength: number;
    };
  };
}

function asNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeText(value: unknown, maxLen: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function normalizeDomain(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const normalized = text.replace(/^https?:\/\//i, "").split("/")[0]?.replace(/^www\./i, "");
  return normalized?.toLowerCase() ?? "";
}

function mapThemeLabel(theme: unknown, language: ReportLanguage): string {
  const key = String(theme ?? "").trim().toLowerCase();
  const mapRu: Record<string, string> = {
    sanctions_watchlist: "санкционные и watchlist-упоминания",
    sanctions: "санкционные и watchlist-упоминания",
    political_exposure: "политическая / публичная экспозиция",
    legal_dispute: "судебные и регуляторные сюжеты",
    criminal: "уголовно-правовой контекст",
    adverse_media: "негативные медиа",
    regulatory: "регуляторные упоминания",
    corporate_ownership: "корпоративные связи и собственность",
    unknown: "тема требует ручной классификации",
  };
  const mapEn: Record<string, string> = {
    sanctions_watchlist: "sanctions and watchlist mentions",
    sanctions: "sanctions and watchlist mentions",
    political_exposure: "political / public exposure",
    legal_dispute: "legal and regulatory stories",
    criminal: "criminal-law context",
    adverse_media: "adverse media",
    regulatory: "regulatory mentions",
    corporate_ownership: "corporate links and ownership",
    unknown: "theme requires manual classification",
  };
  return (language === "ru" ? mapRu : mapEn)[key] ?? (language === "ru"
    ? "тема требует ручной классификации"
    : "theme requires manual classification");
}

function statusFromReview(review: unknown): AiAnalystEvidenceItem["status"] {
  const raw = String(review ?? "").toUpperCase();
  if (raw.includes("REVIEW") || raw.includes("PENDING")) return "requires_review";
  if (raw.includes("CONFIRMED") || raw.includes("REVIEWED")) return "confirmed";
  if (raw.includes("EXCLUDED") || raw.includes("DISMISSED")) return "excluded_noise";
  return "not_confirmed";
}

function capItems<T>(items: T[], maxItems: number): { list: T[]; truncated: boolean } {
  if (items.length <= maxItems) return { list: items, truncated: false };
  return { list: items.slice(0, maxItems), truncated: true };
}

function regionFromAudit(
  reportJson: ReportJson,
  code: "RU" | "INTERNATIONAL",
  outCode: "RU" | "INTL",
  language: ReportLanguage
): AiAnalystEvidencePackRegion | undefined {
  const regions = reportJson.auditSummary?.regions ?? [];
  const region = regions.find((r) => String(r.region).toUpperCase() === code);
  if (!region) return undefined;
  const topResults = (region.topResults ?? []).map((row, idx) => ({
    id: `${outCode.toLowerCase()}-result-${idx + 1}`,
    title: safeText(row.title, 160),
    domain: normalizeDomain((row as { domain?: string }).domain),
    snippet: safeText(row.classification, 220),
    status: statusFromReview((row as { reviewStatus?: string }).reviewStatus),
    theme: undefined,
    source: safeText(row.provider, 80),
  }));
  const byDomain = new Map<string, number>();
  for (const row of region.topResults ?? []) {
    const d = normalizeDomain((row as { domain?: string }).domain);
    if (!d) continue;
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  const domainRows = [...byDomain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, count]) => ({ domain, count }));

  const groupedTheme = new Map<string, number>();
  for (const t of region.topThemes ?? []) {
    const label = mapThemeLabel(t.theme, language);
    groupedTheme.set(label, (groupedTheme.get(label) ?? 0) + asNum(t.count));
  }

  const imageItems = (region.topImages ?? []).length;
  const videoItems = (region.topVideos ?? []).length;

  return {
    code: outCode,
    organicTotal: asNum(region.organicTotal),
    organicPotentialNegative: asNum(region.organicNegative),
    organicConfirmedNegative: 0,
    organicReviewRequired: Math.max(asNum(region.organicNegative), topResults.length),
    organicExcludedNoise: 0,
    imagesTotal: asNum(region.imagesTotal),
    imagesFlagged: Math.max(asNum(region.imagesNegative), imageItems),
    videosTotal: asNum(region.videosTotal),
    videosFlagged: Math.max(asNum(region.videosNegative), videoItems),
    topThemes: [...groupedTheme.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({ label, count })),
    topDomains: domainRows,
    topItems: topResults.slice(0, 12),
  };
}

export function buildAiAnalystEvidencePack(
  reportJson: ReportJson,
  options: { maxInputItems: number }
): AiAnalystEvidencePack {
  const language: ReportLanguage = reportJson.reportLanguage === "en" ? "en" : "ru";
  const caps = {
    maxInputItems: Math.max(20, options.maxInputItems),
    maxTitleLength: 160,
    maxSnippetLength: 220,
  };

  const subject = reportJson.subject;
  const ru = regionFromAudit(reportJson, "RU", "RU", language);
  const intl = regionFromAudit(reportJson, "INTERNATIONAL", "INTL", language);
  const riskSummary = reportJson.riskSummary;
  const auditSummary = reportJson.auditSummary;
  const selected = reportJson.selectedEvidence;

  const selectedRows = (selected?.appendix?.confirmedSubjectEvidence ?? []).map((row, idx) => ({
    id: String((row as { evidenceId?: string }).evidenceId ?? `selected-${idx + 1}`),
    title: safeText((row as { title?: string }).title, caps.maxTitleLength),
    domain: normalizeDomain((row as { domain?: string }).domain),
    snippet: safeText((row as { review?: string }).review, caps.maxSnippetLength),
    status: statusFromReview((row as { review?: string }).review),
    theme: safeText((row as { classification?: string }).classification, 80),
    source: safeText((row as { provider?: string }).provider, 80),
  }));

  const evidenceRows = [
    ...(ru?.topItems ?? []),
    ...(intl?.topItems ?? []),
    ...selectedRows,
  ];
  const dedupe = new Map<string, AiAnalystEvidenceItem>();
  for (const item of evidenceRows) {
    const key = `${item.title.toLowerCase()}|${item.domain.toLowerCase()}`;
    if (!dedupe.has(key)) dedupe.set(key, item);
  }
  const capped = capItems([...dedupe.values()], caps.maxInputItems);

  const compliance = reportJson.complianceSummary;
  const lexis = reportJson.lexisNexisHybrid;
  const provider = reportJson.providerReadinessSummary;
  const unavailableCount = asNum(provider?.unavailableCount);

  const totals = {
    organicTotal: asNum(auditSummary?.searchSummary.totalResults),
    potentialNegative: asNum(auditSummary?.searchSummary.negativeResults),
    confirmedNegative: 0,
    reviewRequired:
      asNum(compliance?.pendingHits) +
      asNum(auditSummary?.riskSummary.totalFindings) +
      asNum(auditSummary?.searchSummary.negativeResults),
    excludedNoise:
      asNum(selected?.metrics?.namesakesExcluded) +
      asNum(selected?.metrics?.insufficientMatchesExcluded) +
      asNum(selected?.appendix?.excludedNamesakesInternalOnly?.length),
    imagesTotal:
      asNum(ru?.imagesTotal) + asNum(intl?.imagesTotal),
    imagesFlagged:
      asNum(ru?.imagesFlagged) + asNum(intl?.imagesFlagged),
    videosTotal:
      asNum(ru?.videosTotal) + asNum(intl?.videosTotal),
    videosFlagged:
      asNum(ru?.videosFlagged) + asNum(intl?.videosFlagged),
  };

  return {
    language,
    subject: {
      fullName: subject.fullName,
      aliases: subject.aliases,
      dateOfBirth: subject.dateOfBirth ?? null,
      nationality: subject.nationality ?? null,
      country: subject.country ?? null,
    },
    risk: {
      overallLevel: String(auditSummary?.overallRiskLevel ?? riskSummary?.highestRiskLevel ?? "UNKNOWN"),
      deterministicSignals: [
        `compliance_pending=${asNum(compliance?.pendingHits)}`,
        `risk_findings=${asNum(auditSummary?.riskSummary.totalFindings)}`,
        `search_negative=${asNum(auditSummary?.searchSummary.negativeResults)}`,
      ],
      riskReasons: listTopRiskReasons(reportJson, language),
    },
    totals,
    regions: {
      ru,
      intl,
    },
    selectedEvidence: {
      confirmedCount: asNum(selected?.metrics?.selectedForReport),
      excludedCount:
        asNum(selected?.metrics?.namesakesExcluded) +
        asNum(selected?.metrics?.insufficientMatchesExcluded),
      rows: selectedRows.slice(0, 30),
    },
    excludedNoiseSummary: {
      count:
        asNum(selected?.metrics?.namesakesExcluded) +
        asNum(selected?.metrics?.insufficientMatchesExcluded),
      note: language === "ru"
        ? "Нерелевантные совпадения по тёзкам и шуму исключены из клиентского вывода."
        : "Namesake/noise matches are excluded from client-facing conclusions.",
    },
    compliance: {
      activeMatches: asNum(compliance?.confirmedHits),
      pendingReview: asNum(compliance?.pendingHits),
      conclusion: safeText(reportJson.complianceRiskIntel?.riskReasoning?.reasoningSummary, 500),
      manualImportSignals: (reportJson.complianceRiskIntel?.manualImport?.note
        ? [String(reportJson.complianceRiskIntel.manualImport.note)]
        : []
      ).slice(0, 3),
    },
    lexisNexis: lexis
      ? {
          importReady: asNum(lexis.parsedSignalSummary.totalDocuments) > 0,
          importStatus: String(lexis.parsedSignalSummary.parserStatus ?? "unknown"),
          totalDocuments: asNum(lexis.parsedSignalSummary.totalDocuments),
          totalSignals: asNum(lexis.parsedSignalSummary.totalSignals),
          reviewRequired: asNum(lexis.parsedSignalSummary.reviewRequired),
          visualPages: (lexis.documents ?? []).reduce((acc, doc) => acc + asNum(doc.renderedPages?.length), 0),
          executiveSummaryClient: safeText(lexis.parsedSignalSummary.executiveSummaryClient, 700),
        }
      : undefined,
    providerAvailability: {
      summary: String(provider?.safeSummaryLabel ?? ""),
      unavailableCount,
    },
    meta: {
      evidenceItemsUsed: capped.list.length,
      truncatedInput: capped.truncated,
      warnings: capped.truncated
        ? [language === "ru" ? "Входные данные сокращены до безопасного лимита." : "Input evidence was truncated to safe limits."]
        : [],
      caps,
    },
  };
}

function listTopRiskReasons(reportJson: ReportJson, language: ReportLanguage): string[] {
  const topThemes = reportJson.auditSummary?.searchSummary.topNegativeThemes ?? [];
  const reasons = topThemes
    .slice(0, 5)
    .map((t) => `${mapThemeLabel(t.theme, language)} (${asNum(t.count)})`);
  if (reasons.length === 0) {
    reasons.push(
      language === "ru"
        ? "Прямые подтверждённые негативные факты не выявлены; часть сигналов ожидает проверки."
        : "No directly confirmed negative facts were found; a subset of signals requires review."
    );
  }
  return reasons;
}
