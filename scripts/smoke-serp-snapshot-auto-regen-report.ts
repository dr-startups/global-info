/**
 * Smoke test — Stage R1.1.3 SERP snapshot auto-regeneration on report build.
 *
 * Run: npm run smoke:serp-snapshot-auto-regen-report
 */

import {
  SERP_SNAPSHOT_GENERATOR_VERSION,
  metadataStaleReason,
} from "../src/modules/digital-profile/serp-snapshot/snapshot-freshness";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-r113-regen" };

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

function offlineChecks() {
  console.log("--- Offline stale metadata ---\n");
  check("generator version constant", SERP_SNAPSHOT_GENERATOR_VERSION === "r1.1.3");
  check("missing version => stale", metadataStaleReason(null, "c1", null) === "missing_metadata");
  check(
    "old version => stale",
    metadataStaleReason(
      {
        caseId: "c1",
        generatorVersion: "r1.1.2",
        themeCount: 0,
        highlightedCount: 0,
        generatedAt: new Date().toISOString(),
      } as never,
      "c1",
      null
    ) === "generator_version"
  );
  check(
    "phantom theme => stale",
    metadataStaleReason(
      {
        caseId: "c1",
        generatorVersion: SERP_SNAPSHOT_GENERATOR_VERSION,
        themeCount: 1,
        highlightedCount: 0,
        generatedAt: new Date().toISOString(),
      } as never,
      "c1",
      null
    ) === "inconsistent_theme"
  );
}

async function apiChecks() {
  console.log("\n--- API auto-regen on report ---\n");

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, String(e));
    return;
  }

  const caseRes = await req("POST", `${API}/cases`, {
    fullName: "R1.1.3 Auto Regen Subject",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = (caseRes.json?.data as { id?: string })?.id;
  check("case created", !!caseId);
  if (!caseId) return;

  for (let i = 1; i <= 3; i++) {
    await req("POST", `${API}/cases/${caseId}/search-results`, {
      engine: "YANDEX",
      url: `https://lenta.ru/r113-${i}`,
      title: `Neutral row ${i}`,
      classification: "UNCLASSIFIED",
    });
  }

  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  const before = ((await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data as { snapshot?: { id?: string } })?.snapshot;
  check("initial snapshot exists", !!before?.id);

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const reportJson = (gen.json?.data as { reportJson?: Record<string, unknown> })?.reportJson;
  const snap = reportJson?.serpSnapshot as
    | { id?: string; metadata?: { wasRegeneratedForReport?: boolean } }
    | undefined;
  check("report generated", gen.status === 201);
  check("report has serpSnapshot after regen", !!snap?.id);

  const after = ((await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data as {
    snapshot?: { themeCount?: number; highlightedCount?: number; id?: string };
  })?.snapshot;
  check("latest snapshot id present", !!after?.id);
  check(
    "theme/highlight counts aligned",
    (after?.themeCount ?? 0) > 0 === (after?.highlightedCount ?? 0) > 0
  );

  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = enRender.json?.data as { slideCount?: number; warnings?: string[] };
  check("EN client render", enRender.status === 201);
  check("EN 50 slides", en?.slideCount === 50, String(en?.slideCount));
  check(
    "EN no internal SERP regen warning",
    !(en?.warnings ?? []).some((w) => /stale|refresh|regenerat|не удалось/i.test(w))
  );
}

async function main() {
  console.log("Smoke testing R1.1.3 SERP auto-regen on report\n");
  offlineChecks();
  await apiChecks();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
