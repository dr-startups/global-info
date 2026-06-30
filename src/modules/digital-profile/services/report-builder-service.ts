/**
 * Report builder service (Stage D).
 *
 * Assembles a self-contained `ReportJson` from a case, its subject and collected
 * evidence, then persists it as a new `ReportVersion` (DRAFT + "DRAFT" watermark).
 *
 * Rules:
 *  - Evidence-first: every dynamic page's factual content carries evidence refs.
 *  - Human-review gate: only REVIEWED risk findings are included.
 *  - LLM is not a source of fact: AI profiles are included only as summaries that
 *    themselves reference evidence, and always carry their disclaimer.
 *  - Static commercial pages + pricing come from config, not from evidence.
 *
 * PPTX/PDF rendering happens in Stage E; here pptxUrl/pdfUrl stay null.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { digitalProfileConfig, reportPricing } from "../config";
import { buildStaticPages } from "../report/static-pages";
import { buildAuditSummary } from "../audit-summary/builder";
import { buildComplianceSummaryBlock } from "../compliance-providers";
import { buildOfferConfig } from "../report/offer-config";
import {
  buildSearchSurfacesReportBlock,
  regionBlockToAuditRegion,
} from "../report/search-surfaces-report-builder";
import { buildCaseEvidenceQuality } from "../evidence-quality/case-service";
import { capOverallRiskFromQuality } from "../evidence-quality/build-summary";
import {
  createInternalHygieneWarning,
  filterComplianceForReport,
  filterSearchResultsForReport,
  isDemoComplianceHit,
  isDemoFinding,
  isDemoSearchRow,
  REPORT_WARNING_DEMO_COMPLIANCE_EXCLUDED,
  REPORT_WARNING_DEMO_SEARCH_EXCLUDED,
  REPORT_WARNING_UNLINKED_FINDINGS_EXCLUDED,
  resolveReportDataPolicy,
  sanitizeReportJsonForAudience,
  type ReportJsonAudience,
  type ReportWarning,
} from "../report/report-data-policy";
import {
  normalizeReportLanguage,
  type ReportLanguage,
} from "../report/i18n/report-dictionary";
import {
  buildReportDownloadUrl,
  buildScreenshotDownloadUrl,
} from "../storage/signed-url";
import {
  ensureFreshSerpSnapshotForReport,
  staleEmbedBlockedWarning,
} from "../serp-snapshot/snapshot-freshness";
import { countUnlinkedActiveRiskFindings } from "../serp-snapshot/data-loader";
import type { ActorContext } from "./case-service";
import type {
  EvidenceRef,
  ReportJson,
  ReportPageData,
  ReportRiskSummary,
  ReportStatus,
  RiskSeverity,
  SubjectProfile,
} from "../types";

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function asEvidenceRefs(value: Prisma.JsonValue): EvidenceRef[] {
  return Array.isArray(value) ? (value as unknown as EvidenceRef[]) : [];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export interface ReportVersionDTO {
  id: string;
  caseId: string;
  version: number;
  status: ReportStatus;
  watermark: string | null;
  renderedAt: Date | null;
  pptxDownloadUrl: string | null;
  pdfDownloadUrl: string | null;
  createdAt: Date;
  reportJson: ReportJson;
}

/**
 * Builds the report JSON for a case at a given version. Pure read — does not
 * persist anything.
 */
