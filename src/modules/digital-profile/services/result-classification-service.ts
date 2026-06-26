/**
 * Stage N1.3 — search-result classification service.
 *
 * Runs the deterministic result classifier over a case's stored search_results,
 * persists the classification into `SearchResult.rawMetadata.riskClassification`
 * (additive, no migration), and upserts risk_findings for risky results
 * (idempotent + review-safe). Also supports analyst manual override (mark
 * adverse / mark neutral / assign theme / clear). No LLM, no network.
 *
 * Manual override always wins over automatic classification (enforced in the
 * snapshot highlight resolver). REVIEWED/DISMISSED findings are never overwritten.
 */

import { createHash } from "node:crypto";
import { Prisma, RiskSeverity } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError, ValidationError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import type { ActorContext } from "./case-service";
import {
  classifySearchResultRecord,
  isRiskyResultClass,
  mergeRiskClassification,
  readRiskClassification,
  themeForClass,
  type AutoResultClassification,
  type ManualResultClassification,
  type ResultClass,
  type ResultConfidence,
  type ResultRiskTheme,
} from "../risk-classifier/result-classifier";

export const RESULT_CLASSIFIER_OWNER = "result-classifier-n13";

const SEVERITY_BY_CONFIDENCE: Record<ResultConfidence, RiskSeverity> = {
  LOW: RiskSeverity.LOW,
  MEDIUM: RiskSeverity.MEDIUM,
  HIGH: RiskSeverity.HIGH,
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function findingDedupHash(caseId: string, resultId: string, theme: string): string {
  return createHash("sha256")
    .update(`${caseId}|N13_RESULT|${theme}|${resultId}`)
    .digest("hex");
}

export interface ClassifyResultsSummary {
  totalScanned: number;
  classified: number;
  risky: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsSkippedReviewed: number;
  findingsDismissedIgnored: number;
}

async function ensureActiveCase(caseId: string): Promise<void> {
  const found = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null }, select: { id: true } });
  if (!found) throw new NotFoundError("Case not found");
}

/**
 * Classifies every stored search result for a case and upserts findings for the
 * risky ones (MEDIUM/HIGH). Idempotent: re-runs refresh PENDING findings and
 * never touch REVIEWED/DISMISSED ones.
 */
export async function classifyCaseSearchResults(
  caseId: string,
  ctx: ActorContext = {}
): Promise<ClassifyResultsSummary> {
  await ensureActiveCase(caseId);

  const [rows, existingFindings] = await Promise.all([
    prisma.searchResult.findMany({
      where: { caseId },
      select: {
        id: true,
        engine: true,
        url: true,
        title: true,
        snippet: true,
        classification: true,
        source: true,
        rawMetadata: true,
      },
    }),
    prisma.riskFinding.findMany({
      where: { caseId, createdBy: RESULT_CLASSIFIER_OWNER },
      select: { id: true, dedupHash: true, reviewStatus: true },
    }),
  ]);

  const existingByHash = new Map<string, { id: string; reviewStatus: string }>();
  for (const f of existingFindings) {
    if (f.dedupHash) existingByHash.set(f.dedupHash, { id: f.id, reviewStatus: f.reviewStatus });
  }

  const summary: ClassifyResultsSummary = {
    totalScanned: rows.length,
    classified: 0,
    risky: 0,
    findingsCreated: 0,
    findingsUpdated: 0,
    findingsSkippedReviewed: 0,
    findingsDismissedIgnored: 0,
  };
  const classifiedAt = new Date().toISOString();

  for (const r of rows) {
    const result = classifySearchResultRecord({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      provider: r.engine,
      source: r.source,
    });
    const auto: AutoResultClassification = { ...result, classifiedAt };

    // Preserve any manual override; only refresh the auto block.
    const prev = readRiskClassification(r.rawMetadata);
    const nextRaw = mergeRiskClassification(r.rawMetadata, { auto, manual: prev?.manual ?? null });
    await prisma.searchResult.update({
      where: { id: r.id },
      data: { rawMetadata: toJson(nextRaw) },
    });
    summary.classified += 1;

    // Upsert a finding only for risky MEDIUM/HIGH auto classifications. Manual
    // overrides are authoritative for highlighting and are handled separately.
    const isRisky =
      isRiskyResultClass(result.classification) &&
      (result.confidence === "MEDIUM" || result.confidence === "HIGH");
    if (!isRisky) continue;
    summary.risky += 1;

    const theme = result.riskTheme ?? themeForClass(result.classification);
    const dedupHash = findingDedupHash(caseId, r.id, theme);
    const existing = existingByHash.get(dedupHash);
    const data = {
      category: theme,
      severity: SEVERITY_BY_CONFIDENCE[result.confidence],
      title: `Potential ${theme.replace(/_/g, " ")} mention (real search result)`,
      summary: result.rationale,
      evidenceRefs: toJson([
        {
          type: "SEARCH_RESULT",
          id: r.id,
          title: r.title ?? undefined,
          url: r.url,
          provider: r.engine,
          source: r.source ?? undefined,
        },
      ]),
      signalType: result.classification,
      riskTheme: theme,
      confidence: result.confidence === "HIGH" ? 0.8 : result.confidence === "MEDIUM" ? 0.6 : 0.4,
      rationale: result.rationale,
      demo: (r.source ?? "").startsWith("mock"),
    };

    if (existing) {
      if (existing.reviewStatus === "REVIEWED") {
        summary.findingsSkippedReviewed += 1;
        continue;
      }
      if (existing.reviewStatus === "DISMISSED") {
        summary.findingsDismissedIgnored += 1;
        continue;
      }
      await prisma.riskFinding.update({ where: { id: existing.id }, data });
      summary.findingsUpdated += 1;
      continue;
    }

    await prisma.riskFinding.create({
      data: {
        caseId,
        reviewStatus: "PENDING",
        createdBy: RESULT_CLASSIFIER_OWNER,
        dedupHash,
        ...data,
      },
    });
    summary.findingsCreated += 1;
  }

  await recordAudit({
    caseId,
    action: "SEARCH_RESULTS_CLASSIFIED_RUN",
    actorId: ctx.actorId,
    metadata: { ...summary },
  });

  return summary;
}

