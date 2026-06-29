/**
 * Stage C1 — compliance screening orchestration, manual import, review, risk sync.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/server/prisma/client";
import type { DatabaseProvider, Prisma } from "@prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "../services/audit-log-service";
import type { ActorContext } from "../services/case-service";
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
  locale: "ru" | "en" = "ru"
): Promise<ComplianceSummaryBlock> {
  const hits = await prisma.databaseProfile.findMany({
    where: { caseId },
    orderBy: { importedAt: "desc" },
  });

  const reviewRequiredWarning =
    locale === "ru"
      ? "Совпадения в compliance-базах являются потенциальными и требуют ручной проверки."
      : "Compliance database hits are potential matches and require manual review.";

  const byRiskType: Record<string, number> = {};
  let pendingHits = 0;
  let confirmedHits = 0;
  let falsePositives = 0;

  for (const h of hits) {
    const rts = (Array.isArray(h.riskTypes) ? h.riskTypes : []) as string[];
    for (const rt of rts) byRiskType[rt] = (byRiskType[rt] ?? 0) + 1;
    if (h.reviewStatus === "PENDING" || h.reviewStatus === "NEEDS_REVIEW") pendingHits++;
    else if (h.reviewStatus === "MATCH_CONFIRMED") confirmedHits++;
    else if (h.reviewStatus === "FALSE_POSITIVE") falsePositives++;
  }

  const warnings: string[] = [];
  if (hits.length === 0) {
    warnings.push(locale === "ru" ? "Комплаенс-скрининг не выполнен." : "No compliance screening recorded.");
  }
  if (pendingHits > 0) warnings.push(reviewRequiredWarning);

  const activeHits = hits.filter((h) => isActiveReview(h.reviewStatus));

  return {
    providerStatuses: listComplianceProviderStatus(),
    totalHits: hits.length,
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