export async function buildReportJson(
  caseId: string,
  version: number,
  status: ReportStatus = "DRAFT",
  language: ReportLanguage | string = digitalProfileConfig.defaultLocale,
  options: { demo?: boolean } = {}
): Promise<ReportJson> {
  const reportLanguage = normalizeReportLanguage(language, digitalProfileConfig.defaultLocale);
  const policy = resolveReportDataPolicy({ demo: options.demo });
  const reportWarnings: ReportWarning[] = [];
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      caseNumber: true,
      title: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          id: true,
          caseId: true,
          fullName: true,
          aliases: true,
          dateOfBirth: true,
          nationality: true,
          country: true,
          emails: true,
          phones: true,
          identifiers: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!caseRow) throw new NotFoundError("Case not found");

  const s = caseRow.subjects[0];
  const subject: SubjectProfile = s
    ? {
        id: s.id,
        caseId: s.caseId,
        fullName: s.fullName,
        aliases: s.aliases,
        dateOfBirth: iso(s.dateOfBirth),
        nationality: s.nationality,
        country: s.country,
        emails: s.emails,
        phones: s.phones,
        identifiers: (s.identifiers as Record<string, unknown> | null) ?? null,
        notes: s.notes,
        createdAt: iso(s.createdAt)!,
        updatedAt: iso(s.updatedAt)!,
      }
    : {
        id: "",
        caseId,
        fullName: "Unknown subject",
        aliases: [],
        dateOfBirth: null,
        nationality: null,
        country: null,
        emails: [],
        phones: [],
        identifiers: null,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  const [searchResults, screenshots, wikiChecks, dbProfiles, aiProfiles, findings] =
    await Promise.all([
      prisma.searchResult.findMany({
        where: {
          caseId,
          classification: { notIn: ["IRRELEVANT", "DUPLICATE"] },
        },
        orderBy: [{ rank: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          url: true,
          title: true,
          snippet: true,
          classification: true,
          reviewStatus: true,
          engine: true,
          source: true,
          rawMetadata: true,
        },
      }),
      prisma.screenshot.findMany({
        // Exclude synthetic SERP snapshots (Stage S1) from the raw-screenshot page;
        // they are surfaced separately via report_json.serpSnapshot.
        where: {
          caseId,
          deletedAt: null,
          NOT: { storageKey: { contains: "/serp-snapshots/" } },
        },
        orderBy: { capturedAt: "desc" },
        select: {
          id: true,
          storageKey: true,
          sourceUrl: true,
          capturedAt: true,
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
      prisma.databaseProfile.findMany({
        where: { caseId },
        orderBy: { importedAt: "desc" },
        select: {
          provider: true,
          importMethod: true,
          matchType: true,
          matchScore: true,
          evidenceRefs: true,
          hitSource: true,
          matchedName: true,
          riskTypes: true,
          reviewStatus: true,
          importedBy: true,
          rawMetadataSafe: true,
          rawPayload: true,
        },
      }),
      prisma.aiProfile.findMany({
        where: { caseId },
        orderBy: { createdAt: "desc" },
        select: {
          model: true,
          summary: true,
          disclaimer: true,
          evidenceRefs: true,
        },
      }),
      // Human-review gate: only REVIEWED findings reach the report.
      prisma.riskFinding.findMany({
        where: { caseId, reviewStatus: "REVIEWED" },
        orderBy: { severity: "desc" },
        select: {
          category: true,
          severity: true,
          title: true,
          summary: true,
          evidenceRefs: true,
          riskTheme: true,
          demo: true,
        },
      }),
    ]);

  const searchFiltered = filterSearchResultsForReport(searchResults, isDemoSearchRow, policy);
  if (searchFiltered.excluded > 0) {
    reportWarnings.push(
      createInternalHygieneWarning(
        reportLanguage === "ru"
          ? REPORT_WARNING_DEMO_SEARCH_EXCLUDED.ru
          : REPORT_WARNING_DEMO_SEARCH_EXCLUDED.en
      )
    );
  }
  const productionSearchResults = searchFiltered.rows;

  const complianceFiltered = filterComplianceForReport(dbProfiles, isDemoComplianceHit, policy);
  if (complianceFiltered.excluded > 0) {
    reportWarnings.push(
      createInternalHygieneWarning(
        reportLanguage === "ru"
          ? REPORT_WARNING_DEMO_COMPLIANCE_EXCLUDED.ru
          : REPORT_WARNING_DEMO_COMPLIANCE_EXCLUDED.en
      )
    );
  }
  const productionDbProfiles = complianceFiltered.rows;

  const unlinkedFindings = await countUnlinkedActiveRiskFindings(caseId);
  if (unlinkedFindings > 0) {
    reportWarnings.push(
      createInternalHygieneWarning(
        reportLanguage === "ru"
          ? REPORT_WARNING_UNLINKED_FINDINGS_EXCLUDED.ru
          : REPORT_WARNING_UNLINKED_FINDINGS_EXCLUDED.en
      )
    );
  }

  const productionFindings = policy.includeDemoData
    ? findings
    : findings.filter((f) => !isDemoFinding(f));

  const overallRisk =
    productionFindings.length === 0
      ? "NONE"
      : productionFindings
          .map((f) => f.severity as RiskSeverity)
          .reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), "INFO");

  const generatedAt = new Date().toISOString();
  const watermark = status === "FINAL" ? undefined : "DRAFT";

  const dynamicPages: ReportPageData[] = [];

  // Cover
  dynamicPages.push({
    kind: "COVER",
    templateSlide: "cover",
    title: caseRow.title,
    subtitle: subject.fullName,
    body: [`Case ${caseRow.caseNumber}`, `Generated ${generatedAt}`],
  });

  // Summary
  dynamicPages.push({
    kind: "SUMMARY",
    templateSlide: "summary",
    title: "Executive summary",
    body: [`Overall risk level: ${overallRisk}`],
    table: {
      columns: ["Evidence type", "Count"],
      rows: [
        ["Search results (relevant)", productionSearchResults.length],
        ["Screenshots", screenshots.length],
        ["Wikipedia checks", wikiChecks.length],
        ["Compliance database profiles", productionDbProfiles.length],
        ["AI summaries", aiProfiles.length],
        ["Risk findings (reviewed)", productionFindings.length],
      ],
    },
  });

  // Subject
  dynamicPages.push({
    kind: "SUBJECT",
    templateSlide: "subject",
    title: "Subject",
    table: {
      columns: ["Field", "Value"],
      rows: [
        ["Full name", subject.fullName],
        ["Aliases", subject.aliases.join(", ") || "—"],
        ["Date of birth", subject.dateOfBirth ?? "—"],
        ["Nationality", subject.nationality ?? "—"],
        ["Country", subject.country ?? "—"],
      ],
    },
  });

  // Search results
  if (productionSearchResults.length > 0) {
    dynamicPages.push({
      kind: "SEARCH_RESULTS",
      templateSlide: "search_results",
      title: "Open-source search results",
      table: {
        columns: ["Title", "URL", "Classification", "Reviewed"],
        rows: productionSearchResults.map((r) => [
          r.title ?? "—",
          r.url,
          r.classification,
          r.reviewStatus,
        ]),
      },
      evidence: productionSearchResults.map<EvidenceRef>((r) => ({
        type: "URL",
        refId: r.id,
        url: r.url,
        label: r.title ?? r.url,
      })),
    });
  }

  // Screenshots
  if (screenshots.length > 0) {
    dynamicPages.push({
      kind: "SCREENSHOTS",
      templateSlide: "screenshots",
      title: "Screenshots",
      images: screenshots.map((sc) => ({
        storageKey: sc.storageKey,
        url: buildScreenshotDownloadUrl(sc.id, sc.storageKey),
        caption: sc.sourceUrl ?? undefined,
        evidence: {
          type: "SCREENSHOT",
          refId: sc.id,
          storageKey: sc.storageKey,
          url: sc.sourceUrl ?? undefined,
          capturedAt: sc.capturedAt.toISOString(),
        },
      })),
      evidence: screenshots.map<EvidenceRef>((sc) => ({
        type: "SCREENSHOT",
        refId: sc.id,
        storageKey: sc.storageKey,
      })),
    });
  }

  // Wikipedia
  if (wikiChecks.length > 0) {
    dynamicPages.push({
      kind: "WIKIPEDIA",
      templateSlide: "wikipedia",
      title: "Wikipedia presence",
      table: {
        columns: ["Exists", "Language", "Page title", "URL"],
        rows: wikiChecks.map((w) => [
          w.exists ? "Yes" : "No",
          w.language ?? "—",
          w.pageTitle ?? "—",
          w.url ?? "—",
        ]),
      },
      evidence: wikiChecks
        .filter((w) => w.url)
        .map<EvidenceRef>((w) => ({ type: "URL", url: w.url! })),
    });
  }

  // Compliance databases
  if (productionDbProfiles.length > 0) {
    dynamicPages.push({
      kind: "COMPLIANCE_DATABASES",
      templateSlide: "compliance_databases",
      title: "Compliance database screening",
      subtitle:
        reportLanguage === "ru"
          ? "Совпадения являются потенциальными и требуют ручной проверки."
          : "Hits are potential matches and require manual analyst review.",
      table: {
        columns: ["Provider", "Source", "Matched name", "Risk types", "Score", "Review"],
        rows: productionDbProfiles.map((d) => [
          d.provider,
          d.hitSource ?? d.importMethod,
          d.matchedName ?? "—",
          Array.isArray(d.riskTypes) ? (d.riskTypes as string[]).join(", ") : d.matchType ?? "—",
          d.matchScore ?? "—",
          d.reviewStatus ?? "PENDING",
        ]),
      },
      evidence: productionDbProfiles.flatMap((d) => asEvidenceRefs(d.evidenceRefs)),
    });
  }

  // AI profile (summaries only; never a source of fact)
  if (aiProfiles.length > 0) {
    dynamicPages.push({
      kind: "AI_PROFILE",
      templateSlide: "ai_profile",
      title: "AI-assisted summary",
      subtitle: aiProfiles[0].disclaimer,
      body: aiProfiles.map((a) => a.summary ?? "").filter(Boolean),
      evidence: aiProfiles.flatMap((a) => asEvidenceRefs(a.evidenceRefs)),
    });
  }

  // Risk findings (reviewed only)
  if (productionFindings.length > 0) {
    dynamicPages.push({
      kind: "RISK_FINDINGS",
      templateSlide: "risk_findings",
      title: "Risk findings",
      table: {
        columns: ["Severity", "Category", "Finding"],
        rows: productionFindings.map((f) => [f.severity, f.category, f.title]),
      },
      evidence: productionFindings.flatMap((f) => asEvidenceRefs(f.evidenceRefs)),
    });
  }

  const findingsByLevel: Record<string, number> = {};
  const findingsByTheme: Record<string, number> = {};
  for (const f of productionFindings) {
    findingsByLevel[f.severity] = (findingsByLevel[f.severity] ?? 0) + 1;
    const theme = f.riskTheme ?? f.category;
    findingsByTheme[theme] = (findingsByTheme[theme] ?? 0) + 1;
  }
  const riskSummary: ReportRiskSummary = {
    highestRiskLevel: overallRisk,
    totalFindings: productionFindings.length,
    findingsByLevel,
    findingsByTheme,
    topFindings: productionFindings.slice(0, 5).map((f) => ({
      severity: f.severity,
      theme: f.riskTheme ?? f.category,
      title: f.title,
      evidenceCount: asEvidenceRefs(f.evidenceRefs).length,
    })),
  };

  // Stage J — full deterministic audit summary (best-effort; never blocks report).
  // Stage L2 — built in the report language so its prose matches the report.
  let auditSummary;
  try {
    auditSummary = await buildAuditSummary(caseId, { locale: reportLanguage, demo: options.demo });
  } catch {
    auditSummary = undefined;
  }

  // Stage S1 + R1.1.3 — fresh synthetic SERP snapshot for report embedding.
  let serpSnapshot: ReportJson["serpSnapshot"];
  try {
    const subjectName = caseRow.subjects[0]?.fullName ?? "";
    const fresh = await ensureFreshSerpSnapshotForReport(caseId, reportLanguage, {
      subjectName,
      actorId: undefined,
    });
    if (fresh.internalWarning) {
      reportWarnings.push(fresh.internalWarning);
    }
    const latest = fresh.snapshot;
    if (latest) {
      serpSnapshot = {
        id: latest.id,
        storageKey: latest.storageKey,
        query: latest.query,
        mode: "SYNTHETIC",
        metadata: {
          engines: latest.engines,
          language: latest.language,
          themeCount: latest.themeCount,
          highlightedCount: latest.highlightedCount,
          resultCount: latest.resultCount,
          width: latest.width,
          height: latest.height,
          generatedAt: latest.generatedAt,
          sourceMode: latest.sourceMode,
          perEngine: latest.perEngine,
          hasRealResults: productionSearchResults.some((r) =>
            String(r.source ?? "").toLowerCase().startsWith("real:")
          ),
          reportResultCount: productionSearchResults.length,
          wasRegeneratedForReport: fresh.wasRegenerated,
          staleReason: fresh.staleReason,
        },
      };
    } else if (fresh.regenerateFailed || fresh.staleReason) {
      reportWarnings.push(staleEmbedBlockedWarning(reportLanguage));
      serpSnapshot = undefined;
    }
  } catch {
    serpSnapshot = undefined;
  }

  let complianceSummary: ReportJson["complianceSummary"];
  try {
    complianceSummary = await buildComplianceSummaryBlock(caseId, reportLanguage, {
      includeDemoData: policy.includeDemoData,
    });
  } catch {
    complianceSummary = undefined;
  }

  // Stage O4 — ORION search surfaces block (best-effort).
  let searchSurfaces: ReportJson["searchSurfaces"];
  try {
    searchSurfaces = await buildSearchSurfacesReportBlock(caseId, {
      includeDemo: policy.includeDemoData,
    });
    if (auditSummary && searchSurfaces) {
      const mergedRegions = [];
      for (const [code, block] of [
        ["RU", searchSurfaces.regions.ru],
        ["UAE", searchSurfaces.regions.uae],
        ["INTERNATIONAL", searchSurfaces.regions.international],
      ] as const) {
        const mapped = regionBlockToAuditRegion(block);
        if (mapped) mergedRegions.push({ ...mapped, region: code });
      }
      if (mergedRegions.length > 0) {
        auditSummary = {
          ...auditSummary,
          regions: mergedRegions as typeof auditSummary.regions,
        };
      }
    }
  } catch {
    searchSurfaces = undefined;
  }

  // Stage O5 — evidence quality summary (best-effort).
  let evidenceQuality: ReportJson["evidenceQuality"];
  try {
    evidenceQuality = await buildCaseEvidenceQuality(caseId);
    if (auditSummary && evidenceQuality) {
      const reviewedHigh = (riskSummary?.findingsByLevel?.HIGH ?? 0) + (riskSummary?.findingsByLevel?.CRITICAL ?? 0);
      const capped = capOverallRiskFromQuality(
        auditSummary.overallRiskLevel,
        evidenceQuality,
        reviewedHigh
      );
      if (capped !== auditSummary.overallRiskLevel) {
        auditSummary = { ...auditSummary, overallRiskLevel: capped as typeof auditSummary.overallRiskLevel };
      }
    }
  } catch {
    evidenceQuality = undefined;
  }

  return {
    meta: {
      caseNumber: caseRow.caseNumber,
      title: caseRow.title,
      generatedAt,
      version,
      status,
      watermark,
      language: reportLanguage,
      demo: policy.includeDemoData || undefined,
      reportWarnings: reportWarnings.length > 0 ? reportWarnings : undefined,
    },
    subject,
    dynamicPages,
    staticPages: buildStaticPages(reportPricing),
    pricing: reportPricing,
    riskSummary,
    auditSummary,
    offer: buildOfferConfig(reportLanguage),
    reportLanguage,
    serpSnapshot,
    complianceSummary,
    searchSurfaces,
    evidenceQuality,
  };
}

const reportVersionSelect = {
  id: true,
  caseId: true,
  version: true,
  status: true,
  watermark: true,
  pptxStorageKey: true,
  pdfStorageKey: true,
  renderedAt: true,
  createdAt: true,
  reportJson: true,
} satisfies Prisma.ReportVersionSelect;

function toReportVersionDTO(
  row: Prisma.ReportVersionGetPayload<{ select: typeof reportVersionSelect }>,
  options: { audience?: ReportJsonAudience } = {}
): ReportVersionDTO {
  const reportJson = row.reportJson as unknown as ReportJson;
  return {
    id: row.id,
    caseId: row.caseId,
    version: row.version,
    status: row.status as ReportStatus,
    watermark: row.watermark,
    renderedAt: row.renderedAt,
    pptxDownloadUrl: row.pptxStorageKey
      ? buildReportDownloadUrl(row.id, row.pptxStorageKey, "pptx")
      : null,
    pdfDownloadUrl: row.pdfStorageKey
      ? buildReportDownloadUrl(row.id, row.pdfStorageKey, "pdf")
      : null,
    createdAt: row.createdAt,
    reportJson: sanitizeReportJsonForAudience(
      reportJson as unknown as Record<string, unknown>,
      options.audience ?? "internal"
    ) as unknown as ReportJson,
  };
}

/** Builds a fresh report_json and stores it as a new DRAFT report version. */
export async function createReportVersion(
  caseId: string,
  ctx: ActorContext = {},
  options: { language?: ReportLanguage } = {}
): Promise<ReportVersionDTO> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const agg = await prisma.reportVersion.aggregate({
        where: { caseId },
        _max: { version: true },
      });
      const nextVersion = (agg._max.version ?? 0) + 1;

      const reportJson = await buildReportJson(
        caseId,
        nextVersion,
        "DRAFT",
        options.language ?? digitalProfileConfig.defaultLocale
      );

      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.reportVersion.create({
          data: {
            caseId,
            version: nextVersion,
            status: "DRAFT",
            watermark: "DRAFT",
            reportJson: toJson(reportJson),
            createdBy: ctx.actorId ?? null,
          },
          select: reportVersionSelect,
        });
        await recordAudit(
          {
            caseId,
            action: "REPORT_GENERATED",
            actorId: ctx.actorId,
            metadata: { version: nextVersion },
          },
          tx
        );
        return created;
      });

      return toReportVersionDTO(row);
    } catch (err) {
      const isUnique =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002";
      if (isUnique && attempt === 0) continue;
      throw err;
    }
  }
  throw new Error("Failed to create report version");
}

/** Returns the latest report version for a case, or throws NotFound. */
export async function getLatestReport(
  caseId: string,
  ctx: ActorContext = {},
  options: { audience?: ReportJsonAudience } = {}
): Promise<ReportVersionDTO> {
  const row = await prisma.reportVersion.findFirst({
    where: { caseId },
    orderBy: { version: "desc" },
    select: reportVersionSelect,
  });
  if (!row) throw new NotFoundError("No report generated for this case");

  await recordAudit({
    caseId,
    action: "REPORT_VIEWED",
    actorId: ctx.actorId,
    metadata: { version: row.version, audience: options.audience ?? "internal" },
  });

  return toReportVersionDTO(row, options);
}
