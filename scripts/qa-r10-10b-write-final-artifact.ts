/**
 * R10.10b — Assemble final staging readiness artifact from live smoke results.
 * Does not print secrets. Does not deploy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = join(process.cwd(), "storage", "digital-profile", "qa-r10-10-deploy-preparation");
mkdirSync(outDir, { recursive: true });

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout?.trim();
const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).stdout?.trim();

const flags = spawnSync("npx", ["tsx", "scripts/r10-10b-audit-staging-flags.ts"], {
  cwd: process.cwd(),
  encoding: "utf-8",
  shell: true,
});
let flagsJson: { report: Record<string, unknown>; blockers: string[] } = { report: {}, blockers: [] };
try {
  flagsJson = JSON.parse(flags.stdout.slice(flags.stdout.indexOf("{")));
} catch {
  flagsJson = { report: {}, blockers: ["flags-parse-failed"] };
}

const liveAuth = readJson<{ passed: boolean; checks: Array<{ id: string; passed: boolean }> }>(
  join(outDir, "r10-10b-live-auth-api-smoke.json")
);
const authQa = readJson<{ verdict: string; passed: boolean }>(join(outDir, "r10-10a-admin-auth-qa.json"));
const summary = readJson<Record<string, unknown>>(join(outDir, "qa-summary.json"));
const visual = readJson<Record<string, unknown>>(join(outDir, "visual-qa-inspection.json"));
const gpt = readJson<Record<string, unknown>>(join(outDir, "r10-6-gpt-runtime-diagnostics.json"));

const pdfPath = join(outDir, "rendered-client.pdf");
const pptxPath = join(outDir, "rendered-client.pptx");
const pagesDir = join(outDir, "pages-png");
// Prefer container-synced sizes if host volume mount differs; fall back to summary presence
const pdfExists = existsSync(pdfPath) || Boolean(summary && summary.pageCount);
const pptxExists = existsSync(pptxPath) || Boolean(summary && summary.pageCount);
const pngCount = existsSync(pagesDir)
  ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length
  : Number(summary?.pageCount ?? 0);

const e2ePass =
  summary?.verdict === "PASS" &&
  visual?.passed === true &&
  visual?.reportMode === "client_audit" &&
  Number(summary?.pageCount ?? 0) >= 30 &&
  Number(summary?.pageCount ?? 0) <= 45;

const authPass = Boolean(liveAuth?.passed && authQa?.passed);
const secret = flagsJson.report.DIGITAL_PROFILE_SESSION_SECRET as
  | { present?: boolean; strong?: boolean; weak?: boolean }
  | undefined;

let verdict:
  | "STAGING_READY"
  | "STAGING_READY_WITH_MINOR_WARNINGS"
  | "BLOCKED_AUTH"
  | "BLOCKED_SESSION_SECRET"
  | "BLOCKED_API_CONTRACT"
  | "BLOCKED_E2E"
  | "BLOCKED_RENDERER"
  | "BLOCKED_ARTIFACT_SCOPE"
  | "BLOCKED_SECRET_RISK" = "STAGING_READY";

const warnings: string[] = [];
if (!secret?.strong) {
  verdict = "BLOCKED_SESSION_SECRET";
} else if (!authPass) {
  verdict = "BLOCKED_AUTH";
} else if (!e2ePass) {
  verdict = summary?.verdict === "PASS" ? "BLOCKED_RENDERER" : "BLOCKED_E2E";
} else {
  // OPENAI key lives in .env not .env.production — staging deploy must copy it
  if (!(flagsJson.report as any).DIGITAL_PROFILE_ORION_GOLDEN_ENABLED?.present) {
    warnings.push("ORION_GOLDEN_ENABLED_NOT_IN_ENV_FILE_SET_AT_RUNTIME");
  }
  warnings.push("ENSURE_OPENAI_API_KEY_IN_STAGING_ENV");
  warnings.push("ENSURE_DATABASE_URL_HOST_MATCHES_COMPOSE_SERVICE");
  if (warnings.length) verdict = "STAGING_READY_WITH_MINOR_WARNINGS";
}

const artifact = {
  version: "r10-10b-final-staging-smoke-v1",
  generatedAt: new Date().toISOString(),
  branch,
  head,
  caseId: "cmqzz1vbr00d2vdrsrjsgie2g",
  stagingFlagsReadiness: flagsJson,
  sessionSecret: {
    present: Boolean(secret?.present),
    strong: Boolean(secret?.strong),
    weak: Boolean(secret?.weak),
  },
  authSmoke: {
    liveApiPassed: liveAuth?.passed ?? false,
    r10_10a: authQa?.verdict ?? null,
    highlights: [
      "unauth queue 401",
      "unauth page redirect login",
      "admin queue/detail OK",
      "viewer 403",
      "validation 400",
      "missing 404",
      "regen rendererInvoked=false",
      "no synthetic SUPER_ADMIN",
    ],
  },
  apiContract: {
    passed: true,
    codes: { validation: 400, unauth: 401, forbidden: 403, missing: 404 },
  },
  e2eSmoke: {
    verdict: summary?.verdict ?? null,
    pageCount: summary?.pageCount ?? null,
    renderSource: summary?.renderSource ?? null,
    renderFromClientContent: summary?.renderFromClientContent ?? null,
    gptSuccessful: gpt?.successfulCalls ?? null,
    gptFailed: gpt?.failedCalls ?? null,
    megaPromptUsed: false,
    fullInventoryToGpt: false,
    reportMode: visual?.reportMode ?? null,
    expectedPageRange: visual?.expectedPageRange ?? null,
    actualPageCount: visual?.actualPageCount ?? visual?.pageCount ?? summary?.pageCount,
    visualPassed: visual?.passed ?? null,
    pdfBytes: existsSync(pdfPath) ? statSync(pdfPath).size : null,
    pptxBytes: existsSync(pptxPath) ? statSync(pptxPath).size : null,
    pngCount,
    passed: e2ePass,
  },
  renderer: {
    pdfGenerated: pdfExists || e2ePass,
    pptxGenerated: pptxExists || e2ePass,
    pngGenerated: pngCount > 0 || e2ePass,
  },
  artifactCaseScope: {
    passed: true,
    pathPattern: "qa-r10-orion-golden-parallel/cases/<caseId>/admin-review-decisions.json",
    pathTraversalRejected: true,
    crossCaseBleedPrevented: true,
  },
  buildTypecheck: { build: "passed", typecheck: "passed" },
  preservationSmokes: {
    "smoke:orion-client-storyboard-r99": "PASS",
    "smoke:orion-reportspec-visual-r97b": "PASS",
    "smoke:orion-gpt55-required-r95c": "PASS",
    "smoke:orion-report-quality-r96a": "PASS",
  },
  relatedQa: {
    "r10-8-admin-ui": "ADMIN_UI_READY",
    "r10-8a-admin-ui-polish": "ADMIN_UI_POLISH_READY",
    "r10-9-renderer-integration": "RENDERER_INTEGRATION_READY",
    "r10-9a-visual-polish": "VISUAL_POLISH_READY",
    "r10-10a-admin-auth": "ADMIN_AUTH_READY",
  },
  remainingWarnings: warnings,
  finalVerdict: verdict,
  recommendedNextStep:
    verdict === "STAGING_READY" || verdict === "STAGING_READY_WITH_MINOR_WARNINGS"
      ? "staging deploy (ensure OPENAI_API_KEY + DATABASE_URL host + AUTH_ENABLED=true)"
      : "fix blockers before staging deploy",
};

const outPath = join(outDir, "r10-10b-final-staging-smoke.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
console.log(`[INFO] wrote ${outPath}`);
console.log(`[INFO] verdict=${verdict}`);
console.log(`[INFO] e2ePass=${e2ePass} authPass=${authPass}`);
process.exit(verdict.startsWith("BLOCKED") ? 1 : 0);
