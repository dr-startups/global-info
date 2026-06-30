/**
 * Smoke test — Stage O5.3 Strict Identity + Autocomplete Exposure + Image Thumbnails.
 *
 * Run: npm run smoke:strict-identity-and-images-o53
 */

import { evaluateEvidenceItem } from "../src/modules/digital-profile/evidence-quality/gate";
import { classifyAutocompleteQuery } from "../src/modules/digital-profile/evidence-quality/autocomplete-class";
import {
  buildSubjectFingerprint,
  evaluateIdentityDecision,
} from "../src/modules/digital-profile/evidence-quality/subject-fingerprint";
import { buildEvidenceQualitySummary } from "../src/modules/digital-profile/evidence-quality/build-summary";
import { sanitizeReportJsonForAudience } from "../src/modules/digital-profile/report/report-data-policy";
import { resolveHighlight } from "../src/modules/digital-profile/serp-snapshot/highlight-resolver";

const SUBJECT = "Томилин Константин Романович";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function main() {
  console.log("Smoke testing O5.3 Strict Identity + Images\n");

  const fp = buildSubjectFingerprint({ fullName: SUBJECT });

  // 1. Exact full FIO registry + INN
  const registry = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "ИП Томилин Константин Романович ИНН 691304415796",
    snippet: "реестр ИП",
    subjectFullName: SUBJECT,
    classification: "CORPORATE_REGISTRY",
  });
  check("1 registry EXACT_SUBJECT", registry.identityDecision === "EXACT_SUBJECT");
  check("1 registry not adverse", !registry.isAdverseForReport);
  check("1 registry include", registry.reportEligibility === "CLIENT_INCLUDE");

  // 2. Different patronymic
  const vlad = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Константин Владимирович",
    subjectFullName: SUBJECT,
    classification: "NAMESAKE",
  });
  check("2 different patronymic NAMESAKE", vlad.identityDecision === "NAMESAKE");
  check("2 different patronymic EXCLUDE", vlad.reportEligibility === "EXCLUDE");

  // 3. Different first name same patronymic
  const bogdan = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Богдан Романович",
    subjectFullName: SUBJECT,
  });
  check("3 Bogdan ENTITY_MISMATCH", bogdan.identityDecision === "ENTITY_MISMATCH");
  check("3 Bogdan EXCLUDE", bogdan.reportEligibility === "EXCLUDE");

  // 4. Scientist namesake
  const scientist = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Томилин Константин Александрович",
    snippet: "ученый",
    subjectFullName: SUBJECT,
    classification: "NAMESAKE",
  });
  check("4 scientist NAMESAKE", scientist.identityDecision === "NAMESAKE");
  check("4 scientist EXCLUDE", scientist.reportEligibility === "EXCLUDE");

  // 5. International Romanovich-only
  const romanovichOnly = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Anatoli Romanovich",
    snippet: "biography",
    subjectFullName: SUBJECT,
  });
  check(
    "5 Romanovich-only INSUFFICIENT/ENTITY",
    romanovichOnly.identityDecision === "INSUFFICIENT_MATCH" ||
      romanovichOnly.identityDecision === "ENTITY_MISMATCH"
  );
  check("5 Romanovich-only EXCLUDE", romanovichOnly.reportEligibility === "EXCLUDE");

  // 5b. Search query must not anchor unrelated organic hit
  const queryPollution = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title: "Prince Nicholas Romanov - Wikipedia",
    snippet: "biography",
    query: "Tomilin Konstantin Romanovich",
    subjectFullName: SUBJECT,
  });
  check("5b query pollution EXCLUDE", queryPollution.reportEligibility === "EXCLUDE");
  check("5b query pollution not exact", queryPollution.identityDecision !== "EXACT_SUBJECT");

  // 6. Suggestion different patronymic — autocomplete exposure
  const sugPat = evaluateEvidenceItem({
    surfaceType: "SEARCH_SUGGESTION",
    title: "томилин константин александрович",
    subjectFullName: SUBJECT,
  });
  check(
    "6 suggestion adjacent class",
    sugPat.autocompleteClass === "ADJACENT_PERSON_QUERY" ||
      sugPat.autocompleteClass === "NAMESAKE_QUERY"
  );
  check("6 suggestion not subject evidence", !sugPat.isSubjectEvidence);
  check("6 suggestion not adverse", !sugPat.isAdverseForReport);
  check("6 suggestion kept for exposure", sugPat.reportEligibility !== "EXCLUDE");

  // 7. Suggestion typo
  const typo = evaluateEvidenceItem({
    surfaceType: "SEARCH_SUGGESTION",
    title: "константин томин",
    subjectFullName: SUBJECT,
  });
  check("7 typo TYPO_OR_SIMILAR", typo.autocompleteClass === "TYPO_OR_SIMILAR_QUERY");
  check("7 typo not evidence", !typo.isSubjectEvidence);

  // 8. Romanovich-only related query
  const funeral = evaluateEvidenceItem({
    surfaceType: "RELATED_QUERY",
    title: "romanovich tomlinson funeral home",
    subjectFullName: SUBJECT,
  });
  check("8 funeral not subject evidence", !funeral.isSubjectEvidence);
  check("8 funeral not adverse", !funeral.isAdverseForReport);

  // 9. Unrelated image
  const badImg = evaluateEvidenceItem({
    surfaceType: "IMAGE_RESULT",
    title: "Томилин Игорь Евгеньевич — отделение",
    snippet: "медицинское отделение",
    subjectFullName: SUBJECT,
  });
  check("9 unrelated image EXCLUDE", badImg.reportEligibility === "EXCLUDE");

  // 10. Exact subject image
  const goodImg = evaluateEvidenceItem({
    surfaceType: "IMAGE_RESULT",
    title: "Томилин Константин Романович",
    snippet: "фото",
    subjectFullName: SUBJECT,
    rawMetadata: {
      evidenceQuality: {
        thumbnailStorageKey: "cases/demo/image-thumbnails/abc.jpg",
        thumbnailStatus: "AVAILABLE",
      },
    },
  });
  check("10 exact image subject matched", goodImg.isSubjectEvidence === true);
  check("10 exact image include", goodImg.reportEligibility === "CLIENT_INCLUDE");
  check("10 thumbnail key readable", goodImg.thumbnailStatus === "AVAILABLE");

  // 11. Thumbnail fetch failure — gate still works
  const failThumb = evaluateEvidenceItem({
    surfaceType: "IMAGE_RESULT",
    title: "Томилин Константин Романович",
    subjectFullName: SUBJECT,
    rawMetadata: { evidenceQuality: { thumbnailStatus: "FAILED" } },
  });
  check("11 failed thumb still gates", failThumb.reportEligibility === "CLIENT_INCLUDE");

  // 12. Unrelated social video
  const socialVid = evaluateEvidenceItem({
    surfaceType: "VIDEO_RESULT",
    title: "Random TikTok dance",
    url: "https://tiktok.com/@x/video/1",
    subjectFullName: SUBJECT,
  });
  check("12 social video EXCLUDE", socialVid.reportEligibility === "EXCLUDE");

  // 13. Stale PEP without manual — highlight resolver (weak auto does not highlight)
  const pepHighlight = resolveHighlight({
    enumClassification: "PEP",
    riskClassification: null,
    findings: [],
    sourceIsMock: true,
  });
  check("13 stale PEP enum mock only", !pepHighlight.isHighlighted || pepHighlight.source === "enum");

  // 14. Identity decision helper for snapshot filter
  const snapId = evaluateIdentityDecision("Томилин Константин Владимирович суд", fp);
  check("14 snapshot namesake filtered", snapId.decision === "NAMESAKE");

  // 15. Client JSON hygiene
  const clientJson = sanitizeReportJsonForAudience(
    {
      meta: { reportWarnings: [] },
      evidenceQuality: {
        totals: { collected: 1 },
        identity: { exactSubject: 2 },
        autocompleteExposure: { total: 3 },
        imageEvidence: { collected: 1 },
      },
      searchSurfaces: {
        regions: {
          ru: {
            organic: {
              items: [{ sourceMode: "REAL", rawMetadata: { x: 1 }, reportEligibility: "CLIENT_INCLUDE" }],
            },
          },
        },
      },
    },
    "client"
  );
  check("15 client JSON strips debug", !JSON.stringify(clientJson).includes("sourceMode"));
  check("15 client JSON keeps totals", Boolean((clientJson.evidenceQuality as { totals?: unknown })?.totals));

  // Metrics block
  const summary = buildEvidenceQualitySummary(
    [
      {
        surfaceType: "SEARCH_RESULT",
        title: "Томилин Константин Романович",
        subjectFullName: SUBJECT,
      },
      {
        surfaceType: "SEARCH_SUGGESTION",
        title: "томилин константин александрович",
        subjectFullName: SUBJECT,
      },
      {
        surfaceType: "IMAGE_RESULT",
        title: "Томилин Константин Романович photo",
        subjectFullName: SUBJECT,
      },
    ],
    SUBJECT
  );
  check("metrics identity block", Boolean(summary.identity?.collectedTotal));
  check("metrics autocomplete block", Boolean(summary.autocompleteExposure?.total));
  check("metrics image block", Boolean(summary.imageEvidence?.collected));

  // Autocomplete classifier unit
  check(
    "autocomplete exact",
    classifyAutocompleteQuery("Томилин Константин Романович", SUBJECT) === "EXACT_SUBJECT_QUERY"
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
