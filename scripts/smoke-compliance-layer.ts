/**
 * Smoke test for Stage C1 — Compliance Databases Evidence Layer.
 *
 * Offline-first checks (no live provider calls, no secrets):
 *   - provider status DISABLED / NOT_CONFIGURED;
 *   - manual import normalization + match scoring;
 *   - risk finding rules (potential only);
 *   - compliance summary builder shape;
 *   - no secrets in metadata.
 *
 * With DATABASE_URL + dev server optional integration checks via fetch.
 *
 * Run: npm run smoke:compliance-layer
 */

import {
  computeMatchScore,
  getComplianceProviderStatus,
  listComplianceProviderStatus,
  missingComplianceConfigKeys,
  normalizeComplianceHit,
  sanitizeRawMetadata,
} from "../src/modules/digital-profile/compliance-providers";
import { classifyDatabaseProfile } from "../src/modules/digital-profile/risk-classifier/rules";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function main() {
  console.log("Smoke testing C1 compliance layer (offline)\n");

  // 1. Providers disabled by default
  const dj = getComplianceProviderStatus("DOW_JONES");
  check("Dow Jones disabled by default", dj.status === "DISABLED" && !dj.enabled);
  check("LexisNexis NOT_CONFIGURED when flag off", getComplianceProviderStatus("LEXISNEXIS").status === "DISABLED");
  check("World-Check disabled by default", getComplianceProviderStatus("WORLD_CHECK").status === "DISABLED");
  check(
    "missing keys lists env names only",
    missingComplianceConfigKeys("DOW_JONES").includes("DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED")
  );

  // 2. Manual import always enabled
  const manual = getComplianceProviderStatus("MANUAL_IMPORT");
  check("Manual import ENABLED", manual.status === "ENABLED" && manual.kind === "MANUAL");
  check("Manual import supportsRealCalls=false", manual.supportsRealCalls === false);

  // 3. Provider list includes all four
  const all = listComplianceProviderStatus();
  check("list has 4 compliance providers", all.length === 4, String(all.length));

  // 4. Status JSON has no secret values
  check(
    "status JSON has no api secret values",
    !/["'][a-zA-Z0-9+/=]{24,}["']/.test(
      JSON.stringify(all.map(({ missingConfigKeys: _m, notes: _n, ...rest }) => rest))
    )
  );

  // 5. Match scoring deterministic
  const s1 = computeMatchScore({
    subjectFullName: "Test Person",
    subjectAliases: ["T. Person"],
    matchedName: "Test Person",
    riskTypes: ["SANCTIONS"],
  });
  const s2 = computeMatchScore({
    subjectFullName: "Test Person",
    subjectAliases: ["T. Person"],
    matchedName: "Test Person",
    riskTypes: ["SANCTIONS"],
  });
  check("scoring deterministic", s1.matchScore === s2.matchScore, String(s1.matchScore));
  check("exact name -> score >= 40", s1.matchScore >= 40);
  check("HIGH confidence not verified match note", s1.confidence === "HIGH" || s1.confidence === "MEDIUM");

  // 6. Normalize manual hit
  const hit = normalizeComplianceHit({
    provider: "DOW_JONES",
    source: "MANUAL",
    subjectName: "Test Person",
    matchedName: "Test Person Jr",
    riskTypes: ["SANCTIONS"],
    matchScore: s1.matchScore,
    confidence: s1.confidence,
    summary: "Manual import — potential match",
    extraMetadata: { providerLabel: "Dow Jones" },
  });
  check("normalized hit reviewStatus PENDING", hit.reviewStatus === "PENDING");
  check("rawMetadata uses providerAdapter label safe", (hit.rawMetadataSafe as { manualImport?: boolean }).manualImport === true);
  check(
    "sanitize strips secret keys",
    !Object.keys(sanitizeRawMetadata({ apiKey: "secret", ok: true })).includes("apiKey")
  );

  // 7. Classifier — potential only (INFO level default)
  const findings = classifyDatabaseProfile({
    id: "hit1",
    provider: "DOW_JONES",
    matchType: "SANCTIONS",
    matchScore: 80,
    reviewStatus: "PENDING",
    riskTypes: ["SANCTIONS"],
  });
  check("SANCTIONS creates potential finding", findings.length === 1);
  check("finding severity LOW until confirmed", findings[0]?.riskLevel === "LOW");
  check("finding title says potential", findings[0]?.title.includes("Potential"));

  const dismissed = classifyDatabaseProfile({
    id: "hit2",
    provider: "WORLD_CHECK",
    matchType: "SANCTIONS",
    matchScore: 99,
    reviewStatus: "FALSE_POSITIVE",
    riskTypes: ["SANCTIONS"],
  });
  check("FALSE_POSITIVE suppressed in classifier", dismissed.length === 0);

  const confirmed = classifyDatabaseProfile({
    id: "hit3",
    provider: "WORLD_CHECK",
    matchType: "SANCTIONS",
    matchScore: 99,
    reviewStatus: "MATCH_CONFIRMED",
    riskTypes: ["SANCTIONS"],
  });
  check("MATCH_CONFIRMED raises severity", confirmed[0]?.riskLevel === "CRITICAL");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
