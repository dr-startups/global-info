import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const blueprint = loadOrionBlueprint();
  check("R9 blueprint mode", blueprint.mode === "orion_section_pipeline_v1");
  check("R9 blueprint sections >= 8", blueprint.macroSections.length >= 8, String(blueprint.macroSections.length));
  check("R9 render script exists", existsSync(join(process.cwd(), "scripts", "render-r9-manifest-artifacts.py")));

  const out = join(process.cwd(), "storage", "digital-profile", "qa-r9-1-orion-renderer-qa-smoke");
  const result = await runExactOrionPipeline("smoke-r91-case", {
    outputRoot: out,
    locale: "ru",
  });
  check("R9 pipeline composed", result.compositionInspection.errors.length === 0);
  check("R9 pipeline produced internal pages", Number(result.compositionInspection.finalInternalPageCount) > 0);
  check("R9 pipeline produced client pages", Number(result.compositionInspection.finalClientPageCount) > 0);
  check(
    "R9 lexis fallback or visuals present",
    result.compositionInspection.lexisNexisVisualPageCount > 0 ||
      result.slideManifests.some((m) => m.slides.some((s) => s.slideType === "lexisnexis_unavailable_fallback"))
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

