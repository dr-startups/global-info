/**
 * Live First36 CEO classic audit render against local DB case.
 *
 *   npx tsx scripts/run-first36-live-render.ts [caseId]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";

function bootstrapEnv(): void {
  process.env.DATABASE_URL ??=
    process.env.R10_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/global_info?schema=public";
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";
  process.env.ORION_FIRST36_CEO_MODE = "1";
  process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER = "1";
  if (!process.env.ORION_CLIENT_PRODUCTION_FINALIZE) {
    process.env.ORION_CLIENT_PRODUCTION_FINALIZE = "0";
  }
}

const caseId =
  process.argv[2]?.trim() ||
  process.env.CASE_ID?.trim() ||
  process.env.GLINKA_CASE_ID?.trim() ||
  (() => {
    try {
      const p = join(process.cwd(), "storage", "digital-profile", "glinka-case-id.txt");
      if (existsSync(p)) return readFileSync(p, "utf-8").trim() || undefined;
    } catch {
      /* ignore */
    }
    return undefined;
  })() ||
  "cmqzz1vbr00d2vdrsrjsgie2g";

async function main() {
  bootstrapEnv();
  const outputRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-live-render",
    caseId,
    String(Date.now())
  );

  console.log(
    JSON.stringify(
      {
        caseId,
        outputRoot,
        ORION_CLASSIC_AUDIT_MODE: process.env.ORION_CLASSIC_AUDIT_MODE,
        ORION_FIRST36_CEO_MODE: process.env.ORION_FIRST36_CEO_MODE,
        ORION_GOLDEN_FORCE_LOCAL_RENDER: process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER,
      },
      null,
      2
    )
  );

  const result = await runOrionClassicAuditRender({ caseId, outputRoot });
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== "PASS") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
