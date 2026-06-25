/**
 * Risk finding service (Stage I — Risk Classifier v1).
 *
 * Runs the deterministic classifier over stored evidence and persists results as
 * risk_findings, idempotently and review-safely:
 *  - dedup key = caseId + signalType + theme + sorted evidence ids;
 *  - a REVIEWED or DISMISSED finding is never overwritten (human decisions win);
 *  - a PENDING finding with the same key is refreshed (description/evidence);
 *  - new keys are created as PENDING.
 *
 * No LLM, no network. Manual findings (dedupHash = null) are never touched.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import type { ActorContext } from "./case-service";
import { loadCaseEvidence } from "../risk-classifier/evidence-loader";
import { classifyEvidence } from "../risk-classifier/classifier";
import {
  maxRiskLevel,
  type ClassifyRunSummary,
  type RiskClassificationResult,
  type RiskLevel,
} from "../risk-classifier/types";

export const RISK_CLASSIFIER_OWNER = "risk-classifier-v1";

function dedupHashOf(caseId: string, r: RiskClassificationResult): string {
  const ids = r.evidenceRefs
    .map((e) => e.id)
    .filter(Boolean)
    .sort()
    .join(",");
  return createHash("sha256")
    .update(`${caseId}|${r.signalType}|${r.theme}|${ids}`)
    .digest("hex");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Classifies all evidence for a case and persists findings idempotently.
 * Returns a structured run summary.
 */
export async function classifyCaseRisks(
  caseId: string,
  ctx: ActorContext = {}
): Promise<ClassifyRunSummary> {
  const evidence = await loadCaseEvidence(caseId);
  const { results, totalEvidenceScanned } = classifyEvidence(evidence);

  // Existing classifier-owned findings keyed by dedupHash.
  const existingByHash = new Map<string, { id: string; reviewStatus: string }>();
  for (const f of evidence.existingRiskFindings) {
    if (f.dedupHash) existingByHash.set(f.dedupHash, { id: f.id, reviewStatus: f.reviewStatus });
  }

  let findingsCreated = 0;
  let findingsUpdated = 0;
  let findingsSkippedReviewed = 0;
  let findingsDismissedIgnored = 0;
  const consideredLevels: RiskLevel[] = [];

  // De-duplicate results that resolve to the same key within a single run.
  const seen = new Set<string>();

  for (const r of results) {
    const dedupHash = dedupHashOf(caseId, r);
    if (seen.has(dedupHash)) continue;
    seen.add(dedupHash);

    const existing = existingByHash.get(dedupHash);
    if (existing) {
      if (existing.reviewStatus === "REVIEWED") {
        findingsSkippedReviewed++;
        consideredLevels.push(r.riskLevel);
        continue;
      }
      if (existing.reviewStatus === "DISMISSED") {
        findingsDismissedIgnored++;
        continue; // do not resurrect a dismissed finding
      }
      // PENDING — refresh content.
      await prisma.riskFinding.update({
        where: { id: existing.id },
        data: {
          category: r.theme,
          severity: r.riskLevel,
          title: r.title,
          summary: r.description,
          evidenceRefs: toJson(r.evidenceRefs),
          signalType: r.signalType,
          riskTheme: r.theme,
          confidence: r.confidence,
          rationale: r.rationale,
          demo: r.demo,
        },
      });
      findingsUpdated++;
      consideredLevels.push(r.riskLevel);
      continue;
    }

    await prisma.riskFinding.create({
      data: {
        caseId,
        category: r.theme,
        severity: r.riskLevel,
        title: r.title,
        summary: r.description,
        evidenceRefs: toJson(r.evidenceRefs),
        reviewStatus: "PENDING",
        createdBy: RISK_CLASSIFIER_OWNER,
        signalType: r.signalType,
        riskTheme: r.theme,
        confidence: r.confidence,
        rationale: r.rationale,
        demo: r.demo,
        dedupHash,
      },
    });
    findingsCreated++;
    consideredLevels.push(r.riskLevel);
  }

  const highest = maxRiskLevel(consideredLevels);
  const summary: ClassifyRunSummary = {
    totalEvidenceScanned,
    findingsCreated,
    findingsUpdated,
    findingsSkippedReviewed,
    findingsDismissedIgnored,
    highestRiskLevel: highest ?? "NONE",
  };

  await recordAudit({
    caseId,
    action: "RISK_CLASSIFY_RUN",
    actorId: ctx.actorId,
    metadata: { ...summary },
  });

  return summary;
}

export interface RiskFindingFullDTO {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  evidenceRefs: unknown[];
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  signalType: string | null;
  riskTheme: string | null;
  confidence: number | null;
  rationale: string | null;
  demo: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export async function listRiskFindings(caseId: string): Promise<RiskFindingFullDTO[]> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");

  const rows = await prisma.riskFinding.findMany({
    where: { caseId },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      category: true,
      severity: true,
      title: true,
      summary: true,
      evidenceRefs: true,
      reviewStatus: true,
      reviewedBy: true,
      reviewedAt: true,
      signalType: true,
      riskTheme: true,
      confidence: true,
      rationale: true,
      demo: true,
      createdBy: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    evidenceRefs: Array.isArray(r.evidenceRefs) ? (r.evidenceRefs as unknown[]) : [],
  }));
}
