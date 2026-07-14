/**
 * Legacy live canary entrypoint — hard-blocked.
 * Use scripts/arsenkin-canonical-live-runner.ts instead.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = {
  entrypoint: "scripts/canary-arsenkin-first36.ts",
  status: "HARD_FAIL",
  reason: "legacy-live-entrypoint-disabled",
  redirect: "scripts/arsenkin-canonical-live-runner.ts",
  networkCalls: 0,
  tokenPresent: Boolean(String(process.env.ARSENKIN_API_TOKEN ?? "").trim()),
  arsenkinEnabled: process.env.ARSENKIN_ENABLED === "1",
  note: "Presence of ARSENKIN_API_TOKEN is not sufficient for live spend.",
};

const dir = join(process.cwd(), "storage", "digital-profile", "qa-first36-canary", "_legacy-blocks");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "canary-arsenkin-first36-block.json"), `${JSON.stringify(out, null, 2)}\n`);
console.error(JSON.stringify(out, null, 2));
process.exit(2);
