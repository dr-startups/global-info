/**
 * Re-render an existing canary reportRunId without creating new Arsenkin tasks.
 *
 *   npx tsx scripts/rerender-canary-first36.ts <reportRunId> [caseId]
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { readFileSync } from "node:fs";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";

function bootstrapEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";
  process.env.ORION_FIRST36_CEO_MODE = "1";
  process.env.ORION_FIRST36_RUN_SCOPED = "1";
  process.env.ORION_FIRST36_LEGACY_CASEWIDE_FALLBACK = "0";
  process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER = "1";
  process.env.ORION_CLASSIC_CLIENT_FINALIZE = "1";
  process.env.ARSENKIN_ENABLED = "1";
  process.env.ARSENKIN_PILOT_FIXTURES = "0";
  process.env.ARSENKIN_REQUIRED = "1";
  process.env.ARSENKIN_ENRICH_ON_RENDER = "1";
  process.env.ARSENKIN_TOOLS = "check-top,suggest,paa";
}

async function main() {
  bootstrapEnv();
  const reportRunId = process.argv[2]?.trim();
  const caseId = process.argv[3]?.trim() || "cmreamy2t0002o30f29urzcog";
  if (!reportRunId) throw new Error("usage: rerender-canary-first36.ts <reportRunId> [caseId]");
  const outputRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outputRoot, { recursive: true });
  const result = await runOrionClassicAuditRender({
    caseId,
    outputRoot,
    reportRunIdOverride: reportRunId,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== "PASS" || !result.ceoReady) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
