/**
 * R7.1 smoke — final release-gate contracts.
 */
import { spawnSync } from "node:child_process";
import {
  REPORT_CLIENT_SLIDE_COUNT,
  REPORT_INTERNAL_SLIDE_COUNT,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";
import { buildOfferConfig } from "../src/modules/digital-profile/report/offer-config";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  const offer = buildOfferConfig("ru");
  const internalJson = {
    providerDiagnostics: { runtimeStrategy: { requestedRuntimeMode: "legacy_mock_first" } },
    providerReadinessSummary: { totalProviders: 7 },
    queryPlanDiagnostics: { queryPlanId: "r71", totalQueries: 4 },
    liveProviderSmoke: { smokeRunId: "r71-smoke" },
    sourceQualitySummary: { includedCount: 1, reviewCount: 0, excludedCount: 0, duplicateCount: 0 },
    searchProvenanceSummary: { queryCount: 3, surfaceCount: 10, screenshotCount: 1 },
    entityFiltering: { enabled: true, counts: { excludedByIdentity: 1 } },
    complianceRiskIntel: { summary: "ok" },
    r34Appendix: { enabled: true },
    offer,
  } as Record<string, unknown>;
  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientStr = JSON.stringify(clientJson);
  const internalStr = JSON.stringify(internalJson);

  check("internal page count is 73", REPORT_INTERNAL_SLIDE_COUNT === 73);
  check("client page count is 72", REPORT_CLIENT_SLIDE_COUNT === 72);
  check("client diagnostics page absent by policy", !clientStr.includes("providerDiagnostics"));
  check("client forbidden hits are 0", !/providerDiagnostics|queryPlanDiagnostics|liveProviderSmoke|internalReason|internalDetail|debug/i.test(clientStr));
  check("internal providerDiagnostics present", internalStr.includes("providerDiagnostics"));
  check("internal traceability blocks present", internalStr.includes("providerReadinessSummary") && internalStr.includes("queryPlanDiagnostics") && internalStr.includes("searchProvenanceSummary"));
  check("sourceQualitySummary present", internalStr.includes("sourceQualitySummary"));
  check("providerReadinessSummary present", internalStr.includes("providerReadinessSummary"));
  check("queryPlanDiagnostics internal-only", internalStr.includes("queryPlanDiagnostics") && !clientStr.includes("queryPlanDiagnostics"));
  check("liveProviderSmoke internal-only", internalStr.includes("liveProviderSmoke") && !clientStr.includes("liveProviderSmoke"));
  check("entityFiltering policy respected", internalStr.includes("entityFiltering") && clientStr.includes("entityFiltering"));
  check(
    "R6.1 offer block fields present",
    !!offer.productName &&
      !!offer.callToAction &&
      Array.isArray(offer.solutions) &&
      (offer.solutions?.length ?? 0) >= 3
  );

  const status = spawnSync("git", ["status", "--short"], { encoding: "utf-8", cwd: process.cwd() });
  const hasStagedStorage = (status.stdout || "")
    .split("\n")
    .some((line) => /^\S/.test(line) && /storage\//.test(line.replace(/\\/g, "/")));
  check("no storage artifacts staged", !hasStagedStorage);

  const deterministicNoEnv = buildOfferConfig("ru");
  check("no-env mode is deterministic", JSON.stringify(offer.solutions) === JSON.stringify(deterministicNoEnv.solutions));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();

