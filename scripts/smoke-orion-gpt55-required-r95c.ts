import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeOrionV2AiReadiness,
  digitalProfileConfig,
} from "../src/modules/digital-profile/config";
import { ORION_V2_GPT_REQUIRED_MICRO_STAGES } from "../src/modules/digital-profile/orion-section-pipeline/ai-required-stages";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function file(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8");
}

function main() {
  // --- Config flags exist ---
  const configText = file("src/modules/digital-profile/config.ts");
  check(
    "config exposes DIGITAL_PROFILE_ORION_V2_REQUIRE_AI",
    configText.includes("DIGITAL_PROFILE_ORION_V2_REQUIRE_AI")
  );
  check(
    "config exposes DIGITAL_PROFILE_ORION_V2_ALLOW_DETERMINISTIC_FALLBACK",
    configText.includes("DIGITAL_PROFILE_ORION_V2_ALLOW_DETERMINISTIC_FALLBACK")
  );
  check(
    "config reads DIGITAL_PROFILE_AI_ANALYST_ENABLED",
    configText.includes("DIGITAL_PROFILE_AI_ANALYST_ENABLED")
  );
  check(
    "config default model gpt-5.5",
    configText.includes('"gpt-5.5"')
  );
  check(
    "config exposes describeOrionV2AiReadiness",
    configText.includes("export function describeOrionV2AiReadiness")
  );

  // --- Readiness returns safe booleans only, never the key value ---
  const readiness = describeOrionV2AiReadiness();
  const keys = Object.keys(readiness).sort();
  check(
    "readiness exposes only safe fields",
    keys.join(",") ===
      ["aiEnabled", "fallbackAllowed", "hasOpenAiKey", "model", "provider", "ready", "requireAi"].join(","),
    keys.join(",")
  );
  check("readiness.hasOpenAiKey is boolean", typeof readiness.hasOpenAiKey === "boolean");
  check("readiness.requireAi is boolean", typeof readiness.requireAi === "boolean");
  check("readiness.fallbackAllowed is boolean", typeof readiness.fallbackAllowed === "boolean");
  const readinessJson = JSON.stringify(readiness);
  const actualKey = process.env.OPENAI_API_KEY?.trim();
  check(
    "no OPENAI_API_KEY value leaked in readiness",
    !actualKey || !readinessJson.includes(actualKey)
  );
  // Never print the key value itself anywhere in this smoke.
  check("readiness omits raw key field", !("openAiApiKey" in (readiness as unknown as Record<string, unknown>)));

  // --- Required GPT micro-stages defined ---
  check(
    "ai-required-stages file exists",
    existsSync(join(process.cwd(), "src/modules/digital-profile/orion-section-pipeline/ai-required-stages.ts"))
  );
  for (const key of [
    "executive_narrative_summary",
    "compliance_risk_matrix",
    "lexisnexis_profile_overview",
    "compliance_database_summary_for_risk_matrix",
    "ru_audit_summary",
    "uae_audit_summary",
  ]) {
    check(`required stages include ${key}`, ORION_V2_GPT_REQUIRED_MICRO_STAGES.includes(key));
  }
  check(
    "required stages count reasonable",
    ORION_V2_GPT_REQUIRED_MICRO_STAGES.length >= 20,
    String(ORION_V2_GPT_REQUIRED_MICRO_STAGES.length)
  );

  // --- Route AI gate wired ---
  const routeText = file("src/app/api/digital-profile/cases/[id]/report/orion-v2/route.ts");
  check("route contains ORION_V2_AI_REQUIRED gate", routeText.includes("ORION_V2_AI_REQUIRED"));
  check("route checks readiness before generation", routeText.includes("getOrionV2AiReadiness"));
  check(
    "route uses requireAi config",
    routeText.includes("orionV2RequireAi")
  );

  // --- Pipeline enforcement wired ---
  const pipelineText = file(
    "src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline.ts"
  );
  check("pipeline supports requireAiAnalysis", pipelineText.includes("requireAiAnalysis"));
  check(
    "pipeline supports allowDeterministicFallback",
    pipelineText.includes("allowDeterministicFallback")
  );
  check(
    "pipeline emits BLOCKED for missing GPT",
    pipelineText.includes('"BLOCKED"') && pipelineText.includes("deterministicRequiredStages")
  );
  check(
    "pipeline supports PASS_WITH_DETERMINISTIC_FALLBACK",
    pipelineText.includes("PASS_WITH_DETERMINISTIC_FALLBACK")
  );

  // --- Deterministic fallback path still exists (not removed) ---
  check(
    "deterministic analyzer still present",
    existsSync(
      join(process.cwd(), "src/modules/digital-profile/orion-section-pipeline/deterministic-microstage-analysis.ts")
    )
  );

  // --- Sanity: config flag types ---
  check(
    "orionV2RequireAi is boolean",
    typeof digitalProfileConfig.orionV2RequireAi === "boolean"
  );
  check(
    "orionV2AllowDeterministicFallback is boolean",
    typeof digitalProfileConfig.orionV2AllowDeterministicFallback === "boolean"
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();
