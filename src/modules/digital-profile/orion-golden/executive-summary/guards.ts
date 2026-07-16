/**
 * EXECUTIVE_SUMMARY stage — output guards.
 * Every violation is a hard stage failure: the summary is client-facing and
 * must never leak internal terms, other-subject claims or unsupported theses.
 */

import type { Finding } from "../contracts/finding";
import type {
  ExecutiveSummaryStageInput,
  ExecutiveSummaryStageOutput,
} from "./stage-contracts";

export type GuardViolation = {
  guard: string;
  message: string;
};

const FORBIDDEN_OPENINGS = [/^\s*мы провели поиск/iu, /^\s*мы выполнили поиск/iu];

/** Internal pipeline vocabulary that must never appear in client-facing text. */
const INTERNAL_TERM_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "reportRunId", re: /report\s*run\s*id|reportrunid/iu },
  { label: "pipeline", re: /pipeline|пайплайн/iu },
  { label: "API", re: /\bAPI\b/u },
  { label: "datasetId", re: /dataset\s*id|datasetid/iu },
  { label: "serp_observation", re: /serp[_\s-]?observation/iu },
  { label: "provider task", re: /provider\s*task/iu },
  { label: "arsenkin", re: /arsenkin|арсенкин/iu },
  { label: "enrichment run", re: /enrichment\s*run/iu },
  { label: "composite dataset", re: /composite\s*dataset/iu },
];

function collectClientText(output: ExecutiveSummaryStageOutput): string[] {
  return [
    output.executiveConclusion,
    ...output.keyFindings.flatMap((f) => [
      f.title,
      f.factualBasis,
      f.clientImpact,
      f.recommendedAction,
    ]),
    ...output.regionalOverview.map((r) => r.oneLiner),
    ...output.identityCaveats,
    ...output.dataLimitations,
    ...output.priorityActions,
    output.methodologyNote,
  ];
}

export function runExecutiveSummaryGuards(
  input: ExecutiveSummaryStageInput,
  output: ExecutiveSummaryStageOutput
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  const findingById = new Map<string, Finding>();
  for (const f of input.verifiedFindings.findings) findingById.set(f.findingId, f);
  const excluded = new Set(input.verifiedFindings.excludedFindingIds);

  // 1. Every key finding must reference an existing, non-excluded verified finding.
  for (const kf of output.keyFindings) {
    const src = findingById.get(kf.findingId);
    if (!src) {
      violations.push({
        guard: "CLAIM_WITHOUT_FINDING_ID",
        message: `keyFinding "${kf.title}" references unknown findingId=${kf.findingId}`,
      });
      continue;
    }
    if (excluded.has(kf.findingId)) {
      violations.push({
        guard: "EXCLUDED_FINDING_IN_SUMMARY",
        message: `findingId=${kf.findingId} is excluded from the bundle but appears in summary`,
      });
    }
    // 2. OTHER_SUBJECT / non-subject findings must never become claims about the subject.
    if (src.subjectMatch !== "SUBJECT_MATCH") {
      violations.push({
        guard: "NON_SUBJECT_CLAIM",
        message: `findingId=${kf.findingId} has subjectMatch=${src.subjectMatch}; only SUBJECT_MATCH may enter keyFindings`,
      });
    }
    // 3. A preliminary signal must not be presented as a confirmed fact.
    if (kf.basisKind === "CONFIRMED_FACT" && src.confidence < 0.75) {
      violations.push({
        guard: "SIGNAL_PRESENTED_AS_FACT",
        message: `findingId=${kf.findingId} confidence=${src.confidence} presented as CONFIRMED_FACT`,
      });
    }
  }

  // 4. Forbidden opening phrases.
  for (const re of FORBIDDEN_OPENINGS) {
    if (re.test(output.executiveConclusion)) {
      violations.push({
        guard: "FORBIDDEN_OPENING",
        message: "executiveConclusion starts with a search-process narrative",
      });
    }
  }

  // 5. Internal technical vocabulary anywhere in client text.
  for (const text of collectClientText(output)) {
    for (const { label, re } of INTERNAL_TERM_PATTERNS) {
      if (re.test(text)) {
        violations.push({
          guard: "INTERNAL_TERM_LEAK",
          message: `internal term "${label}" leaked into client text: "${text.slice(0, 80)}"`,
        });
      }
    }
  }

  // 6. Identity pollution must be surfaced when it exists in the input.
  if (
    output.verdict !== "INSUFFICIENT_DATA" &&
    input.identityPollution.otherSubjectCount > 0 &&
    output.identityCaveats.length === 0
  ) {
    violations.push({
      guard: "IDENTITY_POLLUTION_HIDDEN",
      message: `input has otherSubjectCount=${input.identityPollution.otherSubjectCount} but identityCaveats is empty`,
    });
  }

  // 7. Data gaps must not be hidden.
  if (
    output.verdict !== "INSUFFICIENT_DATA" &&
    input.dataGaps.length > 0 &&
    output.dataLimitations.length === 0
  ) {
    violations.push({
      guard: "DATA_GAPS_HIDDEN",
      message: `input has ${input.dataGaps.length} data gaps but dataLimitations is empty`,
    });
  }

  return violations;
}
