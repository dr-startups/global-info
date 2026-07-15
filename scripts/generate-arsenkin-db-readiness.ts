/**
 * Generate arsenkin-db-readiness.json from real test/staging checks.
 * Thin CLI wrapper around arsenkin-db-readiness-service.
 */

import { runArsenkinDbReadiness } from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness-service";

async function main() {
  const result = await runArsenkinDbReadiness({ forCli: true });
  console.log(
    JSON.stringify(
      {
        outPath: result.artifactPath,
        verdict: result.verdict,
        readinessCode: result.readinessCode,
        blockers: result.blockers,
        fingerprint: result.fingerprint,
        environment: result.environment,
        buildCommit: result.buildCommit,
        networkCalls: result.networkCalls,
        fatalError: result.fatalError ?? null,
        skippedReason: result.skippedReason ?? null,
      },
      null,
      2
    )
  );
  if (result.verdict !== "PASS" && result.verdict !== "SKIPPED") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