export interface SetManualClassificationInput {
  classification: ResultClass;
  riskTheme?: ResultRiskTheme | null;
  rationale?: string | null;
}

async function loadResultCase(resultId: string): Promise<{ caseId: string; rawMetadata: unknown }> {
  const row = await prisma.searchResult.findUnique({
    where: { id: resultId },
    select: { caseId: true, rawMetadata: true },
  });
  if (!row) throw new NotFoundError("Search result not found");
  return row;
}

/** Applies an analyst manual classification (authoritative over auto). */
export async function setManualResultClassification(
  resultId: string,
  input: SetManualClassificationInput,
  ctx: ActorContext = {}
): Promise<{ caseId: string }> {
  const row = await loadResultCase(resultId);
  const risky = isRiskyResultClass(input.classification);
  const manual: ManualResultClassification = {
    classification: input.classification,
    riskTheme: input.riskTheme ?? (risky ? themeForClass(input.classification) : null),
    rationale: input.rationale ?? null,
    reviewedBy: ctx.actorId ?? null,
    reviewedAt: new Date().toISOString(),
  };
  const nextRaw = mergeRiskClassification(row.rawMetadata, { manual });
  await prisma.searchResult.update({
    where: { id: resultId },
    data: { rawMetadata: toJson(nextRaw), reviewStatus: "REVIEWED" },
  });
  await recordAudit({
    caseId: row.caseId,
    action: "SEARCH_RESULT_MANUAL_CLASSIFIED",
    actorId: ctx.actorId,
    metadata: {
      resultId,
      classification: manual.classification,
      riskTheme: manual.riskTheme,
      risky,
    },
  });
  return { caseId: row.caseId };
}

/** Clears any analyst manual classification, reverting to automatic. */
export async function clearManualResultClassification(
  resultId: string,
  ctx: ActorContext = {}
): Promise<{ caseId: string }> {
  const row = await loadResultCase(resultId);
  const prev = readRiskClassification(row.rawMetadata);
  if (!prev?.manual) {
    throw new ValidationError("No manual classification to clear");
  }
  const nextRaw = mergeRiskClassification(row.rawMetadata, { manual: null });
  await prisma.searchResult.update({
    where: { id: resultId },
    data: { rawMetadata: toJson(nextRaw), reviewStatus: "PENDING" },
  });
  await recordAudit({
    caseId: row.caseId,
    action: "SEARCH_RESULT_MANUAL_CLEARED",
    actorId: ctx.actorId,
    metadata: { resultId },
  });
  return { caseId: row.caseId };
}
