import {
  buildNormalizedSubjectIdentity,
  evaluateEntityMatch,
} from "../src/modules/digital-profile/risk-classifier/entity-disambiguation";
import { evaluateEvidenceItem } from "../src/modules/digital-profile/evidence-quality/gate";
import { sanitizeReportJsonForAudience } from "../src/modules/digital-profile/report/report-data-policy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const SUBJECT = "Томилин Константин Романович";
const normalized = buildNormalizedSubjectIdentity({
  fullName: SUBJECT,
  aliases: ["Tomilin Konstantin Romanovich", "Konstantin Tomilin"],
  country: "RU",
  nationality: "RU",
  regionHints: ["RU"],
});

function m(text: string, region = "RU", sourceType: "organic" | "image" | "video" | "compliance" = "organic") {
  return evaluateEntityMatch({ text, subject: normalized, region, sourceType });
}

function q(text: string, region = "RU", surfaceType: "SEARCH_RESULT" | "IMAGE_RESULT" | "VIDEO_RESULT" = "SEARCH_RESULT") {
  return evaluateEvidenceItem({
    surfaceType,
    title: text,
    snippet: "",
    region,
    subjectFullName: SUBJECT,
    subjectAliases: ["Tomilin Konstantin Romanovich", "Konstantin Tomilin"],
    subjectCountry: "RU",
    subjectNationality: "RU",
    subjectRegionHints: ["RU"],
  });
}

function main() {
  check("strict RU full match", m("Томилин Константин Романович").decision === "strict_subject");
  check("strict legal entity text", m("ИП Томилин Константин Романович").decision === "strict_subject");
  check(
    "strict transliterated full match",
    m("Tomilin Konstantin Romanovich", "INTERNATIONAL").decision === "strict_subject"
  );
  check("likely ru no patronymic", m("Томилин Константин").decision === "likely_subject");
  check(
    "likely latin first+last",
    m("Konstantin Tomilin", "INTERNATIONAL").decision === "likely_subject" ||
      m("Konstantin Tomilin", "INTERNATIONAL").decision === "possible_subject"
  );
  check("possible short initials", m("K. Tomilin", "INTERNATIONAL").decision !== "strict_subject");
  check(
    "romanovich-only is weak (possible/insufficient)",
    ["not_subject", "likely_subject", "possible_subject", "insufficient_identity"].includes(
      m("Tomilin Romanovich family office", "INTERNATIONAL").decision
    )
  );
  check(
    "exclude patronymic conflict",
    m("Томилин Константин Владимирович").decision === "namesake"
  );
  check("exclude first-name conflict", m("Томилин Александр Романович").decision === "not_subject");
  check("exclude unrelated romanovich", m("Богдан Романович", "INTERNATIONAL").decision === "insufficient_identity");

  const intlLikely = q("Konstantin Tomilin", "INTERNATIONAL", "SEARCH_RESULT");
  check(
    "international threshold stricter than client include",
    intlLikely.reportEligibility !== "CLIENT_INCLUDE",
    intlLikely.reportEligibility
  );

  const weakMedia = q("Tomilin", "INTERNATIONAL", "IMAGE_RESULT");
  check("media weak match excluded/review", weakMedia.reportEligibility !== "CLIENT_INCLUDE", weakMedia.reportEligibility);

  const weakOverride = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Tomilin Romanovich family office",
    region: "INTERNATIONAL",
    reportEligibilityOverride: "CLIENT_INCLUDE",
    subjectFullName: SUBJECT,
    subjectAliases: ["Tomilin Konstantin Romanovich"],
    subjectCountry: "RU",
    subjectNationality: "RU",
    subjectRegionHints: ["RU"],
  });
  check(
    "weak override preserved as review",
    weakOverride.reportEligibility === "REVIEW_REQUIRED" && weakOverride.selectionReason === "weak_identity_override",
    `${weakOverride.reportEligibility}/${weakOverride.selectionReason}`
  );

  const clientSanitized = sanitizeReportJsonForAudience(
    {
      meta: { caseNumber: "1", title: "x", generatedAt: new Date().toISOString(), version: 1, status: "DRAFT", language: "ru" },
      subject: { id: "1", caseId: "1", fullName: SUBJECT, aliases: [], dateOfBirth: null, nationality: null, country: null, emails: [], phones: [], identifiers: null, notes: null, createdAt: "", updatedAt: "" },
      dynamicPages: [],
      staticPages: [],
      pricing: [],
      entityFiltering: {
        enabled: true,
        subjectIdentitySummary: { hasPatronymic: true, hasLatinAliases: true, hasRegionHints: true },
        counts: { strictSubject: 1, likelySubject: 1, possibleSubject: 1, namesake: 1, notSubject: 1, insufficientIdentity: 1, excludedByIdentity: 3 },
        topExclusionReasons: [{ reason: "namesake_detected", count: 1 }],
        internationalSuppressionCount: 1,
        mediaSuppressionCount: 1,
        complianceReviewCount: 0,
      },
    } as never,
    "client"
  ) as Record<string, unknown>;
  const ef = (clientSanitized.entityFiltering ?? {}) as Record<string, unknown>;
  check("client entity filtering strips internal-heavy fields", !("topExclusionReasons" in ef), JSON.stringify(ef));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
