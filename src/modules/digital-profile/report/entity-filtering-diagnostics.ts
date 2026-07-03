import { parseSubjectName } from "../risk-classifier/entity-disambiguation";
import type { EvidenceQualitySummary } from "../evidence-quality/types";
import type { ReportEntityFilteringDiagnostics } from "../types";

export function buildEntityFilteringDiagnostics(input: {
  subject: {
    fullName: string;
    aliases?: string[];
    nationality?: string | null;
    country?: string | null;
  };
  evidenceQuality?: EvidenceQualitySummary;
}): ReportEntityFilteringDiagnostics {
  const parsed = parseSubjectName(input.subject.fullName ?? "");
  const aliases = input.subject.aliases ?? [];
  const eq = input.evidenceQuality;
  const identity = eq?.identity;
  const reviewQueue = eq?.reviewQueue ?? [];
  const strictSubject = identity?.exactSubject ?? 0;
  const likelySubject = identity?.likelySubject ?? 0;
  const possibleSubject = identity?.possibleSubject ?? 0;
  const namesake = identity?.namesakesExcluded ?? 0;
  const notSubject = identity?.entityMismatchesExcluded ?? 0;
  const insufficientIdentity = identity?.insufficientMatchesExcluded ?? 0;
  const excludedByIdentity = namesake + notSubject + insufficientIdentity;

  const internationalSuppressionCount = reviewQueue.filter((r) =>
    ["INTERNATIONAL", "UAE"].includes(String(r.region ?? "").toUpperCase())
  ).length;
  const mediaSuppressionCount = reviewQueue.filter((r) =>
    ["IMAGE_RESULT", "VIDEO_RESULT"].includes(String(r.surfaceType ?? ""))
  ).length;
  const complianceReviewCount = reviewQueue.filter((r) =>
    ["MANUAL_COMPLIANCE", "MANUAL_IMPORT"].includes(String(r.surfaceType ?? ""))
  ).length;

  return {
    enabled: true,
    subjectIdentitySummary: {
      hasPatronymic: Boolean(parsed.patronymic),
      hasLatinAliases: aliases.some((a) => /[a-z]/i.test(a) && !/[а-яё]/i.test(a)),
      hasRegionHints: Boolean((input.subject.nationality ?? "").trim() || (input.subject.country ?? "").trim()),
    },
    counts: {
      strictSubject,
      likelySubject,
      possibleSubject,
      namesake,
      notSubject,
      insufficientIdentity,
      excludedByIdentity,
    },
    topExclusionReasons: (eq?.topExclusionReasons ?? []).map((x) => ({
      reason: String(x.reason),
      count: Number(x.count ?? 0),
    })),
    internationalSuppressionCount,
    mediaSuppressionCount,
    complianceReviewCount,
  };
}
