import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { buildReportJson } from "../services/report-builder-service";
import type { ReportJson } from "../types";
import type { OrionBlueprint, OrionMicroStage, OrionRawEvidence } from "./types";

type SearchResultRow = {
  id: string;
  engine: string;
  source: string | null;
  url: string;
  title: string | null;
  snippet: string | null;
  rank: number | null;
  classification: string;
  reviewStatus: string;
  rawMetadata: Prisma.JsonValue | null;
};

type SearchSurfaceRow = {
  id: string;
  type: string;
  provider: string | null;
  source: string;
  region: string | null;
  language: string | null;
  query: string | null;
  title: string | null;
  snippet: string | null;
  url: string | null;
  domain: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  rank: number | null;
  classification: string | null;
  riskTheme: string | null;
  reviewStatus: string;
  rawMetadata: Prisma.JsonValue | null;
};

type DbProfileRow = {
  id: string;
  provider: string;
  importMethod: string;
  hitSource: string | null;
  matchedName: string | null;
  matchType: string | null;
  matchScore: number | null;
  reviewStatus: string;
  riskTypes: Prisma.JsonValue;
  summary: string | null;
  rawMetadataSafe: Prisma.JsonValue | null;
  profileUrl: string | null;
  evidenceRefs: Prisma.JsonValue;
  importedAt: Date;
};

type RiskFindingRow = {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  reviewStatus: string;
  evidenceRefs: Prisma.JsonValue;
};

type WikiRow = {
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
};

export type OrionCaseScreenshotRow = {
  id: string;
  storageKey: string;
  mimeType: string;
  sourceUrl: string | null;
  resultId: string | null;
  capturedAt: Date;
  sizeBytes: number | null;
};

export interface OrionRealCaseContext {
  caseId: string;
  locale: "ru" | "en";
  subject: {
    fullName: string;
    aliases: string[];
  };
  targetRegions: string[];
  reportJson: ReportJson;
  searchResults: SearchResultRow[];
  searchSurfaces: SearchSurfaceRow[];
  databaseProfiles: DbProfileRow[];
  riskFindings: RiskFindingRow[];
  wikiChecks: WikiRow[];
  /** Captured / persisted SERP screenshots (private storage keys). */
  screenshots: OrionCaseScreenshotRow[];
  providerAvailability: {
    used: string[];
    unavailable: string[];
  };
  lexis: {
    latestReady: Record<string, unknown> | null;
    latestAny: Record<string, unknown> | null;
    visualPageCount: number;
    parsedSignals: number;
    uploadExists: boolean;
  };
}

export interface OrionMicroStageInput {
  microStageKey: string;
  macroSectionKey: string;
  rawEvidence: OrionRawEvidence[];
  visualEvidence: OrionRawEvidence[];
  complianceEvidence: OrionRawEvidence[];
  lexisEvidence: OrionRawEvidence[];
  providerAvailability: OrionRealCaseContext["providerAvailability"];
  queryVariants: string[];
  resultCounts: Record<string, number>;
}

