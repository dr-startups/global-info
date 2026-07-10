/**
 * Offline unit + integration smoke for provider-first SerpObservation vertical slice.
 * No network, no residential proxy, no CAPTCHA bypass.
 *
 * Writes machine-readable QA JSON:
 *   storage/digital-profile/qa-serp-observation-serper-slice/qa-result.json
 *
 * Run: npm run smoke:serp-observation-serper-slice
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SYNTHETIC_API_SERP_CAPTION,
  buildSerpQueryId,
  classifyProviderFetchOutcome,
  evaluateClientVisualAssetGate,
  ingestSerperOrganicObservations,
  mapSerperOrganicToObservationDrafts,
  mergeObservationDraftsWithoutUrlDedupe,
  serpSyntheticAssetToReportAsset,
  buildSyntheticSerpViewModelFromObservations,
  isCaptchaBlocked,
  isEmptyResultsStatus,
} from "../src/modules/digital-profile/serp-observation";
import type { SerperSurfaceItem } from "../src/modules/digital-profile/providers/serper-surfaces";
import type { PersistedSerpObservation } from "../src/modules/digital-profile/serp-observation";
import { renderSerpSnapshotPng } from "../src/modules/digital-profile/serp-snapshot/renderer";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function organicItem(partial: Partial<SerperSurfaceItem> & { url: string; rank: number }): SerperSurfaceItem {
  return {
    kind: "organic",
    query: partial.query ?? "Глинка Сергей",
    region: partial.region ?? "RU",
    language: partial.language ?? "ru",
    rank: partial.rank,
    title: partial.title ?? "Title",
    snippet: partial.snippet ?? "Snippet",
    url: partial.url,
    domain: partial.domain ?? "example.com",
    thumbnailUrl: null,
    imageUrl: null,
    videoUrl: null,
    sourcePageUrl: partial.url,
    rawMetadataSafe: { source: "serper", surface: "organic" },
  };
}

async function main() {
  console.log("Smoke: Serper organic → SerpObservation → synthetic → ReportSpec\n");

  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
  check("schema has SerpObservation", schema.includes("model SerpObservation"));
  check("schema has SearchDocument", schema.includes("model SearchDocument"));
  check("schema has SerpSyntheticAsset", schema.includes("model SerpSyntheticAsset"));
  check(
    "schema links SerpSyntheticAssetObservation",
    schema.includes("model SerpSyntheticAssetObservation")
  );

  const migrationSql = join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260710180000_add_serp_observations",
    "migration.sql"
  );
  check("migration exists", existsSync(migrationSql));
  const sql = existsSync(migrationSql) ? readFileSync(migrationSql, "utf-8") : "";
  check("migration creates dp_serp_observations", sql.includes("dp_serp_observations"));
  check("migration creates dp_serp_synthetic_assets", sql.includes("dp_serp_synthetic_assets"));

  // CAPTCHA ≠ NO_RESULTS
  const captcha = classifyProviderFetchOutcome({
    configured: true,
    errorMessage: "blocked by captcha / unusual traffic",
    organicCount: 0,
  });
  check("CAPTCHA status typed", captcha === "PROVIDER_BLOCKED_CAPTCHA");
  check("CAPTCHA isCaptchaBlocked", isCaptchaBlocked(captcha));
  check("CAPTCHA is not empty-results", !isEmptyResultsStatus(captcha));

  const empty = classifyProviderFetchOutcome({
    configured: true,
    organicCount: 0,
  });
  check("empty organic is NO_RESULTS", empty === "NO_RESULTS");
  check("NO_RESULTS is empty-results", isEmptyResultsStatus(empty));

  const auditRunId = "audit-run-slice-1";
  const sharedUrl = "https://example.com/glinka";

  const q1 = mapSerperOrganicToObservationDrafts({
    caseId: "case-1",
    auditRunId,
    queryText: "Глинка Сергей Михайлович",
    region: "RU",
    language: "ru",
    items: [organicItem({ url: sharedUrl, rank: 1, title: "A" })],
  });
  const q2 = mapSerperOrganicToObservationDrafts({
    caseId: "case-1",
    auditRunId,
    queryText: "Глинка Сергей санкции",
    region: "RU",
    language: "ru",
    items: [organicItem({ url: sharedUrl, rank: 3, title: "B", query: "Глинка Сергей санкции" })],
  });
  const merged = mergeObservationDraftsWithoutUrlDedupe([q1, q2]);
  check("same URL kept twice across queries", merged.length === 2);
  check("ranks preserved separately", merged[0].rank === 1 && merged[1].rank === 3);
  check("single auditRunId", merged.every((o) => o.auditRunId === auditRunId));
  check("queryIds differ", merged[0].queryId !== merged[1].queryId);

  const queryIdStable = buildSerpQueryId({
    auditRunId,
    provider: "serper",
    engine: "GOOGLE",
    region: "RU",
    language: "ru",
    queryText: "  Глинка   Сергей  ",
  });
  const queryIdStable2 = buildSerpQueryId({
    auditRunId,
    provider: "serper",
    engine: "GOOGLE",
    region: "RU",
    language: "ru",
    queryText: "глинка сергей",
  });
  check("queryId normalized stable", queryIdStable === queryIdStable2);

  // ingest with injected CAPTCHA failure
  const blocked = await ingestSerperOrganicObservations({
    caseId: "case-1",
    auditRunId,
    queryText: "test",
    region: "RU",
    language: "ru",
    fetchFn: async () => ({
      status: "FAILED",
      items: [],
      error: "HTTP 403 captcha challenge",
    }),
  });
  check(
    "ingest CAPTCHA → PROVIDER_BLOCKED_CAPTCHA",
    blocked.status === "PROVIDER_BLOCKED_CAPTCHA" && blocked.observations.length === 0
  );

  const okIngest = await ingestSerperOrganicObservations({
    caseId: "case-1",
    auditRunId,
    queryText: "Глинка Сергей",
    region: "RU",
    language: "ru",
    fetchFn: async () => ({
      status: "SUCCESS",
      items: [
        organicItem({ url: "https://a.example/1", rank: 1 }),
        organicItem({ url: "https://b.example/2", rank: 2 }),
      ],
    }),
  });
  check("ingest OK observations", okIngest.status === "OK" && okIngest.observations.length === 2);

  // synthetic view model caption + PNG
  const persisted: PersistedSerpObservation[] = okIngest.observations.map((d, i) => ({
    ...d,
    id: `obs-${i + 1}`,
    searchDocumentId: `doc-${i + 1}`,
  }));
  const vm = buildSyntheticSerpViewModelFromObservations({
    observations: persisted,
    subjectName: "Глинка Сергей Михайлович",
    queryText: "Глинка Сергей",
  });
  check("synthetic caption exact", vm.footerNote === SYNTHETIC_API_SERP_CAPTION);

  let pngOk = false;
  let pngBytes = 0;
  let pngSha = "";
  try {
    const png = await renderSerpSnapshotPng(vm);
    pngBytes = png.byteLength;
    pngSha = createHash("sha256").update(png).digest("hex");
    pngOk = png.byteLength > 2000;
  } catch (err) {
    console.warn("PNG render skipped/failed:", err instanceof Error ? err.message : err);
  }
  check("synthetic PNG rendered", pngOk, `${pngBytes} bytes`);

  const reportAsset = serpSyntheticAssetToReportAsset({
    assetId: "asset-1",
    queryText: "Глинка Сергей",
    pngBase64: pngOk ? Buffer.alloc(8, 1).toString("base64") : "",
    observationIds: persisted.map((p) => p.id),
    status: pngOk ? "ready" : "missing",
  });
  check("ReportAsset kind synthetic_serp", reportAsset.kind === "synthetic_serp");
  check(
    "ReportAsset traces to SerpObservation",
    reportAsset.evidenceRefs.every((r) => r.startsWith("serp_observation:")) &&
      reportAsset.evidenceRefs.length === 2
  );
  check("ReportAsset caption", reportAsset.caption === SYNTHETIC_API_SERP_CAPTION);

  const gateOk = evaluateClientVisualAssetGate({
    requiredSections: [
      { sectionKey: "ru_search_results", requiredAssetRefs: [reportAsset.assetRef] },
    ],
    assets: [{ ...reportAsset, status: "ready", imageData: "x" }],
  });
  check("client gate allows READY", gateOk.allowed);

  const gateBlock = evaluateClientVisualAssetGate({
    requiredSections: [
      { sectionKey: "ru_search_results", requiredAssetRefs: ["serper_organic_serp_missing"] },
    ],
    assets: [{ ...reportAsset, status: "missing", imageData: undefined }],
  });
  check("client gate blocks missing visual", !gateBlock.allowed);
  check(
    "block reason REQUIRED_VISUAL_ASSET_MISSING",
    gateBlock.blockedSections[0]?.reason === "REQUIRED_VISUAL_ASSET_MISSING"
  );

  // no proxy / captcha-bypass deps in this module (imports / package refs only)
  const moduleDir = join(process.cwd(), "src", "modules", "digital-profile", "serp-observation");
  const modFiles = [
    "ingest-serper-organic.ts",
    "persist.ts",
    "synthetic-asset.ts",
    "index.ts",
    "adapters/dataforseo-adapter.ts",
  ];
  let proxyDep = false;
  for (const f of modFiles) {
    const body = readFileSync(join(moduleDir, f), "utf-8");
    if (
      /from\s+["'].*(proxy|2captcha|anticaptcha|brightdata|oxylabs|playwright)/i.test(body) ||
      /require\(["'].*(2captcha|anticaptcha)/i.test(body)
    ) {
      proxyDep = true;
    }
  }
  check("no CAPTCHA-bypass / residential proxy deps in slice", !proxyDep);

  const outDir = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-serp-observation-serper-slice"
  );
  mkdirSync(outDir, { recursive: true });
  const qa = {
    stage: "serp-observation-serper-organic-slice",
    passed: failures === 0,
    failures,
    auditRunId,
    caption: SYNTHETIC_API_SERP_CAPTION,
    checks: {
      captchaNotNoResults: captcha === "PROVIDER_BLOCKED_CAPTCHA" && empty === "NO_RESULTS",
      urlAppearancesNotDeduped: merged.length === 2,
      singleAuditRunId: merged.every((o) => o.auditRunId === auditRunId),
      syntheticTracesToObservations: reportAsset.evidenceRefs,
      clientGateBlocksMissingVisual: !gateBlock.allowed,
      noResidentialProxyDeps: !proxyDep,
      pngRendered: pngOk,
      pngSha256: pngSha || null,
    },
    generatedAt: new Date().toISOString(),
  };
  const qaPath = join(outDir, "qa-result.json");
  writeFileSync(qaPath, JSON.stringify(qa, null, 2), "utf-8");
  check("QA result written", existsSync(qaPath));

  console.log(`\nQA → ${qaPath}`);
  console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
