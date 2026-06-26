/**
 * Smoke test for the real Yandex Cloud Search API v2 provider (Stage N1).
 *
 * Pure/offline unit checks — NO API keys, NO dev server, NO DB, NO network:
 *   - availability / config gating (flag off, missing creds);
 *   - v2 request body builder never leaks secrets;
 *   - base64 rawData decode + XXE guard + size handling;
 *   - XML normalize() on success / empty / malformed fixtures;
 *   - HTTP status mapping (401/403/429/5xx);
 *   - deterministic query builder (negatives + cap);
 *   - snapshot sourceMode derivation (MOCK_ONLY / REAL_ONLY / MIXED).
 *
 * Run:  npm run smoke:yandex-provider   (uses tsx)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeAvailability } from "../src/modules/digital-profile/providers/config";
import { buildPersonSearchQueries } from "../src/modules/digital-profile/providers/query-builder";
import { yandexSearchProvider } from "../src/modules/digital-profile/providers/yandex-search-provider";
import {
  buildYandexV2Body,
  decodeYandexV2RawData,
  toLocalization,
  toSearchType,
  YandexV2ParseError,
} from "../src/modules/digital-profile/providers/yandex-v2";
import { mapStatusToProviderError } from "../src/modules/digital-profile/providers/http";
import { deriveSourceMode } from "../src/modules/digital-profile/serp-snapshot/data-loader";
import type { SearchProviderRequest } from "../src/modules/digital-profile/providers/types";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const FIX = join(process.cwd(), "tests", "fixtures", "yandex");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const asV2 = (xml: string) => ({ rawData: Buffer.from(xml, "utf8").toString("base64") });

const req: SearchProviderRequest = {
  caseId: "c1",
  subjectFullName: "Иван Петров",
  aliases: [],
  query: "Иван Петров",
  language: "ru",
  region: "ru",
};

async function main() {
  console.log("Smoke testing real Yandex provider (no keys)\n");

  // 1. Feature flag off -> DISABLED.
  check(
    "flag off -> disabled",
    computeAvailability("YANDEX", { masterEnabled: true, enabled: false, hasKeys: true }).status ===
      "DISABLED"
  );

  // 2. Missing credentials -> NOT_CONFIGURED.
  check(
    "missing creds -> not configured",
    computeAvailability("YANDEX", { masterEnabled: true, enabled: true, hasKeys: false }).status ===
      "NOT_CONFIGURED"
  );

  // 3. Provider disabled by default (env unset) — proves no network call happens.
  const disabled = await yandexSearchProvider.search(req);
  check("provider.search() disabled by default", disabled.status === "DISABLED", disabled.status);
  check("disabled run returns no results + no rawSnapshot", disabled.results.length === 0 && !("rawSnapshot" in disabled && (disabled as { rawSnapshot?: unknown }).rawSnapshot));

  // 4. v2 body builder: correct enums, secret never present.
  const body = buildYandexV2Body({
    queryText: "Иван Петров",
    folderId: "folder-123",
    page: 0,
    searchType: toSearchType("ru"),
    localization: toLocalization("ru"),
  });
  const bodyStr = JSON.stringify(body);
  check("body uses FORMAT_XML", body.responseFormat === "FORMAT_XML");
  check("body searchType RU", toSearchType("ru") === "SEARCH_TYPE_RU");
  check("body localization EN", toLocalization("en") === "LOCALIZATION_EN");
  check("body carries folderId", bodyStr.includes("folder-123"));
  check(
    "body never contains an api key field",
    !/apikey|api-key|apiKey/i.test(bodyStr)
  );

  // 5. Success fixture: decode base64 rawData -> XML -> normalize.
  const okXml = decodeYandexV2RawData(asV2(fixture("success.xml")));
  const okResults = yandexSearchProvider.normalize(okXml, req);
  check("success -> 3 results", okResults.length === 3, String(okResults.length));
  check(
    "success maps url/domain/provider",
    okResults[0].url === "https://news-watch-ru.example/petrov-investigation" &&
      okResults[0].domain === "news-watch-ru.example" &&
      okResults[0].provider === "YANDEX"
  );
  check("success strips <hlword> tags", !okResults[0].title.includes("<"));
  check("success ranks sequential", okResults[0].rank === 1 && okResults[2].rank === 3);
  check(
    "rawMetadata carries no api key",
    !/api[-_]?key/i.test(JSON.stringify(okResults[0].rawMetadata))
  );

  // 6. Duplicate run idempotency proxy: normalize twice -> identical URLs.
  const again = yandexSearchProvider.normalize(okXml, req);
  check("deterministic urls (idempotent saves)", again[0].url === okResults[0].url);

  // 7. Empty fixture -> 0 results, no crash.
  const emptyXml = decodeYandexV2RawData(asV2(fixture("empty.xml")));
  check("empty -> 0 results, no crash", yandexSearchProvider.normalize(emptyXml, req).length === 0);

  // 8. Malformed JSON response (missing rawData) -> parse error.
  let parseThrew = false;
  try {
    decodeYandexV2RawData({ unexpected: true });
  } catch (e) {
    parseThrew = e instanceof YandexV2ParseError;
  }
  check("malformed response (no rawData) -> parse error", parseThrew);

  // 9. Malformed XML still decodes but normalizes to 0 (graceful).
  const badXml = decodeYandexV2RawData(asV2(fixture("malformed.xml")));
  check("malformed XML -> 0 results (no crash)", yandexSearchProvider.normalize(badXml, req).length === 0);

  // 10. XXE guard: DOCTYPE/ENTITY rejected.
  let xxeThrew = false;
  try {
    decodeYandexV2RawData(asV2(fixture("xxe.xml")));
  } catch (e) {
    xxeThrew = e instanceof YandexV2ParseError && /DOCTYPE|ENTITY/i.test((e as Error).message);
  }
  check("XXE (DOCTYPE/ENTITY) rejected", xxeThrew);

  // 11. HTTP status mapping (401/403/429/5xx).
  check("401 -> provider error (non-retryable)", mapStatusToProviderError(401)?.code === "PROVIDER_BAD_RESPONSE" && mapStatusToProviderError(401)?.retryable === false);
  check("403 -> provider error", mapStatusToProviderError(403)?.code === "PROVIDER_BAD_RESPONSE");
  check("429 -> rate limited (retryable)", mapStatusToProviderError(429)?.code === "PROVIDER_RATE_LIMITED" && mapStatusToProviderError(429)?.retryable === true);
  check("500 -> provider error (retryable)", mapStatusToProviderError(500)?.code === "PROVIDER_BAD_RESPONSE" && mapStatusToProviderError(500)?.retryable === true);
  check("200 -> no error", mapStatusToProviderError(200) === null);

  // 12. Query builder: negatives gated by option + cap honoured.
  const baseQs = buildPersonSearchQueries(
    { fullName: "Иван Петров", targetRegions: ["RU"], location: "Россия" },
    { maxQueries: 5 }
  );
  check("queries capped at 5", baseQs.length <= 5, String(baseQs.length));
  check("queries include full name", baseQs.some((q) => q.query === "Иван Петров"));
  const negQs = buildPersonSearchQueries(
    { fullName: "Иван Петров", targetRegions: ["RU"] },
    { maxQueries: 20, includeNegative: true }
  );
  check(
    "negative queries appear when enabled",
    negQs.some((q) => /расследование|мошенничество|санкции|суд/.test(q.query))
  );
  const noNegQs = buildPersonSearchQueries({ fullName: "Иван Петров", targetRegions: ["RU"] }, { maxQueries: 20 });
  check(
    "no negative queries by default",
    !noNegQs.some((q) => /расследование|мошенничество|санкции|суд/.test(q.query))
  );

  // 13. Snapshot sourceMode derivation (real Yandex results flow into snapshots).
  check("sourceMode MOCK_ONLY", deriveSourceMode([{ source: "mock:YANDEX_SEARCH" }]) === "MOCK_ONLY");
  check("sourceMode REAL_ONLY", deriveSourceMode([{ source: "real:YANDEX" }]) === "REAL_ONLY");
  check(
    "sourceMode MIXED",
    deriveSourceMode([{ source: "real:YANDEX" }, { source: "mock:YANDEX_SEARCH" }]) === "MIXED"
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