function safeDomain(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const normalized = value.replace(/^https?:\/\//i, "").split("/")[0]?.replace(/^www\./i, "") ?? "";
  return normalized.toLowerCase();
}

function asObj(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hasRuRegion(rawMetadata: Prisma.JsonValue | null | undefined): boolean {
  const rm = asObj(rawMetadata);
  const region = String(rm.orionRegion ?? rm.region ?? "").toUpperCase();
  return !region || region === "RU";
}

function hasIntlRegion(rawMetadata: Prisma.JsonValue | null | undefined): boolean {
  const rm = asObj(rawMetadata);
  const region = String(rm.orionRegion ?? rm.region ?? "").toUpperCase();
  return region === "UAE" || region === "INTERNATIONAL" || region === "INTL";
}

function providerOfResult(r: SearchResultRow): string {
  const source = String(r.source ?? "").toLowerCase();
  if (source.includes("yandex") || String(r.engine).toUpperCase() === "YANDEX") return "YANDEX";
  return "GOOGLE";
}

function mkEvidenceId(stage: string, suffix: string | number): string {
  return `${stage}-${String(suffix)}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function sanitizeTheme(theme: unknown): string {
  const val = String(theme ?? "").trim();
  if (!val) return "Требует ручной проверки";
  if (/^[a-z0-9_/-]+$/i.test(val)) {
    if (val.toLowerCase().includes("sanction")) return "Санкционные / watchlist сигналы";
    if (val.toLowerCase().includes("adverse")) return "Негативные публикации";
    if (val.toLowerCase().includes("pep")) return "PEP / политическая экспозиция";
    return "Требует ручной проверки";
  }
  return val;
}

function searchResultToEvidence(stage: string, row: SearchResultRow, idx: number): OrionRawEvidence {
  const rm = asObj(row.rawMetadata);
  return {
    evidenceId: mkEvidenceId(stage, row.id || idx + 1),
    type: "search_result",
    source: providerOfResult(row),
    title: row.title ?? "",
    snippet: row.snippet ?? "",
    domain: safeDomain(row.url),
    url: row.url,
    query: String(rm.query ?? rm.orionQuery ?? ""),
    locale: String(rm.language ?? "ru"),
    region: String(rm.orionRegion ?? rm.region ?? ""),
    classification:
      row.reviewStatus === "REVIEWED" && /adverse|legal|reputational|sanctions|pep/i.test(row.classification)
        ? "confirmed"
        : row.reviewStatus === "PENDING"
          ? "requires_review"
          : /irrelevant|duplicate/i.test(row.classification)
            ? "excluded_noise"
            : "potential",
    themeLabel: sanitizeTheme(rm.riskTheme ?? rm.themeLabel ?? row.classification),
    metadata: {
      rank: row.rank,
      reviewStatus: row.reviewStatus,
      provider: providerOfResult(row),
    },
  };
}

function surfaceToEvidence(stage: string, row: SearchSurfaceRow, idx: number): OrionRawEvidence {
  const rm = asObj(row.rawMetadata);
  return {
    evidenceId: mkEvidenceId(stage, row.id || idx + 1),
    type: String(row.type ?? "surface").toLowerCase(),
    source: String(row.provider ?? rm.provider ?? row.source ?? "unknown").toUpperCase(),
    title: row.title ?? row.query ?? "",
    snippet: row.snippet ?? "",
    domain: safeDomain(row.domain ?? row.url),
    url: row.url ?? undefined,
    query: row.query ?? undefined,
    locale: row.language ?? undefined,
    region: row.region ?? String(rm.orionRegion ?? rm.region ?? ""),
    classification:
      row.reviewStatus === "REVIEWED" && /adverse|sanctions|pep|legal/i.test(String(row.classification ?? ""))
        ? "confirmed"
        : row.reviewStatus === "PENDING"
          ? "requires_review"
          : /excluded|noise|namesake/i.test(String(row.classification ?? ""))
            ? "excluded_noise"
            : "potential",
    themeLabel: sanitizeTheme(row.riskTheme ?? rm.riskTheme ?? row.classification),
    screenshotRef: typeof rm.screenshotId === "string" ? rm.screenshotId : undefined,
    visualRef:
      typeof rm.thumbnailStorageKey === "string"
        ? rm.thumbnailStorageKey
        : row.imageUrl || row.thumbnailUrl || undefined,
    metadata: {
      type: row.type,
      reviewStatus: row.reviewStatus,
      provider: row.provider,
      surfaceId: row.id,
    },
  };
}

function complianceToEvidence(stage: string, row: DbProfileRow, idx: number): OrionRawEvidence {
  const riskTypes = Array.isArray(row.riskTypes) ? row.riskTypes.map((x) => String(x)) : [];
  return {
    evidenceId: mkEvidenceId(stage, row.id || idx + 1),
    type: "compliance_hit",
    source: row.provider,
    title: row.matchedName ?? row.summary ?? `${row.provider} hit`,
    snippet: row.summary ?? "",
    domain: "",
    classification:
      row.reviewStatus === "MATCH_CONFIRMED"
        ? "confirmed"
        : row.reviewStatus === "FALSE_POSITIVE" || row.reviewStatus === "DISMISSED"
          ? "excluded_noise"
          : "requires_review",
    themeLabel: sanitizeTheme(riskTypes[0] ?? row.matchType ?? "compliance"),
    metadata: {
      provider: row.provider,
      reviewStatus: row.reviewStatus,
      matchScore: row.matchScore,
      importMethod: row.importMethod,
      hitSource: row.hitSource,
    },
  };
}

function findingToEvidence(stage: string, row: RiskFindingRow, idx: number): OrionRawEvidence {
  return {
    evidenceId: mkEvidenceId(stage, row.id || idx + 1),
    type: "risk_finding",
    source: "risk_finding",
    title: row.title,
    snippet: row.summary ?? "",
    classification: row.reviewStatus === "REVIEWED" ? "confirmed" : "requires_review",
    themeLabel: sanitizeTheme(row.category),
    metadata: {
      severity: row.severity,
    },
  };
}

function pickLatestLexisDocument(dbProfiles: DbProfileRow[]): {
  latestReady: Record<string, unknown> | null;
  latestAny: Record<string, unknown> | null;
  uploadExists: boolean;
} {
  const docs = dbProfiles
    .map((r) => {
      const doc = asObj(r.rawMetadataSafe).lexisNexisHybrid;
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
      return {
        doc: doc as Record<string, unknown>,
        importedAt: r.importedAt.toISOString(),
      };
    })
    .filter((x): x is { doc: Record<string, unknown>; importedAt: string } => Boolean(x));
  const sorted = docs.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  const latestAny = sorted[0]?.doc ?? null;
  const latestReady =
    sorted.find(
      (d) =>
        String(d.doc.status ?? "") === "ready" &&
        String((d.doc.parsedAnalytics as Record<string, unknown> | undefined)?.parserStatus ?? "") === "parsed" &&
        (Array.isArray(d.doc.renderedPages) ? d.doc.renderedPages.length > 0 : false)
    )?.doc ?? null;
  return { latestReady, latestAny, uploadExists: docs.length > 0 };
}

export async function loadRealCaseContext(
  caseId: string,
  options: { locale?: "ru" | "en"; buildFreshReportJson?: boolean } = {}
): Promise<OrionRealCaseContext> {
  const locale = options.locale ?? "ru";
  const [caseRow, searchResults, searchSurfaces, databaseProfiles, riskFindings, wikiChecks, latestReport, screenshots] =
    await Promise.all([
      prisma.case.findFirst({
        where: { id: caseId, deletedAt: null },
        select: {
          id: true,
          targetRegions: true,
          subjects: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { fullName: true, aliases: true },
          },
        },
      }),
      prisma.searchResult.findMany({
        where: { caseId },
        orderBy: [{ rank: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          engine: true,
          source: true,
          url: true,
          title: true,
          snippet: true,
          rank: true,
          classification: true,
          reviewStatus: true,
          rawMetadata: true,
        },
      }),
      prisma.searchSurfaceItem.findMany({
        where: { caseId, deletedAt: null },
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          type: true,
          provider: true,
          source: true,
          region: true,
          language: true,
          query: true,
          title: true,
          snippet: true,
          url: true,
          domain: true,
          imageUrl: true,
          thumbnailUrl: true,
          videoUrl: true,
          rank: true,
          classification: true,
          riskTheme: true,
          reviewStatus: true,
          rawMetadata: true,
        },
      }),
      prisma.databaseProfile.findMany({
        where: { caseId },
        orderBy: [{ importedAt: "desc" }],
        select: {
          id: true,
          provider: true,
          importMethod: true,
          hitSource: true,
          matchedName: true,
          matchType: true,
          matchScore: true,
          reviewStatus: true,
          riskTypes: true,
          summary: true,
          rawMetadataSafe: true,
          profileUrl: true,
          evidenceRefs: true,
          importedAt: true,
        },
      }),
      prisma.riskFinding.findMany({
        where: { caseId },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          category: true,
          severity: true,
          title: true,
          summary: true,
          reviewStatus: true,
          evidenceRefs: true,
        },
      }),
      prisma.wikipediaCheck.findMany({
        where: { caseId },
        orderBy: { lastChecked: "desc" },
        select: {
          exists: true,
          url: true,
          language: true,
          pageTitle: true,
        },
      }),
      prisma.reportVersion.findFirst({
        where: { caseId },
        orderBy: { version: "desc" },
        select: { version: true, reportJson: true },
      }),
      // Stage S1 SERP snapshots only — raw page screenshots stay out of classic SERP assets.
      prisma.screenshot.findMany({
        where: {
          caseId,
          deletedAt: null,
          storageKey: { contains: "/serp-snapshots/" },
        },
        orderBy: { capturedAt: "desc" },
        select: {
          id: true,
          storageKey: true,
          mimeType: true,
          sourceUrl: true,
          resultId: true,
          capturedAt: true,
          sizeBytes: true,
        },
      }),
    ]);

  if (!caseRow) {
    throw new Error(`case-not-found:${caseId}`);
  }
  const subject = caseRow.subjects[0];
  const reportJson = options.buildFreshReportJson
    ? await buildReportJson(caseId, (latestReport?.version ?? 0) + 1, "DRAFT", locale)
    : ((latestReport?.reportJson as unknown as ReportJson | undefined) ??
      (await buildReportJson(caseId, 1, "DRAFT", locale)));
  const providerRows = ((reportJson.providerDiagnostics?.providers ?? []) as Array<{ id?: string; status?: string }>) || [];
  const used = providerRows.filter((p) => String(p.status ?? "").toLowerCase() === "ready").map((p) => String(p.id ?? ""));
  const unavailable = providerRows
    .filter((p) => ["not_configured", "failed"].includes(String(p.status ?? "").toLowerCase()))
    .map((p) => String(p.id ?? ""));

  const lexisPicked = pickLatestLexisDocument(databaseProfiles);
  const lexisDoc = (lexisPicked.latestReady ?? lexisPicked.latestAny) as Record<string, unknown> | null;
  const renderedPages = Array.isArray(lexisDoc?.renderedPages) ? (lexisDoc?.renderedPages as Array<Record<string, unknown>>) : [];
  const parsedSignals = Number((lexisDoc?.parsedAnalytics as Record<string, unknown> | undefined)?.signalCounts
    ? Number(((lexisDoc?.parsedAnalytics as Record<string, unknown>).signalCounts as Record<string, unknown>).totalSignals ?? 0)
    : 0);

  return {
    caseId,
    locale,
    subject: {
      fullName: subject?.fullName ?? "Unknown subject",
      aliases: subject?.aliases ?? [],
    },
    targetRegions: caseRow.targetRegions ?? [],
    reportJson,
    searchResults,
    searchSurfaces,
    databaseProfiles,
    riskFindings,
    wikiChecks,
    screenshots,
    providerAvailability: { used, unavailable },
    lexis: {
      latestReady: lexisPicked.latestReady,
      latestAny: lexisPicked.latestAny,
      visualPageCount: renderedPages.length,
      parsedSignals,
      uploadExists: lexisPicked.uploadExists,
    },
  };
}

function stageRegion(stage: OrionMicroStage): "ru" | "uae" | "global" {
  if (stage.microStageKey.startsWith("ru_")) return "ru";
  if (stage.microStageKey.startsWith("uae_")) return "uae";
  return "global";
}

export function extractMicroStageRawEvidence(
  caseContext: OrionRealCaseContext,
  microStage: OrionMicroStage
): OrionRawEvidence[] {
  const region = stageRegion(microStage);
  const stageKey = microStage.microStageKey;
  const rows =
    region === "ru"
      ? caseContext.searchResults.filter((r) => hasRuRegion(r.rawMetadata))
      : region === "uae"
        ? caseContext.searchResults.filter((r) => hasIntlRegion(r.rawMetadata))
        : caseContext.searchResults;

  if (stageKey.includes("search_links_overview") || stageKey.includes("top20_serp_matrix") || stageKey.includes("adverse_themes")) {
    return rows.slice(0, 20).map((r, idx) => searchResultToEvidence(stageKey, r, idx));
  }
  if (stageKey.includes("audit_summary") || stageKey.includes("executive") || stageKey.includes("risk_overview")) {
    const evidence = rows.slice(0, 30).map((r, idx) => searchResultToEvidence(stageKey, r, idx));
    const findings = caseContext.riskFindings.slice(0, 12).map((f, idx) => findingToEvidence(stageKey, f, idx));
    return [...evidence, ...findings];
  }
  return [];
}

export function extractMicroStageVisualEvidence(
  caseContext: OrionRealCaseContext,
  microStage: OrionMicroStage
): OrionRawEvidence[] {
  const stageKey = microStage.microStageKey;
  const region = stageRegion(microStage);
  const rows =
    region === "ru"
      ? caseContext.searchSurfaces.filter((s) => String(s.region ?? "").toUpperCase() !== "UAE")
      : region === "uae"
        ? caseContext.searchSurfaces.filter((s) => String(s.region ?? "").toUpperCase() === "UAE")
        : caseContext.searchSurfaces;
  const lower = stageKey.toLowerCase();
  const providerNeed = lower.includes("yandex") ? "YANDEX" : lower.includes("google") ? "GOOGLE" : "";
  if (lower.includes("images")) {
    return rows
      .filter((s) => s.type === "IMAGE_RESULT")
      .filter((s) => !providerNeed || String(s.provider ?? "").toUpperCase().includes(providerNeed))
      .slice(0, 20)
      .map((s, idx) => surfaceToEvidence(stageKey, s, idx));
  }
  if (lower.includes("videos")) {
    return rows
      .filter((s) => s.type === "VIDEO_RESULT")
      .slice(0, 20)
      .map((s, idx) => surfaceToEvidence(stageKey, s, idx));
  }
  if (lower.includes("knowledge_panel") || lower.includes("knowledge")) {
    return rows
      .filter((s) => s.type === "KNOWLEDGE_BLOCK")
      .filter((s) => !providerNeed || String(s.provider ?? "").toUpperCase().includes(providerNeed))
      .slice(0, 10)
      .map((s, idx) => surfaceToEvidence(stageKey, s, idx));
  }
  if (lower.includes("suggestions")) {
    return rows
      .filter((s) => s.type === "SUGGESTION")
      .filter((s) => !providerNeed || String(s.provider ?? "").toUpperCase().includes(providerNeed))
      .slice(0, 20)
      .map((s, idx) => surfaceToEvidence(stageKey, s, idx));
  }
  if (lower.includes("related_queries")) {
    return rows
      .filter((s) => s.type === "RELATED_QUERY")
      .filter((s) => !providerNeed || String(s.provider ?? "").toUpperCase().includes(providerNeed))
      .slice(0, 20)
      .map((s, idx) => surfaceToEvidence(stageKey, s, idx));
  }
  if (lower.includes("wikipedia")) {
    return caseContext.wikiChecks.slice(0, 5).map((w, idx) => ({
      evidenceId: mkEvidenceId(stageKey, `wiki-${idx + 1}`),
      type: "wikipedia",
      source: "WIKIPEDIA",
      title: w.pageTitle ?? "Wikipedia",
      snippet: w.exists ? "Страница найдена" : "Страница не найдена",
      domain: w.url ? safeDomain(w.url) : "wikipedia.org",
      url: w.url ?? undefined,
      classification: w.exists ? "potential" : "absent",
      themeLabel: w.exists ? "Публичный профиль" : "Отсутствует профиль",
    }));
  }
  return [];
}

export function extractMicroStageComplianceEvidence(
  caseContext: OrionRealCaseContext,
  microStage: OrionMicroStage
): OrionRawEvidence[] {
  const stageKey = microStage.microStageKey;
  if (!microStage.macroSectionKey.includes("compliance") && !stageKey.includes("compliance")) return [];
  const providerNeed = stageKey.includes("dow_jones")
    ? "DOW_JONES"
    : stageKey.includes("world_check")
      ? "WORLD_CHECK"
      : stageKey.includes("lexisnexis")
        ? "LEXISNEXIS"
        : "";
  const rows = caseContext.databaseProfiles.filter((r) => !providerNeed || r.provider === providerNeed);
  if (rows.length === 0 && providerNeed) {
    return [
      {
        evidenceId: mkEvidenceId(stageKey, "unavailable"),
        type: "compliance_unavailable",
        source: providerNeed,
        title: `${providerNeed} данные недоступны`,
        snippet: "Данные отсутствуют или провайдер не был запущен в этом кейсе.",
        classification: "requires_review",
        themeLabel: "Требует ручной проверки",
      },
    ];
  }
  return rows.slice(0, 30).map((r, idx) => complianceToEvidence(stageKey, r, idx));
}

export function extractMicroStageLexisEvidence(
  caseContext: OrionRealCaseContext,
  microStage: OrionMicroStage
): OrionRawEvidence[] {
  const stageKey = microStage.microStageKey;
  if (!stageKey.includes("lexisnexis")) return [];
  const doc = (caseContext.lexis.latestReady ?? caseContext.lexis.latestAny) as Record<string, unknown> | null;
  if (!doc) {
    return [
      {
        evidenceId: mkEvidenceId(stageKey, "not-uploaded"),
        type: "lexis_import_status",
        source: "LEXISNEXIS",
        title: "LexisNexis: документ не загружен",
        snippet: "Импорт LexisNexis не найден для кейса.",
        classification: "requires_review",
        themeLabel: "Требует ручной проверки",
      },
    ];
  }
  const parsed = (doc.parsedAnalytics as Record<string, unknown> | undefined) ?? {};
  const signals = Array.isArray(parsed.signals) ? (parsed.signals as Array<Record<string, unknown>>) : [];
  if (stageKey === "lexisnexis_visual_pages") {
    const renderedPages = Array.isArray(doc.renderedPages) ? (doc.renderedPages as Array<Record<string, unknown>>) : [];
    if (renderedPages.length === 0) {
      return [
        {
          evidenceId: mkEvidenceId(stageKey, "visual-unavailable"),
          type: "lexis_visual_unavailable",
          source: "LEXISNEXIS",
          title: "LexisNexis: визуальные страницы недоступны",
          snippet: "Документ импортирован/разобран, но визуальные страницы не сформированы.",
          classification: "requires_review",
          themeLabel: "Требует ручной проверки",
        },
      ];
    }
    const total = renderedPages.length;
    return renderedPages.map((p, idx) => ({
      evidenceId: mkEvidenceId(stageKey, `page-${idx + 1}`),
      type: "lexis_visual_page",
      source: "LEXISNEXIS",
      title: `LexisNexis page ${Number(p.pageNumber ?? idx + 1)}`,
      snippet: "Импортированная визуальная страница отчёта.",
      visualRef: typeof p.storageKey === "string" ? p.storageKey : undefined,
      classification: "potential",
      themeLabel: "LexisNexis visual",
      metadata: {
        pageNumber: Number(p.pageNumber ?? idx + 1),
        firstPage: idx === 0,
        lastPage: idx === total - 1,
        totalPages: total,
      },
    }));
  }
  return [
    {
      evidenceId: mkEvidenceId(stageKey, "import-status"),
      type: "lexis_import_status",
      source: "LEXISNEXIS",
      title: String(doc.fileName ?? "LexisNexis document"),
      snippet: String(parsed.executiveSummaryClient ?? "Импортирован отчет LexisNexis."),
      classification: String(parsed.parserStatus ?? "") === "parsed" ? "potential" : "requires_review",
      themeLabel: "LexisNexis parsed analytics",
      metadata: {
        parserStatus: parsed.parserStatus,
        totalSignals: Number((parsed.signalCounts as Record<string, unknown> | undefined)?.totalSignals ?? 0),
        reviewRequired: Number((parsed.signalCounts as Record<string, unknown> | undefined)?.reviewRequired ?? 0),
      },
    },
    ...signals.slice(0, 20).map((s, idx) => ({
      evidenceId: mkEvidenceId(stageKey, `signal-${idx + 1}`),
      type: "lexis_signal",
      source: "LEXISNEXIS",
      title: String(s.matchName ?? s.categoryLabelRu ?? "Сигнал LexisNexis"),
      snippet: String(s.clientSafeReason ?? s.clientSafeFinding ?? ""),
      classification:
        s.isConfirmed === true
          ? "confirmed"
          : String(s.category ?? "").includes("sanction") || String(s.category ?? "").includes("watchlist")
            ? "requires_review"
            : "requires_review",
      themeLabel: sanitizeTheme(s.categoryLabelRu ?? s.category ?? "LexisNexis"),
      metadata: {
        reviewStatus:
          s.isConfirmed === true ? "official_record_found" : "database_match_requires_review",
        category: s.category,
      },
    })),
  ];
}

function buildOfferStaticEvidence(caseContext: OrionRealCaseContext, stage: OrionMicroStage): OrionRawEvidence[] {
  const hasSearchReview = caseContext.searchResults.some((r) => r.reviewStatus === "PENDING");
  const hasComplianceReview = caseContext.databaseProfiles.some((r) => r.reviewStatus === "NEEDS_REVIEW");
  const hasWiki = caseContext.wikiChecks.some((w) => w.exists);
  const emphasis = hasComplianceReview
    ? "compliance_db_correction"
    : hasSearchReview
      ? "digital_profile"
      : !hasWiki
        ? "wikipedia"
        : "digital_profile";
  return [
    {
      evidenceId: mkEvidenceId(stage.microStageKey, "offer-static"),
      type: "offer_static",
      source: "COMMERCIAL_CONTEXT",
      title: stage.titleRu,
      snippet: `Адаптация предложения: ${emphasis}.`,
      classification: "potential",
      themeLabel: "Коммерческий блок",
      metadata: {
        emphasis,
      },
    },
  ];
}

export function mapCaseDataToMicroStageInputs(
  caseContext: OrionRealCaseContext,
  blueprint: OrionBlueprint
): Record<string, OrionMicroStageInput> {
  const out: Record<string, OrionMicroStageInput> = {};
  for (const macro of blueprint.macroSections) {
    for (const stage of macro.microStages) {
      const raw = extractMicroStageRawEvidence(caseContext, stage);
      const visual = extractMicroStageVisualEvidence(caseContext, stage);
      const compliance = extractMicroStageComplianceEvidence(caseContext, stage);
      const lexis = extractMicroStageLexisEvidence(caseContext, stage);
      const staticOffer = stage.macroSectionKey === "offer" || stage.macroSectionKey === "about"
        ? buildOfferStaticEvidence(caseContext, stage)
        : [];
      const merged = [...raw, ...visual, ...compliance, ...lexis, ...staticOffer];
      const providersUsed = [...new Set(merged.map((x) => x.source).filter(Boolean))];
      const queryVariants = [
        caseContext.subject.fullName,
        ...caseContext.subject.aliases,
        ...merged.map((x) => String(x.query ?? "").trim()).filter(Boolean),
      ].slice(0, 16);
      out[stage.microStageKey] = {
        microStageKey: stage.microStageKey,
        macroSectionKey: stage.macroSectionKey,
        rawEvidence: merged.length > 0 ? merged : buildOfferStaticEvidence(caseContext, stage),
        visualEvidence: [...visual, ...lexis.filter((x) => x.type === "lexis_visual_page")],
        complianceEvidence: compliance,
        lexisEvidence: lexis,
        providerAvailability: caseContext.providerAvailability,
        queryVariants,
        resultCounts: {
          total: merged.length,
          search: raw.length,
          visual: visual.length,
          compliance: compliance.length,
          lexis: lexis.length,
          providersUsed: providersUsed.length,
        },
      };
    }
  }
  return out;
}

