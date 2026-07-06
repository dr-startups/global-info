import { prisma } from "@/server/prisma/client";
import { reportPricing } from "../config";
import { buildOfferConfig } from "../report/offer-config";
import { buildStaticPages } from "../report/static-pages";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import type { SerpSnapshotViewModel } from "../serp-snapshot/types";
import { saveFile } from "../storage/private-store";
import type { AuditSummary } from "../audit-summary/types";
import type { ReportJson, SubjectProfile } from "../types";
import { buildQaReportSpecCaseContext } from "./qa-case-context";

export type R98aCaseSource = "env" | "db" | "fixture";

export interface R98aCaseResolution {
  caseId: string;
  source: R98aCaseSource;
  hasRealData: boolean;
}

export async function resolveR98aCaseId(): Promise<R98aCaseResolution> {
  const envCase = process.env.CASE_ID?.trim();
  if (envCase) {
    return { caseId: envCase, source: "env", hasRealData: true };
  }
  try {
    const row = await prisma.case.findFirst({
      where: {
        searchResults: { some: {} },
        searchSurfaceItems: { some: {} },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        _count: { select: { searchResults: true, searchSurfaceItems: true } },
      },
    });
    if (row && row._count.searchResults > 0) {
      return {
        caseId: row.id,
        source: "db",
        hasRealData: row._count.searchSurfaceItems > 0,
      };
    }
  } catch {
    // DB unavailable — fixture fallback
  }
  return { caseId: "qa-r98a-fixture-case", source: "fixture", hasRealData: false };
}

function buildFixtureAuditSummary(ctx: ReturnType<typeof buildQaReportSpecCaseContext>): AuditSummary {
  const now = new Date().toISOString();
  const images = ctx.searchSurfaces.filter((s) => s.type === "IMAGE_RESULT");
  const videos = ctx.searchSurfaces.filter((s) => s.type === "VIDEO_RESULT");
  const knowledge = ctx.searchSurfaces.find((s) => s.type === "KNOWLEDGE_BLOCK");
  return {
    caseId: ctx.caseId,
    subjectFullName: ctx.subject.fullName,
    generatedAt: now,
    overallRiskLevel: "MEDIUM",
    overallTone: "caution",
    executiveSummary: ["Проверены открытые источники и поисковая выдача."],
    keyFindings: [],
    recommendedActions: ["Провести ручную верификацию спорных сигналов."],
    regions: [
      {
        region: "RU",
        language: "ru",
        organicTotal: ctx.searchResults.length,
        organicNegative: 1,
        organicNeutral: 2,
        organicPositive: 0,
        organicNegativeShare: 0.25,
        uniqueNegativeUrls: 1,
        totalUniqueUrls: ctx.searchResults.length,
        suggestionsTotal: 1,
        suggestionsNegative: 0,
        relatedQueriesTotal: 0,
        relatedQueriesNegative: 0,
        imagesTotal: images.length,
        imagesNegative: 0,
        videosTotal: videos.length,
        videosNegative: 0,
        knowledgeBlockStatus: knowledge ? "PRESENT" : "ABSENT",
        collectionStatus: "COLLECTED",
        regionRiskLevel: "MEDIUM",
        regionConclusion: "Обнаружены сигналы, требующие ручной проверки.",
        topResults: ctx.searchResults.slice(0, 6).map((r) => ({
          provider: r.engine,
          rank: r.rank,
          domain: new URL(r.url).hostname,
          title: r.title ?? "",
          classification: r.classification,
        })),
        topSuggestions: ["иван петров биография"],
        topImages: images.map((i) => ({ title: i.title ?? "Изображение", url: i.imageUrl })),
        topVideos: videos.map((v) => ({ title: v.title ?? "Видео", url: v.videoUrl })),
        topThemes: [{ theme: "adverse_media", count: 1 }],
        topNegativeDomains: ["news.example.ru"],
        topNegativeUrls: [{ title: "Материал с упоминанием санкционного контекста", domain: "news.example.ru", classification: "adverse_media" }],
        topRelatedQueries: [],
        knowledgeBlock: knowledge
          ? { title: knowledge.title ?? "", snippet: knowledge.snippet ?? "", source: "Google" }
          : null,
        evidenceAppendix: [],
      },
    ],
    searchSummary: {
      totalResults: ctx.searchResults.length,
      uniqueUrls: ctx.searchResults.length,
      negativeResults: 1,
      negativeShare: 0.25,
      negativeDomains: ["news.example.ru"],
      topNegativeThemes: [{ theme: "adverse_media", count: 1 }],
      topNegativeUrls: [{ url: "https://news.example.ru/article/sanctions-context", title: "Sanctions context" }],
    },
    surfacesSummary: {
      suggestions: { total: 1, negative: 0, negativeShare: 0 },
      relatedQueries: { total: 0, negative: 0, negativeShare: 0 },
      images: { total: images.length, negative: 0, negativeShare: 0 },
      videos: { total: videos.length, negative: 0, negativeShare: 0 },
      knowledgeBlocks: { total: knowledge ? 1 : 0, mismatches: 0 },
      screenshots: 0,
      syntheticSnapshots: 1,
    },
    wikipediaSummary: { exists: false, pageUrl: null, language: null, notabilityScore: 0, conclusion: "Страница не найдена." },
    complianceDatabaseSummary: {
      providersChecked: ["WORLD_CHECK"],
      activeMatches: 1,
      pepMatches: 1,
      rcaMatches: 0,
      sanctionsMatches: 0,
      adverseMediaMatches: 1,
      conclusion: "Требуется ручная верификация совпадений.",
    },
    riskSummary: {
      highestRiskLevel: "MEDIUM",
      totalFindings: ctx.riskFindings.length,
      findingsByLevel: { MEDIUM: 1 },
      findingsByTheme: { adverse_media: 1 },
      topFindings: ctx.riskFindings.slice(0, 3).map((f) => ({
        severity: f.severity,
        theme: f.category,
        title: f.title,
        reviewStatus: f.reviewStatus,
        evidenceCount: 0,
      })),
    },
    dataQualitySummary: {
      evidenceCount: ctx.searchResults.length + ctx.searchSurfaces.length,
      reviewedFindings: 0,
      pendingFindings: ctx.riskFindings.length,
      dismissedFindings: 0,
      missingSections: [],
      warnings: [],
    },
  };
}

