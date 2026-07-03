/**
 * R4.2 — source quality / dedup / inclusion reasoning smoke test.
 * Fixture-only, deterministic, no network/API calls.
 */
import { annotateSourceQuality, summarizeSourceQuality } from "../src/modules/digital-profile/evidence-quality/source-quality";
import type { GatedEvidenceItem } from "../src/modules/digital-profile/evidence-quality/types";
import { sanitizeReportJsonForAudience, findClientReportPolicyViolations } from "../src/modules/digital-profile/report/report-data-policy";
import { buildProviderDiagnostics } from "../src/modules/digital-profile/report/provider-diagnostics";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function mk(
  overrides: Omit<Partial<GatedEvidenceItem>, "quality"> & {
    quality?: Partial<GatedEvidenceItem["quality"]>;
  }
): GatedEvidenceItem {
  return {
    id: overrides.id ?? "x",
    surfaceType: overrides.surfaceType ?? "SEARCH_RESULT",
    title: overrides.title ?? "Томилин Константин Романович — профиль",
    snippet: overrides.snippet ?? "subject profile",
    url: overrides.url ?? "https://example.org/a",
    domain: overrides.domain ?? "example.org",
    region: overrides.region ?? "RU",
    source: overrides.source ?? "real:google",
    rawMetadata: {},
    quality: {
      identityConfidence: "HIGH",
      riskConfidence: "LOW",
      contentClass: "BIOGRAPHY",
      reportEligibility: "CLIENT_INCLUDE",
      selectionReason: "exact_subject_match",
      isAdverseForReport: false,
      isUsefulProfileMaterial: true,
      duplicateOf: null,
      identityDecision: "EXACT_SUBJECT",
      ...overrides.quality,
    },
  };
}

function main() {
  const rows: GatedEvidenceItem[] = [
    mk({ id: "1", url: "https://site.tld/u/1", domain: "site.tld", title: "Tomilin Konstantin Romanovich" }),
    mk({ id: "2", url: "https://site.tld/u/1?utm=x", domain: "site.tld", title: "Tomilin Konstantin Romanovich" }),
    mk({
      id: "3",
      url: "https://news.tld/profile",
      domain: "news.tld",
      title: "Tomilin Konstantin Romanovich biography",
      quality: { identityDecision: "LIKELY_SUBJECT", identityConfidence: "MEDIUM" },
    }),
    mk({
      id: "4",
      url: "https://news.tld/profile-2",
      domain: "news.tld",
      title: "Tomilin Konstantin Romanovich — biography",
      quality: { identityDecision: "LIKELY_SUBJECT", identityConfidence: "MEDIUM" },
    }),
    mk({
      id: "5",
      url: "https://bad.tld/other",
      domain: "bad.tld",
      title: "Томилин Александр Романович",
      quality: {
        identityDecision: "ENTITY_MISMATCH",
        reportEligibility: "EXCLUDE",
        selectionReason: "entity_mismatch",
      },
    }),
    mk({
      id: "6",
      surfaceType: "MANUAL_IMPORT",
      source: "manual:import",
      url: "https://manual.local/row/6",
      domain: "manual.local",
      title: "Manual compliance row",
      quality: { reportEligibility: "REVIEW_REQUIRED", selectionReason: "manual_review_required" },
    }),
  ];

  const annotated = annotateSourceQuality(rows, "ru");
  const sq = annotated.map((r) => r.quality.sourceQuality);

  check(
    "exact duplicate URLs are grouped",
    Boolean(sq[0]?.duplicateGroupId) && sq[1]?.duplicateGroupId === sq[0]?.duplicateGroupId
  );
  check("duplicate secondary row is marked duplicate decision", sq[1]?.sourceQualityDecision === "duplicate");
  check(
    "same domain + similar title grouped conservatively",
    Boolean(sq[2]?.duplicateGroupId) && sq[3]?.duplicateGroupId === sq[2]?.duplicateGroupId
  );
  check(
    "weak/wrong identity remains excluded or review",
    sq[4]?.sourceQualityDecision === "exclude" || sq[4]?.sourceQualityDecision === "review"
  );
  check(
    "manual import keeps review semantics",
    sq[5]?.sourceQualityReason === "compliance_manual_import" &&
      sq[5]?.sourceQualityDecision === "review"
  );

  const summary = summarizeSourceQuality(annotated);
  check("summary counts deterministic", summary.totalCollected === 6 && summary.uniqueSources >= 3);
  check("summary duplicate count > 0", summary.duplicateCount > 0);

  const report = {
    sourceQualitySummary: summary,
    searchSurfaces: {
      regions: {
        ru: { organic: { items: annotated.map((r) => ({ title: r.title, ...(r.quality.sourceQuality ?? {}) })) } },
      },
    },
    providerDiagnostics: buildProviderDiagnostics({
      surfaceTotals: { organicCollected: 6, organicIncluded: 3, organicDuplicates: summary.duplicateCount },
    }),
  } as Record<string, unknown>;
  check("provider provenance from R4.1 remains present", Boolean((report.providerDiagnostics as any)?.sourceProvenance));

  const client = sanitizeReportJsonForAudience(report, "client");
  const json = JSON.stringify(client);
  check(
    "client JSON strips internal source-quality fields",
    !json.includes("sourceQualityReason") &&
      !json.includes("internalReason") &&
      !json.includes("sourceFingerprint") &&
      !json.includes("duplicateGroupId")
  );
  check("client JSON keeps safe source-quality summary", json.includes("sourceQualitySummary"));

  const violations = findClientReportPolicyViolations(json);
  check("R3.6 policy still passes", violations.length === 0, violations.join(", "));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
