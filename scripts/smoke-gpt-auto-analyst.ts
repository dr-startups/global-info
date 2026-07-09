/**
 * Smoke: GPT auto-analyst deterministic junk filter (no OpenAI call).
 */
import {
  deterministicAutoDecision,
  shouldUseGptAutoAnalyst,
} from "../src/modules/digital-profile/orion-golden/evidence/gpt-auto-analyst";
import type { EvidenceJudgment } from "../src/modules/digital-profile/orion-golden/evidence/evidence-judgment";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const baseJudgment = (over: Partial<EvidenceJudgment>): EvidenceJudgment =>
  ({
    evidenceId: "ev-1",
    title: "Test",
    subjectBinding: "LIKELY",
    relevance: "RELEVANT",
    sourceReliability: "REPUTABLE_MEDIA",
    contentNature: "FACT",
    riskSignal: "NO_RISK_SIGNAL",
    reviewDecision: "MANUAL_REVIEW_REQUIRED",
    recommendedAdminAction: "APPROVE_FOR_REPORT",
    clientSafeSummary: "summary",
    whyRiskyOrNot: "",
    evidenceForRisk: [],
    alternativeInterpretations: [],
    flags: [],
    adminReviewStatus: "PENDING",
    ...over,
  }) as EvidenceJudgment;

assert(
  deterministicAutoDecision(undefined, {
    evidenceId: "s-1",
    title: "deripaska autocomplete lyrics",
    snippet: "",
    proposedClassification: {} as never,
    whyAgentFlagged: "",
    riskInterpretation: "",
    neutralInterpretation: "",
    missingContext: [],
    recommendedAdminAction: "EXCLUDE",
    adminReviewStatus: "PENDING",
    flags: [],
  })?.status === "EXCLUDED",
  "noise suggestion excluded"
);

assert(
  deterministicAutoDecision(
    baseJudgment({ reviewDecision: "EXCLUDE_WRONG_SUBJECT", subjectBinding: "WRONG_SUBJECT" })
  )?.status === "WRONG_SUBJECT",
  "wrong subject"
);

assert(
  deterministicAutoDecision(baseJudgment({ reviewDecision: "EXCLUDE_NOISE", relevance: "NOISE" }))?.status ===
    "EXCLUDED",
  "noise excluded"
);

assert(
  deterministicAutoDecision(baseJudgment({ reviewDecision: "AUTO_INCLUDE_CLIENT_REPORT" }))?.status === "APPROVED",
  "auto include approved"
);

process.env.ORION_GPT_AUTO_ANALYST = "1";
assert(shouldUseGptAutoAnalyst(), "flag on");
delete process.env.ORION_GPT_AUTO_ANALYST;
assert(!shouldUseGptAutoAnalyst(), "flag off");

console.log(JSON.stringify({ ok: true, test: "gpt-auto-analyst-deterministic" }, null, 2));
