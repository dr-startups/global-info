/**
 * R10.11 — GPT auto-analyst: deterministic junk filter + batch GPT reviewer.
 * Replaces manual gate when ORION_GPT_AUTO_ANALYST=1.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { digitalProfileConfig } from "../../config";
import { callOpenAiStrictJson } from "../gpt/openai-json-client";
import type { AdminReviewDecision, AdminReviewDecisionSet, AdminReviewStatus } from "./admin-review-decision";
import { countAdminDecisionsByStatus } from "./admin-review-decision";
import {
  loadAdminReviewDecisions,
  saveAdminReviewDecisions,
} from "./admin-review-decision-store";
import type { EvidenceJudgment } from "./evidence-judgment";
import type { ManualReviewQueue, ManualReviewQueueItem } from "./manual-review-queue";

const BATCH_SIZE = 25;

const AUTO_ANALYST_SYSTEM_PROMPT = `You are ORION compliance analyst reviewing evidence items for a client digital profile audit.

For each item decide whether it may enter the MAIN client report.

Rules:
- NEVER approve wrong-subject or obvious noise (marketplace listings, login pages, unrelated autocomplete junk).
- APPROVED only when subject binding is strong and the material is clearly about the named subject with client-safe factual value.
- APPROVED_WITH_CAVEAT when potentially relevant but allegation/rumor/compliance-sensitive — add short caveatText.
- APPENDIX_ONLY when weak binding, ambiguous role, or useful context but not a key finding.
- EXCLUDED for noise, duplicates, technical pages, irrelevant suggestions.
- WRONG_SUBJECT when likely a different person with the same name.
- NEEDS_MORE_SOURCES only when identity cannot be assessed at all.
- When uncertain, prefer APPENDIX_ONLY or EXCLUDED over APPROVED.
- Do not invent facts; judge only the provided fields.

Return JSON: { "decisions": [ { "evidenceId", "status", "rationale", "caveatText?" } ] }`;

const batchDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      evidenceId: z.string(),
      status: z.enum([
        "APPROVED",
        "APPROVED_WITH_CAVEAT",
        "APPENDIX_ONLY",
        "EXCLUDED",
        "WRONG_SUBJECT",
        "NEEDS_MORE_SOURCES",
      ]),
      rationale: z.string(),
      caveatText: z.string().optional(),
    })
  ),
});

export type GptAutoAnalystReport = {
  version: "r10-11-gpt-auto-analyst-v1";
  caseId: string;
  generatedAt: string;
  mode: "deterministic_only" | "deterministic_plus_gpt";
  subjectName: string;
  totalQueueItems: number;
  deterministicResolved: number;
  gptResolved: number;
  stillPending: number;
  statusCounts: Record<AdminReviewStatus, number>;
  samples: Array<{ evidenceId: string; status: AdminReviewStatus; source: string; rationale: string }>;
};

export function shouldUseGptAutoAnalyst(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORION_GPT_AUTO_ANALYST === "1" || digitalProfileConfig.orionGptAutoAnalyst;
}

function isSuggestionNoise(text: string): boolean {
  const q = text.toLowerCase();
  return (
    /autocomplete lyrics|image gallery|images free|profile linkedin|profile facebook|video live|videos youtube|news today|news article|related queries pdf|uaeraine|uaeu\b|russkov|russo\b/.test(
      q
    ) ||
    /^(deripaska|oleg)\s+(oleg\s+)?(vladimirovich\s+)?(related|image|video|news|profile|interview\s+\d{4})/i.test(
      text
    )
  );
}

function judgmentById(judgments: EvidenceJudgment[]): Map<string, EvidenceJudgment> {
  return new Map(judgments.map((j) => [j.evidenceId, j]));
}

export function deterministicAutoDecision(
  judgment: EvidenceJudgment | undefined,
  item?: ManualReviewQueueItem
): AdminReviewDecision | null {
  const text = `${item?.title ?? judgment?.title ?? ""} ${item?.snippet ?? ""} ${item?.url ?? judgment?.url ?? ""}`;
  if (isSuggestionNoise(text)) {
    return {
      evidenceId: item?.evidenceId ?? judgment!.evidenceId,
      status: "EXCLUDED",
      reviewerNote: "auto: suggestion/autocomplete noise",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: new Date().toISOString(),
    };
  }

  if (!judgment) return null;

  if (
    judgment.reviewDecision === "EXCLUDE_NOISE" ||
    judgment.reviewDecision === "EXCLUDE_WRONG_SUBJECT" ||
    judgment.relevance === "NOISE" ||
    judgment.contentNature === "ADVERTISEMENT" ||
    judgment.contentNature === "TECHNICAL_PAGE" ||
    judgment.contentNature === "DUPLICATE"
  ) {
    return {
      evidenceId: judgment.evidenceId,
      status: judgment.reviewDecision === "EXCLUDE_WRONG_SUBJECT" ? "WRONG_SUBJECT" : "EXCLUDED",
      reviewerNote: "auto: deterministic noise/wrong-subject routing",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: new Date().toISOString(),
    };
  }

  if (judgment.subjectBinding === "WRONG_SUBJECT") {
    return {
      evidenceId: judgment.evidenceId,
      status: "WRONG_SUBJECT",
      reviewerNote: "auto: wrong subject binding",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: new Date().toISOString(),
    };
  }

  if (judgment.reviewDecision === "APPENDIX_ONLY") {
    return {
      evidenceId: judgment.evidenceId,
      status: "APPENDIX_ONLY",
      reviewerNote: "auto: appendix-only routing",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: new Date().toISOString(),
    };
  }

  if (judgment.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT") {
    return {
      evidenceId: judgment.evidenceId,
      status: "APPROVED",
      approvedClientSummary: judgment.clientSafeSummary,
      reviewerNote: "auto: deterministic auto-include",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: new Date().toISOString(),
    };
  }

  return null;
}

function heuristicManualDecision(judgment: EvidenceJudgment): AdminReviewDecision {
  const now = new Date().toISOString();
  switch (judgment.recommendedAdminAction) {
    case "MARK_WRONG_SUBJECT":
      return {
        evidenceId: judgment.evidenceId,
        status: "WRONG_SUBJECT",
        reviewerNote: "auto-heuristic: wrong subject",
        reviewedBy: "gpt_auto_analyst",
        reviewedAt: now,
      };
    case "EXCLUDE":
      return {
        evidenceId: judgment.evidenceId,
        status: "EXCLUDED",
        reviewerNote: "auto-heuristic: exclude",
        reviewedBy: "gpt_auto_analyst",
        reviewedAt: now,
      };
    case "KEEP_APPENDIX_ONLY":
      return {
        evidenceId: judgment.evidenceId,
        status: "APPENDIX_ONLY",
        reviewerNote: "auto-heuristic: appendix",
        reviewedBy: "gpt_auto_analyst",
        reviewedAt: now,
      };
    case "APPROVE_AS_CAVEATED":
      return {
        evidenceId: judgment.evidenceId,
        status: "APPROVED_WITH_CAVEAT",
        caveatText: "Требует подтверждения первоисточника",
        approvedClientSummary: judgment.clientSafeSummary,
        reviewerNote: "auto-heuristic: caveated approve",
        reviewedBy: "gpt_auto_analyst",
        reviewedAt: now,
      };
    case "REQUEST_MORE_SOURCES":
      return {
        evidenceId: judgment.evidenceId,
        status: "NEEDS_MORE_SOURCES",
        reviewerNote: "auto-heuristic: needs sources",
        reviewedBy: "gpt_auto_analyst",
        reviewedAt: now,
      };
    case "APPROVE_FOR_REPORT":
      if (judgment.subjectBinding === "CONFIRMED" || judgment.subjectBinding === "LIKELY") {
        return {
          evidenceId: judgment.evidenceId,
          status: "APPROVED",
          approvedClientSummary: judgment.clientSafeSummary,
          reviewerNote: "auto-heuristic: approved",
          reviewedBy: "gpt_auto_analyst",
          reviewedAt: now,
        };
      }
      break;
    default:
      break;
  }

  if (judgment.subjectBinding === "WEAK" || judgment.subjectBinding === "UNKNOWN") {
    return {
      evidenceId: judgment.evidenceId,
      status: "APPENDIX_ONLY",
      reviewerNote: "auto-heuristic: weak binding",
      reviewedBy: "gpt_auto_analyst",
      reviewedAt: now,
    };
  }

  return {
    evidenceId: judgment.evidenceId,
    status: "APPENDIX_ONLY",
    reviewerNote: "auto-heuristic: conservative default",
    reviewedBy: "gpt_auto_analyst",
    reviewedAt: now,
  };
}

async function gptBatchDecisions(input: {
  subjectName: string;
  subjectAliases: string[];
  items: ManualReviewQueueItem[];
  judgments: Map<string, EvidenceJudgment>;
}): Promise<AdminReviewDecision[]> {
  const payload = {
    subject: { fullName: input.subjectName, aliases: input.subjectAliases },
    items: input.items.map((item) => {
      const j = input.judgments.get(item.evidenceId);
      return {
        evidenceId: item.evidenceId,
        title: item.title,
        url: item.url,
        snippet: item.snippet.slice(0, 400),
        subjectBinding: j?.subjectBinding ?? item.proposedClassification.subjectBinding,
        riskSignal: j?.riskSignal ?? item.proposedClassification.riskSignal,
        contentNature: j?.contentNature ?? item.proposedClassification.contentNature,
        whyFlagged: item.whyAgentFlagged,
        recommendedAction: j?.recommendedAdminAction ?? item.recommendedAdminAction,
      };
    }),
  };

  const raw = await callOpenAiStrictJson({
    systemPrompt: AUTO_ANALYST_SYSTEM_PROMPT,
    userPayload: payload,
    maxRetries: 2,
  });
  const parsed = batchDecisionSchema.parse(raw);
  const now = new Date().toISOString();
  return parsed.decisions.map((d) => ({
    evidenceId: d.evidenceId,
    status: d.status,
    reviewerNote: d.rationale.slice(0, 500),
    caveatText: d.caveatText,
    reviewedBy: "gpt_auto_analyst",
    reviewedAt: now,
  }));
}

function mergeDecisionSet(
  caseId: string,
  base: AdminReviewDecisionSet,
  resolved: AdminReviewDecision[]
): AdminReviewDecisionSet {
  const byId = new Map(base.decisions.map((d) => [d.evidenceId, d]));
  for (const d of resolved) {
    byId.set(d.evidenceId, d);
  }
  return {
    version: "r10-5-admin-review-decisions-v1",
    caseId,
    generatedAt: base.generatedAt,
    updatedAt: new Date().toISOString(),
    qaSampleOnly: false,
    decisions: [...byId.values()],
  };
}

export async function runGptAutoAnalystDecisions(input: {
  caseId: string;
  judgments: EvidenceJudgment[];
  manualQueue: ManualReviewQueue;
  subject: { fullName: string; aliases: string[] };
  existingDecisionSet?: AdminReviewDecisionSet;
}): Promise<{ decisionSet: AdminReviewDecisionSet; report: GptAutoAnalystReport }> {
  const jMap = judgmentById(input.judgments);
  const base =
    input.existingDecisionSet ??
    loadAdminReviewDecisions(input.caseId) ?? {
      version: "r10-5-admin-review-decisions-v1" as const,
      caseId: input.caseId,
      generatedAt: new Date().toISOString(),
      decisions: input.manualQueue.items.map((i) => ({ evidenceId: i.evidenceId, status: "PENDING" as const })),
    };

  const resolved: AdminReviewDecision[] = [];
  const samples: GptAutoAnalystReport["samples"] = [];
  let deterministicCount = 0;
  let gptCount = 0;

  const pendingItems = input.manualQueue.items.filter((item) => {
    const existing = base.decisions.find((d) => d.evidenceId === item.evidenceId);
    return !existing || existing.status === "PENDING";
  });

  const needsGpt: ManualReviewQueueItem[] = [];

  for (const item of pendingItems) {
    const j = jMap.get(item.evidenceId);
    const det = deterministicAutoDecision(j, item);
    if (det) {
      resolved.push(det);
      deterministicCount += 1;
      if (samples.length < 12) {
        samples.push({
          evidenceId: det.evidenceId,
          status: det.status,
          source: "deterministic",
          rationale: det.reviewerNote ?? "",
        });
      }
    } else {
      needsGpt.push(item);
    }
  }

  let mode: GptAutoAnalystReport["mode"] = "deterministic_only";

  for (let i = 0; i < needsGpt.length; i += BATCH_SIZE) {
    const batch = needsGpt.slice(i, i + BATCH_SIZE);
    try {
      const batchDecisions = await gptBatchDecisions({
        subjectName: input.subject.fullName,
        subjectAliases: input.subject.aliases,
        items: batch,
        judgments: jMap,
      });
      mode = "deterministic_plus_gpt";
      for (const d of batchDecisions) {
        resolved.push(d);
        gptCount += 1;
        if (samples.length < 20) {
          samples.push({
            evidenceId: d.evidenceId,
            status: d.status,
            source: "gpt",
            rationale: d.reviewerNote ?? "",
          });
        }
      }
    } catch {
      for (const item of batch) {
        const j = jMap.get(item.evidenceId);
        if (!j) continue;
        const h = heuristicManualDecision(j);
        resolved.push(h);
        deterministicCount += 1;
        if (samples.length < 20) {
          samples.push({
            evidenceId: h.evidenceId,
            status: h.status,
            source: "heuristic_fallback",
            rationale: h.reviewerNote ?? "",
          });
        }
      }
    }
  }

  const decisionSet = mergeDecisionSet(input.caseId, base, resolved);
  saveAdminReviewDecisions(input.caseId, decisionSet);

  const statusCounts = countAdminDecisionsByStatus(decisionSet.decisions);
  const report: GptAutoAnalystReport = {
    version: "r10-11-gpt-auto-analyst-v1",
    caseId: input.caseId,
    generatedAt: new Date().toISOString(),
    mode,
    subjectName: input.subject.fullName,
    totalQueueItems: input.manualQueue.items.length,
    deterministicResolved: deterministicCount,
    gptResolved: gptCount,
    stillPending: statusCounts.PENDING ?? 0,
    statusCounts,
    samples,
  };

  return { decisionSet, report };
}

export function readGptAutoAnalystReport(artifactRoot: string): GptAutoAnalystReport | null {
  const path = join(artifactRoot, "gpt-auto-analyst-decisions.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as GptAutoAnalystReport;
}