async function embedFixtureSerpSnapshot(caseId: string, subjectName: string): Promise<{ storageKey: string; imageBase64: string }> {
  const vm: SerpSnapshotViewModel = {
    title: "Поисковая выдача",
    dateLabel: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date()),
    subjectName,
    query: `${subjectName} биография`,
    language: "ru",
    themes: [{ themeNumber: 1, themeLabel: "Тема 1", title: "Негативные публикации", count: 1, resultIds: ["2"], color: "#c0392b" }],
    noNegatives: false,
    engines: {
      yandex: {
        engine: "YANDEX",
        query: `${subjectName} биография`,
        results: [
          {
            rank: 1,
            title: "Профиль в деловых СМИ",
            url: "https://example.ru/news/profile",
            domain: "example.ru",
            snippet: "Публикация о профессиональной деятельности.",
            classification: "neutral",
            isHighlighted: false,
          },
          {
            rank: 2,
            title: "Материал с санкционным контекстом",
            url: "https://news.example.ru/sanctions",
            domain: "news.example.ru",
            snippet: "Требует ручной проверки.",
            classification: "adverse_media",
            isHighlighted: true,
            themeLabel: "Негативные публикации",
          },
        ],
        empty: false,
      },
      google: { engine: "GOOGLE", query: `${subjectName} biography`, results: [], empty: true },
    },
    width: 1400,
    height: 900,
    footerNote: "Синтетический снимок на основе сохранённых результатов поиска",
    sourceLabel: "Яндекс",
  };
  const png = await renderSerpSnapshotPng(vm);
  const storageKey = `digital-profile/cases/${caseId}/qa-r98a/serp-snapshot.png`;
  await saveFile(storageKey, png);
  return { storageKey, imageBase64: png.toString("base64") };
}

function fixtureSubject(ctx: ReturnType<typeof buildQaReportSpecCaseContext>): SubjectProfile {
  const now = new Date().toISOString();
  return {
    id: "qa-subject",
    caseId: ctx.caseId,
    fullName: ctx.subject.fullName,
    aliases: ctx.subject.aliases,
    dateOfBirth: null,
    nationality: null,
    country: "RU",
    emails: [],
    phones: [],
    identifiers: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function buildLegacyReportJsonForR98a(resolution: R98aCaseResolution): Promise<{
  reportJson: ReportJson;
  caseContext: Awaited<ReturnType<typeof loadRealCaseContext>> | ReturnType<typeof buildQaReportSpecCaseContext>;
}> {
  if (resolution.source === "fixture") {
    const ctx = buildQaReportSpecCaseContext();
    const serp = await embedFixtureSerpSnapshot(resolution.caseId, ctx.subject.fullName);
    const reportJson: ReportJson = {
      meta: {
        caseNumber: "QA-R98A",
        title: "QA R9.8a Legacy Visual GPT",
        generatedAt: new Date().toISOString(),
        version: 1,
        status: "DRAFT",
        watermark: undefined,
        language: "ru",
        demo: false,
      },
      subject: fixtureSubject(ctx),
      dynamicPages: [],
      staticPages: buildStaticPages(reportPricing),
      pricing: reportPricing,
      reportLanguage: "ru",
      auditSummary: buildFixtureAuditSummary(ctx),
      offer: buildOfferConfig("ru"),
      serpSnapshot: {
        id: "qa-serp-1",
        storageKey: serp.storageKey,
        imageBase64: serp.imageBase64,
        query: `${ctx.subject.fullName} биография`,
        mode: "SYNTHETIC",
        metadata: {
          engines: ["YANDEX"],
          language: "ru",
          themeCount: 1,
          highlightedCount: 1,
          resultCount: 2,
          width: 1400,
          height: 900,
          generatedAt: new Date().toISOString(),
          sourceMode: "MIXED",
          hasRealResults: true,
          reportResultCount: 2,
        },
      },
    };
    return { reportJson, caseContext: ctx };
  }

  const caseContext = await loadRealCaseContext(resolution.caseId, {
    locale: "ru",
    buildFreshReportJson: true,
  });
  return { reportJson: caseContext.reportJson, caseContext };
}
