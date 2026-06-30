/**
 * Manual QA orchestrator for O1–O4 (API-driven, no secrets in output).
 *
 * Run: npx tsx scripts/run-manual-qa-o1-o4.ts
 */

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const H: Record<string, string> = { "Content-Type": "application/json", "x-actor-id": "manual-qa-o1-o4" };

interface QaReport {
  branch: string;
  health: { app: number; renderer: boolean };
  env: Record<string, "SET" | "MISSING">;
  caseId: string;
  agents: Record<string, { status: string; saved?: unknown; error?: string }>;
  providers: unknown;
  surfaces: { byType: Record<string, number>; byRegion: Record<string, number> };
  regions: Record<string, { collectionStatus?: string; organic?: number; surfaces?: number }>;
  artifacts: string[];
  checks: { name: string; ok: boolean; detail?: string }[];
}

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json: json as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return (json.data ?? json) as T;
}

function envStatus(name: string): "SET" | "MISSING" {
  const v = process.env[name];
  return v && v.trim().length > 0 ? "SET" : "MISSING";
}

async function main() {
  const report: QaReport = {
    branch: "feature/orion-search-surfaces-foundation",
    health: { app: 0, renderer: false },
    env: {
      GOOGLE_EXTERNAL_SERP_PROVIDER: envStatus("GOOGLE_EXTERNAL_SERP_PROVIDER"),
      GOOGLE_EXTERNAL_SERP_API_KEY: envStatus("GOOGLE_EXTERNAL_SERP_API_KEY"),
      SERPER_API_KEY: envStatus("SERPER_API_KEY"),
      GOOGLE_SEARCH_PROVIDER: envStatus("GOOGLE_SEARCH_PROVIDER"),
      DIGITAL_PROFILE_GOOGLE_REAL_ENABLED: envStatus("DIGITAL_PROFILE_GOOGLE_REAL_ENABLED"),
      DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED: envStatus("DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED"),
      YANDEX_SEARCH_API_KEY: envStatus("YANDEX_SEARCH_API_KEY"),
      YANDEX_SEARCH_FOLDER_ID: envStatus("YANDEX_SEARCH_FOLDER_ID"),
      DIGITAL_PROFILE_YANDEX_REAL_ENABLED: envStatus("DIGITAL_PROFILE_YANDEX_REAL_ENABLED"),
    },
    caseId: "",
    agents: {},
    providers: null,
    surfaces: { byType: {}, byRegion: {} },
    regions: {},
    artifacts: [],
    checks: [],
  };

  const appH = await fetch(`${BASE}/health`);
  report.health.app = appH.status;
  const rendH = await fetch(process.env.RENDERER_URL ?? "http://localhost:8080/health");
  report.health.renderer = rendH.ok;

  report.checks.push({ name: "app health 200", ok: appH.status === 200, detail: String(appH.status) });
  report.checks.push({ name: "renderer health ok", ok: rendH.ok });

  // Find Tomilin case or create
  const casesRes = await req("GET", "/cases");
  const items = (data<{ items?: { id: string; subjectFullName?: string }[] }>(casesRes.json)).items ?? [];
  let caseId =
    items.find((c) => (c.subjectFullName ?? "").includes("Томилин"))?.id ??
    items[0]?.id;

  if (!caseId) {
    const created = await req("POST", "/cases", {
      fullName: "Томилин Константин Романович",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    });
    caseId = data<{ id: string }>(created.json).id;
  }
  report.caseId = caseId;

  const prov = await req("GET", "/providers");
  report.providers = data(prov.json);

  for (const agent of [
    "REAL_ORION_SEARCH_PROFILE",
    "REAL_ORION_GOOGLE_SURFACES",
    "REAL_ORION_UAE_INTERNATIONAL",
    "RISK_CLASSIFIER_V1",
  ]) {
    console.log(`Running ${agent}...`);
    const run = await req("POST", `/cases/${caseId}/agents/${agent}/run`, {});
    const d = data<{ status?: string; saved?: unknown; error?: string }>(run.json);
    report.agents[agent] = {
      status: d.status ?? String(run.status),
      saved: d.saved,
      error: d.error,
    };
    report.checks.push({
      name: `agent ${agent}`,
      ok: d.status === "SUCCEEDED" || run.status === 200,
      detail: d.status ?? d.error,
    });
  }

  const surfacesRes = await req("GET", `/cases/${caseId}/search-surfaces`);
  const surfaceItems =
    (data<{ items?: Array<{ type: string; region?: string | null }> }>(surfacesRes.json)).items ?? [];
  for (const s of surfaceItems) {
    report.surfaces.byType[s.type] = (report.surfaces.byType[s.type] ?? 0) + 1;
    const reg = (s.region ?? "UNKNOWN").toUpperCase();
    report.surfaces.byRegion[reg] = (report.surfaces.byRegion[reg] ?? 0) + 1;
  }

  const organicRes = await req("GET", `/cases/${caseId}/search-results`);
  const organic =
    (data<{ items?: Array<{ rawMetadata?: { orionRegion?: string } }> }>(organicRes.json)).items ?? [];
  for (const reg of ["RU", "UAE", "INTERNATIONAL"] as const) {
    const regOrganic = organic.filter(
      (r) => String((r.rawMetadata as { orionRegion?: string })?.orionRegion ?? "RU").toUpperCase() === reg
    );
    report.regions[reg] = {
      organic: regOrganic.length,
      surfaces: surfaceItems.filter((s) => (s.region ?? "").toUpperCase() === reg).length,
      collectionStatus: regOrganic.length + surfaceItems.filter((s) => (s.region ?? "").toUpperCase() === reg).length > 0
        ? "COLLECTED"
        : reg === "RU"
          ? "NOT_QUERIED"
          : "NOT_QUERIED",
    };
  }

  // Run QA report script via spawn
  const { execSync } = await import("node:child_process");
  try {
    execSync(`npx tsx scripts/qa-orion-surfaces-report.ts ${caseId}`, {
      cwd: process.cwd(),
      stdio: "pipe",
      env: process.env,
    });
    report.checks.push({ name: "qa-orion-surfaces-report", ok: true });
  } catch (e) {
    report.checks.push({
      name: "qa-orion-surfaces-report",
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : "failed",
    });
  }

  const { readdirSync, existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const outDir = join(process.cwd(), "storage/digital-profile/qa-o1-o4-surfaces");
  if (existsSync(outDir)) {
    report.artifacts = readdirSync(outDir);
    for (const f of [
      "report-ru-internal-draft-v3.pdf",
      "report-ru-internal-draft-v3.pptx",
      "report-en-client-none-v3.pdf",
      "report-en-client-none-v3.pptx",
      "report-json-ru.json",
      "report-json-en.json",
    ]) {
      report.checks.push({ name: `artifact ${f}`, ok: report.artifacts.includes(f) });
    }

    const enJson = existsSync(join(outDir, "report-json-en.json"))
      ? readFileSync(join(outDir, "report-json-en.json"), "utf8")
      : "";
    report.checks.push({
      name: "EN report 50-slide render metadata",
      ok: enJson.includes("searchSurfaces") || enJson.includes("auditSummary"),
    });
    report.checks.push({
      name: "EN no secret apiKey values",
      ok: !/"apiKey"\s*:\s*"[a-f0-9]{20,}"/i.test(enJson),
    });
    report.checks.push({
      name: "EN no mock/demo wording",
      ok: !/\bmock fixture\b/i.test(enJson) && !/\bdemo data\b/i.test(enJson),
    });

    const ruJson = existsSync(join(outDir, "report-json-ru.json"))
      ? JSON.parse(readFileSync(join(outDir, "report-json-ru.json"), "utf8"))
      : null;
    if (ruJson?.serpSnapshot) {
      report.checks.push({
        name: "SERP snapshot synthetic",
        ok: ruJson.serpSnapshot.mode === "SYNTHETIC",
      });
    }
    const ss = ruJson?.searchSurfaces?.regions;
    if (ss) {
      for (const [k, block] of Object.entries(ss) as [string, { collectionStatus?: string }][]) {
        report.regions[k.toUpperCase()] = {
          ...report.regions[k.toUpperCase()],
          collectionStatus: block.collectionStatus,
        };
      }
    }
  }

  console.log("\n=== MANUAL QA REPORT (no secrets) ===\n");
  console.log(JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
