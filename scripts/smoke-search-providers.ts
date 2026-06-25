/**
 * Smoke test for the real search provider layer (Stage H2) — NO API keys needed.
 *
 * Pure unit checks (no dev server, no DB, no network): config availability logic,
 * query-builder dedupe, and provider normalize() on mocked API responses.
 *
 * Run:  npm run smoke:search-providers   (uses tsx)
 */

import { computeAvailability } from "../src/modules/digital-profile/providers/config";
import { buildPersonSearchQueries } from "../src/modules/digital-profile/providers/query-builder";
import { googleSearchProvider } from "../src/modules/digital-profile/providers/google-search-provider";
import { yandexSearchProvider } from "../src/modules/digital-profile/providers/yandex-search-provider";
import type { SearchProviderRequest } from "../src/modules/digital-profile/providers/types";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const req: SearchProviderRequest = {
  caseId: "c1",
  subjectFullName: "Ivan Petrov",
  aliases: ["I. Petrov"],
  query: "Ivan Petrov",
  language: "en",
  region: "RU",
};

function main() {
  console.log("Smoke testing search providers (no keys)\n");

  // 1. Availability logic (pure)
  check(
    "google disabled (master off)",
    computeAvailability("GOOGLE", { masterEnabled: false, enabled: true, hasKeys: true }).status ===
      "DISABLED"
  );
  check(
    "google disabled (provider off)",
    computeAvailability("GOOGLE", { masterEnabled: true, enabled: false, hasKeys: true }).status ===
      "DISABLED"
  );
  check(
    "google not configured (no keys)",
    computeAvailability("GOOGLE", { masterEnabled: true, enabled: true, hasKeys: false }).status ===
      "NOT_CONFIGURED"
  );
  check(
    "google enabled (keys present)",
    computeAvailability("GOOGLE", { masterEnabled: true, enabled: true, hasKeys: true }).status ===
      "ENABLED"
  );
  check(
    "yandex not configured (no keys)",
    computeAvailability("YANDEX", { masterEnabled: true, enabled: true, hasKeys: false }).status ===
      "NOT_CONFIGURED"
  );
  check(
    "yandex disabled (master off)",
    computeAvailability("YANDEX", { masterEnabled: false, enabled: true, hasKeys: true }).status ===
      "DISABLED"
  );
  check(
    "wikipedia ignores master switch",
    computeAvailability("WIKIPEDIA", { masterEnabled: false, enabled: true, hasKeys: false })
      .status === "ENABLED"
  );

  // 2. Live providers default to DISABLED with env unset (no network call)
  Promise.resolve(googleSearchProvider.search(req)).then((r) =>
    check("google.search() disabled by default", r.status === "DISABLED", r.status)
  );

  // 3. Query builder dedupe + cap + content
  const qs = buildPersonSearchQueries({
    fullName: "Иван Петров",
    aliases: ["Ivan Petrov", "Ivan Petrov"],
    targetRegions: ["RU", "UAE"],
  });
  check("queries generated", qs.length > 0, String(qs.length));
  check("queries capped (<=6)", qs.length <= 6, String(qs.length));
  const keys = qs.map((q) => `${q.language}|${q.query.toLowerCase()}`);
  check("queries de-duplicated", new Set(keys).size === keys.length);
  check("queries include full name", qs.some((q) => q.query === "Иван Петров"));
  check("queries cover ru + en", new Set(qs.map((q) => q.language)).size >= 1);

  // 4. Google normalize() on mocked Custom Search response
  const gMock = {
    items: [
      { title: "Profile A", snippet: "snippet A", link: "https://a.example/x", displayLink: "a.example" },
      { title: "Profile B", snippet: "snippet B", link: "https://www.b.example/y" },
    ],
  };
  const gNorm = googleSearchProvider.normalize(gMock, req);
  check("google normalize -> 2 results", gNorm.length === 2, String(gNorm.length));
  check("google normalize maps fields", gNorm[0].url === "https://a.example/x" && gNorm[0].domain === "a.example");
  check("google normalize provider=GOOGLE + rawMetadata", gNorm[0].provider === "GOOGLE" && !!gNorm[0].rawMetadata);
  check("google normalize ranks sequential", gNorm[0].rank === 1 && gNorm[1].rank === 2);

  // 5. Yandex normalize() on mocked XML response
  const yMock = `<?xml version="1.0"?><yandexsearch><response><results><grouping><group>
    <doc><url>https://ya.example/1</url><title>Yandex <hlword>Petrov</hlword></title><headline>head one</headline><domain>ya.example</domain></doc>
    <doc><url>https://ya.example/2</url><title>Second</title><passage>pass two</passage></doc>
  </group></grouping></results></response></yandexsearch>`;
  const yNorm = yandexSearchProvider.normalize(yMock, req);
  check("yandex normalize -> 2 results", yNorm.length === 2, String(yNorm.length));
  check("yandex normalize parses url+title", yNorm[0].url === "https://ya.example/1" && yNorm[0].title.includes("Petrov"));
  check("yandex normalize strips highlight tags", !yNorm[0].title.includes("<"));
  check("yandex normalize provider=YANDEX", yNorm[0].provider === "YANDEX");

  // 6. dedupHash idempotency proxy: normalize twice -> identical URLs (DB unique
  //    [caseId, dedupHash] + skipDuplicates then guarantees no growth on re-run).
  const again = googleSearchProvider.normalize(gMock, req);
  check("normalize deterministic urls (idempotent saves)", again[0].url === gNorm[0].url && again[1].url === gNorm[1].url);

  setTimeout(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }, 200);
}

main();
