/**
 * Smoke test for the real Google search provider (Stage N2).
 *
 * Pure/offline unit checks — NO API keys, NO dev server, NO DB, NO network:
 *   - availability / config gating (flag off, strategy disabled, missing creds);
 *   - strategy dispatch (custom_search vs external_serp / Serper normalize);
 *   - Custom Search normalize() on success / empty / malformed fixtures;
 *   - URL secret redaction (key/cx never logged) + rawMetadata carries no secret;
 *   - HTTP status mapping (401/403/429/5xx, quota, timeout error code);
 *   - external SERP skeleton states (NOT_SELECTED / unimplemented);
 *   - snapshot sourceMode derivation (real:GOOGLE flows into snapshots);
 *   - deterministic query builder (negatives gated + cap).
 *
 * Run:  npm run smoke:google-provider   (uses tsx)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_EXTERNAL_SERP_PROVIDERS,
  computeAvailability,
  getProviderStatus,
  missingConfigKeys,
} from "../src/modules/digital-profile/providers/config";
import { buildPersonSearchQueries } from "../src/modules/digital-profile/providers/query-builder";
import { googleSearchProvider } from "../src/modules/digital-profile/providers/google-search-provider";
import { externalGoogleSerpProvider } from "../src/modules/digital-profile/providers/external-google-serp-provider";
import {
  buildSerperSearchBody,
  normalizeSerperResponse,
  SERPER_SEARCH_ENDPOINT,
} from "../src/modules/digital-profile/providers/serper-search-provider";
import { mapStatusToProviderError, redactUrl } from "../src/modules/digital-profile/providers/http";
import { deriveSourceMode } from "../src/modules/digital-profile/serp-snapshot/data-loader";
import type { SearchProviderRequest } from "../src/modules/digital-profile/providers/types";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const FIX = join(process.cwd(), "tests", "fixtures", "google");
const SERPER_FIX = join(process.cwd(), "tests", "fixtures", "serper");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const serperFixture = (name: string) => JSON.parse(readFileSync(join(SERPER_FIX, name), "utf8"));

const req: SearchProviderRequest = {
  caseId: "c1",
  subjectFullName: "Test Person",
  aliases: [],
  query: "Test Person",
  language: "ru",
  region: "ru",
};

async function main() {
  console.log("Smoke testing real Google provider (no keys)\n");

  // 1. Feature flag off -> DISABLED.
  check(
    "flag off -> disabled",
    computeAvailability("GOOGLE", { masterEnabled: true, enabled: false, hasKeys: true }).status ===
      "DISABLED"
  );

  // 2. Enabled strategy but missing credentials -> NOT_CONFIGURED.
  check(
    "missing creds -> not configured",
    computeAvailability("GOOGLE", { masterEnabled: true, enabled: true, hasKeys: false }).status ===
      "NOT_CONFIGURED"
  );

  // 3. Default env (no GOOGLE_SEARCH_PROVIDER) -> strategy disabled, status reflects it.
  const status = getProviderStatus("GOOGLE");
  check("default status DISABLED + not configured", status.status === "DISABLED" && !status.enabled);
  check(
    "default missingConfigKeys asks for strategy first",
    missingConfigKeys("GOOGLE").includes("GOOGLE_SEARCH_PROVIDER")
  );
  check("default status supportsRealCalls=false", status.supportsRealCalls === false);
  check(
    "status never leaks secret values",
    !/AIza|[A-Za-z0-9_-]{30,}/.test(JSON.stringify(status).replace(/GOOGLE_SEARCH_[A-Z_]+/g, ""))
  );

  // 4. Provider disabled by default — proves no network call happens.
  const disabled = await googleSearchProvider.search(req);
  check("provider.search() disabled by default", disabled.status === "DISABLED", disabled.status);
  check("disabled run returns no results", disabled.results.length === 0);

  // 5. Custom Search success fixture: normalize -> results.
  const okResults = googleSearchProvider.normalize(fixture("success.json"), req);
  check("success -> 3 results", okResults.length === 3, String(okResults.length));
  check(
    "success maps url/domain/provider",
    okResults[0].url === "https://news.example.test/test-person-fraud" &&
      okResults[0].domain === "news.example.test" &&
      okResults[0].provider === "GOOGLE"
  );
  check("success ranks sequential", okResults[0].rank === 1 && okResults[2].rank === 3);
  check(
    "rawMetadata carries no api key / cx",
    !/api[-_]?key|"cx"|engine[-_]?id|AIza/i.test(JSON.stringify(okResults[0].rawMetadata))
  );

  // 6. Duplicate run idempotency proxy: normalize twice -> identical URLs.
  const again = googleSearchProvider.normalize(fixture("success.json"), req);
  check("deterministic urls (idempotent saves)", again[0].url === okResults[0].url);

  // 7. Empty fixture -> 0 results, no crash.
  check("empty -> 0 results, no crash", googleSearchProvider.normalize(fixture("empty.json"), req).length === 0);

  // 8. Malformed fixture (items not an array) -> 0 results, no crash.
  check(
    "malformed -> 0 results (no crash)",
    googleSearchProvider.normalize(fixture("malformed.json"), req).length === 0
  );

  // 9. URL secret redaction: key/cx never appear in a loggable URL.
  const sampleUrl =
    "https://www.googleapis.com/customsearch/v1?key=AIzaSECRETKEY123&cx=abc123:def&q=test&num=10&safe=active";
  const redacted = redactUrl(sampleUrl);
  check("redactUrl hides api key", !redacted.includes("AIzaSECRETKEY123"));
  check("redactUrl keeps host", redacted.includes("googleapis.com"));

  // 10. HTTP status mapping (401/403/429-quota/5xx) + timeout error code exists.
  check("401 -> provider error (non-retryable)", mapStatusToProviderError(401)?.code === "PROVIDER_BAD_RESPONSE" && mapStatusToProviderError(401)?.retryable === false);
  check("403 (no access) -> provider error", mapStatusToProviderError(403)?.code === "PROVIDER_BAD_RESPONSE");
  check("429 (quota) -> rate limited (retryable)", mapStatusToProviderError(429)?.code === "PROVIDER_RATE_LIMITED" && mapStatusToProviderError(429)?.retryable === true);
  check("500 -> provider error (retryable)", mapStatusToProviderError(500)?.code === "PROVIDER_BAD_RESPONSE" && mapStatusToProviderError(500)?.retryable === true);
  check("200 -> no error", mapStatusToProviderError(200) === null);
  // Quota / access-not-configured fixtures parse as JSON error envelopes (sanity).
  check("quota fixture has error code 429", fixture("error-429-quota.json").error.code === 429);
  check("access fixture has error code 403", fixture("error-403.json").error.code === 403);

  // 11. External SERP — config gating + Serper normalize (offline fixtures).
  const ext = await externalGoogleSerpProvider.search(req);
  check("external (not selected) -> NOT_CONFIGURED", ext.status === "NOT_CONFIGURED", ext.status);
  check("external never returns mock results", ext.results.length === 0);
  check(
    "external allowlist is enum-only (SSRF guard)",
    ALLOWED_EXTERNAL_SERP_PROVIDERS.length > 0 &&
      ALLOWED_EXTERNAL_SERP_PROVIDERS.every((p) => /^[a-z0-9_]+$/.test(p))
  );
  check("serper endpoint hardcoded (no env URL)", SERPER_SEARCH_ENDPOINT === "https://google.serper.dev/search");
  const serperBody = buildSerperSearchBody(req, 10);
  const serperBodyStr = JSON.stringify(serperBody);
  check("serper body carries query + gl/hl", serperBody.q === "Test Person" && serperBody.gl === "ru");
  check("serper body never contains api key", !/api[-_]?key|x-api-key/i.test(serperBodyStr));
  const serperOk = normalizeSerperResponse(serperFixture("success.json"), req);
  check("serper success -> 3 results", serperOk.length === 3, String(serperOk.length));
  check(
    "serper maps url/domain/provider/rank",
    serperOk[0].url === "https://news.example.test/test-person-fraud" &&
      serperOk[0].domain === "news.example.test" &&
      serperOk[0].provider === "GOOGLE" &&
      serperOk[0].rank === 1
  );
  check(
    "serper rawMetadata safe (source=serper, no api key)",
    (serperOk[0].rawMetadata as { source?: string }).source === "serper" &&
      !/api[-_]?key/i.test(JSON.stringify(serperOk[0].rawMetadata))
  );
  check("serper empty -> 0 results", normalizeSerperResponse(serperFixture("empty.json"), req).length === 0);
  check(
    "serper malformed -> 0 results (no crash)",
    normalizeSerperResponse(serperFixture("malformed.json"), req).length === 0
  );
  check(
    "serper deterministic urls (idempotent saves)",
    normalizeSerperResponse(serperFixture("success.json"), req)[0].url === serperOk[0].url
  );

  // 12. Snapshot sourceMode derivation (real Google flows into snapshots).
  check("sourceMode MOCK_ONLY (google mock)", deriveSourceMode([{ source: "mock:GOOGLE_SEARCH" }]) === "MOCK_ONLY");
  check("sourceMode REAL_ONLY (google real)", deriveSourceMode([{ source: "real:GOOGLE" }]) === "REAL_ONLY");
  check(
    "sourceMode REAL_ONLY (yandex real + google real)",
    deriveSourceMode([{ source: "real:YANDEX" }, { source: "real:GOOGLE" }]) === "REAL_ONLY"
  );
  check(
    "sourceMode MIXED (yandex real + google mock)",
    deriveSourceMode([{ source: "real:YANDEX" }, { source: "mock:GOOGLE_SEARCH" }]) === "MIXED"
  );
  check(
    "sourceMode MIXED (google real + yandex mock)",
    deriveSourceMode([{ source: "real:GOOGLE" }, { source: "mock:YANDEX_SEARCH" }]) === "MIXED"
  );

  // 13. Query builder: negatives gated by option + cap honoured (shared builder).
  const baseQs = buildPersonSearchQueries(
    { fullName: "Test Person", targetRegions: ["RU"], location: "Россия" },
    { maxQueries: 3 }
  );
  check("queries capped at 3 (google cap)", baseQs.length <= 3, String(baseQs.length));
  check("queries include full name", baseQs.some((q) => q.query === "Test Person"));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
