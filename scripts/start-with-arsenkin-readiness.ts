/**
 * Railway/runtime startup: run Arsenkin DB readiness in the app container, then `next start`.
 * Avoids `start:railway -> start -> start:railway` recursion by spawning next directly.
 */

import { spawn } from "node:child_process";
import {
  runArsenkinDbReadiness,
  shouldRunStartupDbReadiness,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness-service";

async function main() {
  if (shouldRunStartupDbReadiness(process.env)) {
    console.error("[arsenkin-startup] Running DB readiness before web server…");
    const result = await runArsenkinDbReadiness();
    console.error(
      JSON.stringify(
        {
          verdict: result.verdict,
          readinessCode: result.readinessCode,
          blockers: result.blockers,
          artifactPath: result.artifactPath,
          buildCommit: result.buildCommit,
          environment: result.environment,
          networkCalls: result.networkCalls,
        },
        null,
        2
      )
    );
    if (result.verdict !== "PASS" || result.readinessCode !== "READINESS_PASS") {
      console.error(
        "[arsenkin-startup] DB readiness FAIL — starting web server with Arsenkin fail-closed gate."
      );
    } else {
      console.error("[arsenkin-startup] DB readiness PASS — starting web server.");
    }
  } else {
    console.error("[arsenkin-startup] DB readiness skipped (integration not required).");
  }

  const port = process.env.PORT ?? "3000";
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", port], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  // Auto-resume FAILED_RETRYABLE / WAITING_PROVIDER Full jobs after deploy.
  // Runs in this Node process (outside Next instrumentation webpack graph).
  setTimeout(() => {
    void import("../src/modules/digital-profile/providers/arsenkin/full-audit-orchestrator")
      .then(({ resumeActiveArsenkinOrchestrations }) => {
        console.error("[arsenkin-startup] Resuming active/retryable Full orchestrations…");
        resumeActiveArsenkinOrchestrations();
      })
      .catch((err) => {
        console.error(
          "[arsenkin-startup] Orchestration resume skipped:",
          err instanceof Error ? err.message : err
        );
      });
    void import("../src/modules/digital-profile/services/unified-orion-collection-orchestrator")
      .then(({ resumeUnifiedCollectionsOnStartup }) => {
        console.error("[unified-startup] Bounded resume of unified collection jobs…");
        resumeUnifiedCollectionsOnStartup();
      })
      .catch(() => undefined);
  }, 1500);

  child.on("error", (err) => {
    console.error("[arsenkin-startup] Failed to spawn next start:", err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[arsenkin-startup] next start killed by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
