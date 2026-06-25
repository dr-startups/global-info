/**
 * Smoke test for Stage M2 health checks — no dev server, no DB required.
 *
 * Exercises the Prisma-free health primitives (storage round-trip, renderer
 * ping, compose logic). The full DB-backed endpoint is covered in Manual QA via
 * GET /api/digital-profile/health. With the renderer running (smoke:all:with-
 * renderer) the renderer check is expected to be "ok".
 *
 * Run:  npm run smoke:health   (uses tsx)
 */

import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dp-smoke-health-"));
  process.env.DIGITAL_PROFILE_STORAGE_DRIVER = "local";
  process.env.DIGITAL_PROFILE_STORAGE_ROOT = tmpRoot;

  const { checkStorageHealth, checkRendererHealth, composeHealth } = await import(
    "../src/modules/digital-profile/services/health-checks"
  );

  // 2. storage health ok (real round-trip in the temp root).
  const storage = await checkStorageHealth();
  check("storage health ok", storage === "ok", storage);

  // 3 + 4. renderer ping is handled gracefully whether up or down.
  const renderer = await checkRendererHealth(1500);
  check(
    "renderer status handled (ok | unavailable)",
    renderer === "ok" || renderer === "unavailable",
    renderer
  );
  if (process.env.DP_SMOKE_EXPECT_RENDERER === "1") {
    check("renderer health ok when running", renderer === "ok", renderer);
  } else if (renderer === "ok") {
    console.log("[INFO] renderer reachable — health ok");
  } else {
    console.log("[INFO] renderer not running — 'unavailable' handled");
  }

  // 1. Node health compose: ok requires database + storage healthy; renderer non-fatal.
  const downRenderer = composeHealth({
    database: "ok",
    storage,
    renderer: "unavailable",
    authEnabled: false,
  });
  check(
    "compose: renderer down does not fail overall when db+storage ok",
    downRenderer.ok === (storage === "ok") && downRenderer.service === "digital-profile"
  );

  const dbDown = composeHealth({
    database: "error",
    storage: "ok",
    renderer: "ok",
    authEnabled: true,
  });
  check("compose: db down fails overall", dbDown.ok === false);

  const allOk = composeHealth({
    database: "ok",
    storage: "ok",
    renderer: "ok",
    authEnabled: true,
  });
  check("compose: all ok -> ok true + authEnabled passthrough", allOk.ok === true && allOk.authEnabled === true);

  rmSync(tmpRoot, { recursive: true, force: true });

  console.log("");
  if (failures > 0) {
    console.error(`smoke:health FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("smoke:health OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
