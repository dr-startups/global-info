/**
 * Stage C1 — compliance screening orchestration, manual import, review, risk sync.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/server/prisma/client";
import type { DatabaseProvider, Prisma } from "@prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "../services/audit-log-service";
import type { ActorContext } from "../services/case-service";
import { saveFile } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { loadCaseSubject } from "../agents/mock/mock-utils";
import { listComplianceProviderStatus, getComplianceProviderStatus } from "./config";
import { dowJonesProvider } from "./dow-jones-provider";
import { lexisnexisProvider } from "./lexisnexis-provider";
import { worldCheckProvider } from "./worldcheck-provider";
import { manualImportProvider } from "./manual-import-provider";
import type { ComplianceProvider } from "./provider-interface";
import { computeMatchScore } from "./match-scoring";
import { normalizeComplianceHit, riskTypesToMatchType, sanitizeRawMetadata } from "./normalizer";
import type {
  ComplianceHitReviewStatus,
  ComplianceProviderName,
  ComplianceRiskType,
  ComplianceScreeningResult,
  ComplianceSummaryBlock,
  ManualComplianceImportInput,
} from "./types";
import {
  buildFallbackLexisDocument,
  processLexisNexisDocx,
  toRenderedPageModel,
} from "./lexisnexis-hybrid-import";
import type { ImportedEvidenceDocument, LexisNexisSignal } from "../types";

export const COMPLIANCE_FINDING_OWNER = "compliance-layer-v1";

const RISK_FINDING_TYPES: ReadonlySet<ComplianceRiskType> = new Set([
  "SANCTIONS",
  "PEP",
  "WATCHLIST",
  "LAW_ENFORCEMENT",
  "ADVERSE_MEDIA",
]);

const PROVIDER_LABELS: Record<string, string> = {
  DOW_JONES: "Dow Jones",
  LEXISNEXIS: "LexisNexis",
  WORLD_CHECK: "World-Check",
  OTHER: "Other",
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function providerOf(name: ComplianceProviderName): ComplianceProvider {
  switch (name) {
    case "DOW_JONES":
      return dowJonesProvider;
    case "LEXISNEXIS":
      return lexisnexisProvider;
    case "WORLD_CHECK":
      return worldCheckProvider;
    default:
      return manualImportProvider;
  }
}

function dbProviderOf(name: ComplianceProviderName | ManualComplianceImportInput["provider"]): DatabaseProvider {
  if (name === "MANUAL_IMPORT") return "OTHER";
  return name as DatabaseProvider;
}

function riskThemeOf(riskTypes: ComplianceRiskType[]): string {
  if (riskTypes.includes("SANCTIONS")) return "sanctions";
  if (riskTypes.includes("PEP") || riskTypes.includes("POLITICAL_EXPOSURE")) return "pep_rca";
  if (riskTypes.includes("ADVERSE_MEDIA")) return "adverse_media";
  if (riskTypes.includes("LAW_ENFORCEMENT") || riskTypes.includes("LEGAL")) return "criminal";
  return "compliance_database";
}

function severityOf(riskTypes: ComplianceRiskType[]): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (riskTypes.includes("SANCTIONS")) return "HIGH";
  if (riskTypes.includes("PEP") || riskTypes.includes("WATCHLIST")) return "MEDIUM";
  return "LOW";
}

function complianceDedupHash(caseId: string, provider: string, profileId: string | null, matchedName: string): string {
  return createHash("sha256")
    .update(`${caseId}|compliance-hit|${provider}|${profileId ?? matchedName}`)
    .digest("hex");
}

function isActiveReview(status: string): boolean {
  return status === "PENDING" || status === "MATCH_CONFIRMED" || status === "NEEDS_REVIEW";
}

export function getComplianceProvider(name: ComplianceProviderName): ComplianceProvider {
  return providerOf(name);
}

export { listComplianceProviderStatus, getComplianceProviderStatus };

export async function runComplianceScreening(
  caseId: string,
  providerName: ComplianceProviderName,
  ctx: ActorContext = {}
): Promise<ComplianceScreeningResult & { screeningRunId?: string }> {
  if (providerName === "MANUAL_IMPORT") {
    return {
      status: "NOT_CONFIGURED",
      provider: providerName,
      hits: [],
      error: {
        code: "USE_MANUAL_IMPORT",
        message: "Use Add Manual Compliance Hit instead.",
        retryable: false,
      },
    };
  }

  const subject = await loadCaseSubject(caseId);
  const provider = providerOf(providerName);
  const startedAt = new Date();
  const result = await provider.screenPerson({
    caseId,
    subjectFullName: subject.fullName,
    aliases: subject.aliases,
    dateOfBirth: null,
    country: subject.location,
  });

  const run = await prisma.complianceScreeningRun.create({
    data: {
      caseId,
      provider: dbProviderOf(providerName),
      status: result.status,
      subjectName: subject.fullName,
      hitCount: result.hits.length,
      errorCode: result.error?.code ?? null,
      errorMessage: result.error?.message ?? null,
      runBy: ctx.actorId ?? null,
      startedAt,
      finishedAt: new Date(),
    },
  });

  await recordAudit({
    caseId,
    action: "COMPLIANCE_SCREENING_RUN",
    actorId: ctx.actorId,
    metadata: {
      screeningRunId: run.id,
      provider: providerName,
      status: result.status,
      hitCount: result.hits.length,
      ...(result.error ? { errorCode: result.error.code } : {}),
    },
  });

  if (result.hits.length > 0) {
    for (const hit of result.hits) {
      await persistComplianceHit(caseId, hit, run.id, ctx);
    }
  }

  return { ...result, screeningRunId: run.id };
}

async function persistComplianceHit(
  caseId: string,
  hit: ReturnType<typeof normalizeComplianceHit>,
  screeningRunId: string | null,
  ctx: ActorContext,
  importMethod: "MANUAL_IMPORT" | "OFFICIAL_API" = "OFFICIAL_API"
) {
  const row = await prisma.databaseProfile.create({
    data: {
      caseId,
      provider: dbProviderOf(hit.provider),
      importMethod,
      matchType: riskTypesToMatchType(hit.riskTypes),
      matchScore: hit.matchScore,
      hitSource: hit.source,
      screeningRunId,
      subjectName: hit.subjectName,
      matchedName: hit.matchedName,
      aliases: toJson(hit.aliases),
      categories: toJson(hit.categories),
      riskTypes: toJson(hit.riskTypes),
      countries: toJson(hit.countries),
      datesOfBirth: toJson(hit.datesOfBirth),
      confidence: hit.confidence,
      profileId: hit.profileId ?? null,
      profileUrl: hit.profileUrl ?? null,
      summary: hit.summary,
      reviewStatus: hit.reviewStatus,
      rawMetadataSafe: toJson(hit.rawMetadataSafe),
      evidenceRefs: toJson(
        hit.profileUrl
          ? [{ type: "URL", url: hit.profileUrl, label: "Compliance profile" }]
          : [{ type: "DATABASE_RECORD", label: `${hit.provider} potential match` }]
      ),
      importedBy: ctx.actorId ?? null,
    },
  });

  const findingId = await syncComplianceRiskFinding(caseId, row.id, ctx);
  if (findingId) {
    await prisma.databaseProfile.update({
      where: { id: row.id },
      data: { riskFindingId: findingId },
    });
  }
  return row;
}

export async function importManualComplianceHit(
  caseId: string,
  input: ManualComplianceImportInput,
  ctx: ActorContext = {}
) {
  const subject = await loadCaseSubject(caseId);
  const scoring = computeMatchScore({
    subjectFullName: subject.fullName,
    subjectAliases: subject.aliases,
    subjectDob: null,
    subjectCountry: subject.location,
    matchedName: input.matchedName,
    matchedDob: input.datesOfBirth?.[0] ?? null,
    matchedCountry: input.countries?.[0] ?? null,
    riskTypes: input.riskTypes,
  });

  const matchScore = input.matchScore ?? scoring.matchScore;
  const confidence = input.confidence ?? scoring.confidence;
  const providerLabel = PROVIDER_LABELS[input.provider] ?? input.provider;

  const evidenceRefs: Array<{ type: string; url?: string; label: string }> = [];
  if (input.evidenceUrl) evidenceRefs.push({ type: "URL", url: input.evidenceUrl, label: "Import source" });
  if (input.profileUrl) evidenceRefs.push({ type: "URL", url: input.profileUrl, label: "Compliance profile" });
  if (evidenceRefs.length === 0) {
    evidenceRefs.push({ type: "DATABASE_RECORD", label: `Manual import — ${providerLabel}` });
  }

  const hit = normalizeComplianceHit({
    provider:
      input.provider === "OTHER"
        ? "MANUAL_IMPORT"
        : (input.provider as ComplianceProviderName),
    source: "MANUAL",
    subjectName: subject.fullName,
    matchedName: input.matchedName,
    aliases: [],
    categories: input.categories ?? [],
    riskTypes: input.riskTypes,
    countries: input.countries ?? [],
    datesOfBirth: input.datesOfBirth ?? [],
    matchScore,
    confidence,
    profileId: input.profileId,
    profileUrl: input.profileUrl,
    summary:
      input.summary ??
      `Manual import from ${providerLabel}. Potential match — requires analyst review.`,
    reviewStatus: input.reviewStatus ?? "PENDING",
    extraMetadata: {
      manualImportLabel: "Manual import from compliance database",
      providerLabel,
      scoringSignals: scoring.signals,
    },
  });

  const row = await prisma.databaseProfile.create({
    data: {
      caseId,
      provider: input.provider as DatabaseProvider,
      importMethod: "MANUAL_IMPORT",
      matchType: riskTypesToMatchType(input.riskTypes),
      matchScore,
      hitSource: "MANUAL",
      subjectName: subject.fullName,
      matchedName: input.matchedName,
      aliases: toJson([]),
      categories: toJson(input.categories ?? []),
      riskTypes: toJson(input.riskTypes),
      countries: toJson(input.countries ?? []),
      datesOfBirth: toJson(input.datesOfBirth ?? []),
      confidence,
      profileId: input.profileId ?? null,
      profileUrl: input.profileUrl ?? null,
      summary: hit.summary,
      reviewStatus: hit.reviewStatus,
      rawMetadataSafe: toJson(hit.rawMetadataSafe),
      evidenceRefs: toJson(evidenceRefs),
      importedBy: ctx.actorId ?? null,
    },
  });

  const findingId = await syncComplianceRiskFinding(caseId, row.id, ctx);
  if (findingId) {
    await prisma.databaseProfile.update({ where: { id: row.id }, data: { riskFindingId: findingId } });
  }

  await recordAudit({
    caseId,
    action: "COMPLIANCE_MANUAL_IMPORT",
    actorId: ctx.actorId,
    metadata: {
      hitId: row.id,
      provider: input.provider,
      riskTypes: input.riskTypes,
      reviewStatus: row.reviewStatus,
    },
  });

  return row;
}

export interface LexisNexisHybridImportResult {
  document: ImportedEvidenceDocument;
  parsedSignalsCreated: number;
  reviewRequiredCount: number;
  parserStatus: "parsed" | "partial" | "warning" | "failed";
  conversionStatus: "ready" | "warning" | "failed";
}

function signalToRiskTypes(signal: LexisNexisSignal): ComplianceRiskType[] {
  switch (signal.category) {
    case "sanctions_watchlist":
      return ["SANCTIONS", "WATCHLIST"];
    case "pep_political_exposure":
      return ["PEP", "POLITICAL_EXPOSURE"];
    case "adverse_media":
      return ["ADVERSE_MEDIA"];
    case "legal_regulatory":
      return ["LEGAL", "LAW_ENFORCEMENT"];
    case "corporate_ownership":
      return ["OTHER"];
    case "identity_match":
      return ["OTHER"];
    default:
      return ["OTHER"];
  }
}

function isLexisHybridMaster(row: {
  rawMetadataSafe: Prisma.JsonValue | null;
}): boolean {
  const safe = (row.rawMetadataSafe ?? {}) as Record<string, unknown>;
  const hybrid = (safe.lexisNexisHybrid ?? {}) as Record<string, unknown>;
  return String(hybrid.kind ?? "") === "lexisnexis_report";
}

export async function importLexisNexisHybridReport(
  caseId: string,
  input: {
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  },
  ctx: ActorContext = {}
): Promise<LexisNexisHybridImportResult> {
  await loadCaseSubject(caseId);
  const now = new Date();
  const documentRow = await prisma.databaseProfile.create({
    data: {
      caseId,
      provider: "LEXISNEXIS",
      importMethod: "MANUAL_IMPORT",
      matchType: "LEXISNEXIS_IMPORTED_REPORT",
      matchScore: null,
      hitSource: "MANUAL",
      subjectName: "Imported LexisNexis report",
      matchedName: input.fileName,
      aliases: toJson([]),
      categories: toJson(["IMPORTED_REPORT"]),
      riskTypes: toJson([]),
      countries: toJson([]),
      datesOfBirth: toJson([]),
      confidence: "LOW",
      profileId: null,
      profileUrl: null,
      summary:
        "Импортированный отчёт LexisNexis добавлен в приложение. Материал требует аналитической проверки и не является юридическим заключением.",
      reviewStatus: "DISMISSED",
      rawMetadataSafe: toJson({
        lexisNexisHybrid: {
          kind: "lexisnexis_report",
          sourceLabel: "LexisNexis",
          status: "uploaded",
        },
      }),
      evidenceRefs: toJson([]),
      importedBy: ctx.actorId ?? null,
      importedAt: now,
    },
    select: { id: true, importedAt: true },
  });

  const originalStorageKey = buildStorageKey.evidence(
    caseId,
    documentRow.id,
    "lexisnexis-original.docx"
  );
  await saveFile(originalStorageKey, input.buffer);
  const processing = await processLexisNexisDocx({
    documentId: documentRow.id,
    fileBuffer: input.buffer,
    originalFileName: input.fileName,
  });
  const renderedPages: ImportedEvidenceDocument["renderedPages"] = [];
  const renderedEvidenceRefs: Array<Record<string, unknown>> = [
    {
      type: "IMPORTED_FILE",
      refId: documentRow.id,
      storageKey: originalStorageKey,
      label: input.fileName,
      capturedAt: now.toISOString(),
    },
  ];

  for (const page of processing.renderedPageFiles) {
    const pageStorageKey = buildStorageKey.evidence(
      caseId,
      documentRow.id,
      `lexisnexis-page-${String(page.pageNumber).padStart(3, "0")}.png`
    );
    await saveFile(pageStorageKey, page.fileBytes);
    renderedPages.push(toRenderedPageModel(page, pageStorageKey));
    renderedEvidenceRefs.push({
      type: "IMPORTED_FILE",
      refId: `${documentRow.id}:page:${page.pageNumber}`,
      storageKey: pageStorageKey,
      label: `LexisNexis page ${page.pageNumber}`,
      capturedAt: now.toISOString(),
    });
  }

  const parsedSignals = processing.parsedAnalytics.signals;
  let parsedSignalsCreated = 0;
  for (const signal of parsedSignals) {
    const row = await prisma.databaseProfile.create({
      data: {
        caseId,
        provider: "LEXISNEXIS",
        importMethod: "MANUAL_IMPORT",
        matchType: "LEXISNEXIS_SIGNAL",
        matchScore:
          signal.riskLevel === "high" ? 85 : signal.riskLevel === "medium" ? 65 : 45,
        hitSource: "MANUAL",
        subjectName: processing.parsedAnalytics.subjectNameDetected ?? "Imported LexisNexis signal",
        matchedName: signal.matchName,
        aliases: toJson([]),
        categories: toJson([signal.category]),
        riskTypes: toJson(signalToRiskTypes(signal)),
        countries: toJson([]),
        datesOfBirth: toJson([]),
        confidence:
          signal.confidenceLabel === "high"
            ? "HIGH"
            : signal.confidenceLabel === "medium"
              ? "MEDIUM"
              : "LOW",
        profileId: null,
        profileUrl: null,
        summary: `${signal.clientSafeFinding} ${signal.clientSafeReason}`,
        reviewStatus: "NEEDS_REVIEW",
        rawMetadataSafe: toJson({
          lexisNexisSignal: true,
          evidenceDocumentId: documentRow.id,
          signal,
        }),
        evidenceRefs: toJson([
          {
            type: "IMPORTED_FILE",
            refId: documentRow.id,
            storageKey: originalStorageKey,
            label: input.fileName,
            capturedAt: now.toISOString(),
          },
        ]),
        importedBy: ctx.actorId ?? null,
        importedAt: now,
      },
      select: { id: true },
    });
    parsedSignalsCreated += 1;
    await syncComplianceRiskFinding(caseId, row.id, ctx);
  }

  const conversionStatus: "ready" | "warning" | "failed" =
    processing.renderedPageFiles.length > 0
      ? processing.conversionWarnings.length > 0
        ? "warning"
        : "ready"
      : "failed";
  const document =
    processing.parsedAnalytics.signals.length === 0 && processing.status === "failed"
      ? buildFallbackLexisDocument(
          {
            documentId: documentRow.id,
            caseId,
            fileName: input.fileName,
            storageKey: originalStorageKey,
            importedAt: documentRow.importedAt.toISOString(),
            importedBy: ctx.actorId ?? null,
          },
          "hybrid_import_failed"
        )
      : {
          id: documentRow.id,
          caseId,
          kind: "lexisnexis_report" as const,
          sourceLabel: "LexisNexis" as const,
          fileName: input.fileName,
          storageKey: originalStorageKey,
          importedAt: documentRow.importedAt.toISOString(),
          importedBy: ctx.actorId ?? null,
          status: processing.status,
          pageCount: renderedPages.length,
          renderedPages,
          parsedAnalytics: processing.parsedAnalytics,
          clientVisible: true,
          internalNotes: Array.from(
            new Set([...processing.parserWarnings, ...processing.conversionWarnings])
          ),
          provenance: {
            importMethod: "manual_upload" as const,
            parserVersion: processing.parsedAnalytics.parserVersion,
            conversionAvailable: processing.renderedPageFiles.length > 0,
          },
        };

  await prisma.databaseProfile.update({
    where: { id: documentRow.id },
    data: {
      rawMetadataSafe: toJson({
        lexisNexisHybrid: document,
      }),
      evidenceRefs: toJson(renderedEvidenceRefs),
      reviewStatus: "DISMISSED",
    },
  });

  await recordAudit({
    caseId,
    action: "COMPLIANCE_MANUAL_IMPORT",
    actorId: ctx.actorId,
    metadata: {
      hitId: documentRow.id,
      provider: "LEXISNEXIS",
      importType: "LEXISNEXIS_HYBRID_DOCX",
      parserStatus: document.parsedAnalytics.parserStatus,
      conversionStatus,
      pages: document.pageCount,
      signals: document.parsedAnalytics.signalCounts.totalSignals,
    },
  });

  return {
    document,
    parsedSignalsCreated,
    reviewRequiredCount: document.parsedAnalytics.signalCounts.reviewRequired,
    parserStatus: document.parsedAnalytics.parserStatus,
    conversionStatus,
  };
}

export async function syncComplianceRiskFinding(
  caseId: string,
  hitId: string,
  ctx: ActorContext = {}
): Promise<string | null> {
  const hit = await prisma.databaseProfile.findFirst({ where: { id: hitId, caseId } });
  if (!hit) return null;

  const riskTypes = (Array.isArray(hit.riskTypes) ? hit.riskTypes : []) as ComplianceRiskType[];
  const shouldCreate = riskTypes.some((rt) => RISK_FINDING_TYPES.has(rt));
  if (!shouldCreate) return null;

  if (hit.reviewStatus === "FALSE_POSITIVE" || hit.reviewStatus === "DISMISSED") {
    if (hit.riskFindingId) {
      const existing = await prisma.riskFinding.findUnique({ where: { id: hit.riskFindingId } });
      if (existing && existing.reviewStatus !== "REVIEWED") {
        await prisma.riskFinding.update({
          where: { id: hit.riskFindingId },
          data: { reviewStatus: "DISMISSED", reviewedBy: ctx.actorId ?? null, reviewedAt: new Date() },
        });
      }
    }
    return hit.riskFindingId;
  }

  const dedupHash = complianceDedupHash(caseId, hit.provider, hit.profileId, hit.matchedName ?? "");
  const existing = await prisma.riskFinding.findFirst({ where: { caseId, dedupHash } });
  if (existing) {
    if (existing.reviewStatus === "REVIEWED" || existing.reviewStatus === "DISMISSED") {
      return existing.id;
    }
    await prisma.riskFinding.update({
      where: { id: existing.id },
      data: {
        severity: hit.reviewStatus === "MATCH_CONFIRMED" ? severityOf(riskTypes) : "LOW",
        title: `Potential compliance match — ${PROVIDER_LABELS[hit.provider] ?? hit.provider}`,
        summary: hit.summary ?? "Potential match requiring analyst review.",
        reviewStatus: hit.reviewStatus === "MATCH_CONFIRMED" ? "REVIEWED" : "PENDING",
        riskTheme: riskThemeOf(riskTypes),
        signalType: "COMPLIANCE_DATABASE_MATCH",
      },
    });
    return existing.id;
  }

  const created = await prisma.riskFinding.create({
    data: {
      caseId,
      category: riskThemeOf(riskTypes),
      severity: "LOW",
      title: `Potential compliance match — ${PROVIDER_LABELS[hit.provider] ?? hit.provider}`,
      summary:
        hit.summary ??
        "Compliance database potential match. Not a verified fact — analyst review required.",
      evidenceRefs: toJson([
        { type: "DATABASE_PROFILE", id: hit.id, title: hit.matchedName ?? "Compliance hit", provider: hit.provider },
      ]),
      reviewStatus: "PENDING",
      createdBy: COMPLIANCE_FINDING_OWNER,
      signalType: "COMPLIANCE_DATABASE_MATCH",
      riskTheme: riskThemeOf(riskTypes),
      confidence: (hit.matchScore ?? 0) / 100,
      rationale: "Automated compliance hit — potential match only.",
      dedupHash,
    },
  });

  await recordAudit({
    caseId,
    action: "COMPLIANCE_RISK_FINDING_CREATED",
    actorId: ctx.actorId,
    metadata: { hitId, findingId: created.id, provider: hit.provider },
  });

  return created.id;
}

export async function reviewComplianceHit(
  hitId: string,
  reviewStatus: ComplianceHitReviewStatus,
  ctx: ActorContext = {}
) {
  const hit = await prisma.databaseProfile.findUnique({ where: { id: hitId } });
  if (!hit) throw new NotFoundError("Compliance hit not found");

  const row = await prisma.databaseProfile.update({
    where: { id: hitId },
    data: {
      reviewStatus,
      reviewedBy: ctx.actorId ?? null,
      reviewedAt: new Date(),
    },
  });

  const auditAction =
    reviewStatus === "FALSE_POSITIVE"
      ? "COMPLIANCE_HIT_FALSE_POSITIVE"
      : "COMPLIANCE_HIT_REVIEWED";

  await recordAudit({
    caseId: hit.caseId,
    action: auditAction,
    actorId: ctx.actorId,
    metadata: { hitId, reviewStatus, provider: hit.provider },
  });

  await syncComplianceRiskFinding(hit.caseId, hitId, ctx);

  return row;
}

export async function buildComplianceSummaryBlock(
  caseId: string,
  locale: "ru" | "en" = "ru",
  options: { includeDemoData?: boolean } = {}
): Promise<ComplianceSummaryBlock> {
  const includeDemo = options.includeDemoData === true;
  const allHits = await prisma.databaseProfile.findMany({
    where: { caseId },
    orderBy: { importedAt: "desc" },
  });

  const hits = includeDemo
    ? allHits
    : allHits.filter(
        (h) =>
          h.hitSource !== "MOCK" &&
          !(h.importedBy ?? "").startsWith("mock:") &&
          !(h.rawMetadataSafe as { demo?: boolean } | null)?.demo
      );
  const filteredHits = hits.filter((h) => !isLexisHybridMaster(h));

  const reviewRequiredWarning =
    locale === "ru"
      ? "Совпадения в compliance-базах являются потенциальными и требуют проверки аналитиком."
      : "Compliance database hits are potential matches and require analyst review.";

  const byRiskType: Record<string, number> = {};
  let pendingHits = 0;
  let confirmedHits = 0;
  let falsePositives = 0;

  for (const h of filteredHits) {
    const rts = (Array.isArray(h.riskTypes) ? h.riskTypes : []) as string[];
    for (const rt of rts) byRiskType[rt] = (byRiskType[rt] ?? 0) + 1;
    if (h.reviewStatus === "PENDING" || h.reviewStatus === "NEEDS_REVIEW") pendingHits++;
    else if (h.reviewStatus === "MATCH_CONFIRMED") confirmedHits++;
    else if (h.reviewStatus === "FALSE_POSITIVE") falsePositives++;
  }

  const warnings: string[] = [];
  if (filteredHits.length === 0) {
    if (allHits.length > 0 && !includeDemo) {
      warnings.push(
        locale === "ru"
          ? "Ручные compliance-записи не добавлены. Реальные провайдеры не настроены."
          : "No manual compliance records added. Real providers are not configured."
      );
    } else {
      warnings.push(locale === "ru" ? "Комплаенс-скрининг не выполнен." : "No compliance screening recorded.");
    }
  }
  if (pendingHits > 0) warnings.push(reviewRequiredWarning);

  const activeHits = filteredHits.filter((h) => isActiveReview(h.reviewStatus));

  return {
    providerStatuses: listComplianceProviderStatus(),
    totalHits: filteredHits.length,
    pendingHits,
    confirmedHits,
    falsePositives,
    byRiskType,
    topHits: activeHits.slice(0, 10).map((h) => ({
      id: h.id,
      provider: h.provider,
      matchedName: h.matchedName ?? "—",
      riskTypes: (Array.isArray(h.riskTypes) ? h.riskTypes : []) as string[],
      matchScore: h.matchScore,
      confidence: h.confidence,
      reviewStatus: h.reviewStatus,
      source: h.hitSource,
    })),
    dataQualityWarnings: warnings,
    reviewRequiredWarning,
  };
}

export function mapHitSourceLabel(source: string, locale: "ru" | "en"): string {
  if (source === "MANUAL") {
    return locale === "ru"
      ? "Ручной импорт из compliance-базы"
      : "Manual import from compliance database";
  }
  if (source === "MOCK") return locale === "ru" ? "Demo/mock" : "Demo/mock";
  return locale === "ru" ? "Официальный API" : "Official API";
}
