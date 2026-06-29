/**
 * Live Serper verification — loads .env, checks provider status, one real query.
 * Never prints API keys or full env values for secrets.
 *
 * Run: npx tsx scripts/verify-serper-live.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const SECRET_KEYS = new Set([
  "GOOGLE_EXTERNAL_SERP_API_KEY",
  "GOOGLE_SEARCH_API_KEY",
  "GOOGLE_SEARCH_ENGINE_ID",
]);

function envCheck(name: string): { ok: boolean; display: string } {
  const v = (process.env[name] ?? "").trim();
  if (!v) return { ok: false, display: "MISSING" };
  if (SECRET_KEYS.has(name)) return { ok: true, display: `SET (${v.length} chars)` };
  return { ok: true, display: v };
}

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  loadEnvFile(join(process.cwd(), ".env"));

  console.log("Serper live verification\n");

  const required = [
    "DIGITAL_PROFILE_GOOGLE_REAL_ENABLED",
    "GOOGLE_SEARCH_PROVIDER",
    "GOOGLE_EXTERNAL_SERP_PROVIDER",
    "GOOGLE_EXTERNAL_SERP_API_KEY",
  ];
  for (const k of required) {
    const c = envCheck(k);
    check(`${k} ${c.display}`, c.ok);
  }

  const { getProviderStatus } = await import("../src/modules/digital-profile/providers/config");
  const { googleSearchProvider } = await import(
    "../src/modules/digital-profile/providers/google-search-provider"
  );

  const status = getProviderStatus("GOOGLE");
  check("provider status ENABLED", status.status === "ENABLED", status.status);
  check("supportsRealCalls", status.supportsRealCalls === true);
  check("missingConfigKeys empty", status.missingConfigKeys.length === 0, JSON.stringify(status.missingConfigKeys));

  console.log("\nLive Serper query (1 call, may consume credits)...\n");

  const result = await googleSearchProvider.search({
    caseId: "verify-live",
    subjectFullName: "Test Person",
    aliases: [],
    query: "Global Info compliance audit test",
    language: process.env.GOOGLE_SEARCH_HL ?? "ru",
    region: process.env.GOOGLE_SEARCH_GL ?? "ru",
    limit: 3,
  });

  check("search status SUCCESS", result.status === "SUCCESS", result.status);
  check("results returned", result.results.length > 0, String(result.results.length));

  if (result.results.length > 0) {
    const r0 = result.results[0];
    check("provider GOOGLE", r0.provider === "GOOGLE");
    check("has title + url", Boolean(r0.title && r0.url));
    check(
      "rawMetadata has source=serper, no api key",
      (r0.rawMetadata as { source?: string })?.source === "serper" &&
        !/api[-_]?key/i.test(JSON.stringify(r0.rawMetadata))
    );
    console.log(`  sample: rank=${r0.rank} domain=${r0.domain}`);
    console.log(`  title: ${r0.title.slice(0, 80)}${r0.title.length > 80 ? "…" : ""}`);
  }

  if (result.error) {
    console.log(`  error: ${result.error.code} — ${result.error.message}`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
