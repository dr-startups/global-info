import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildDeterministicMicrostageAnalysis } from "../src/modules/digital-profile/orion-section-pipeline/deterministic-microstage-analysis";
import { buildMicroStageEvidencePack } from "../src/modules/digital-profile/orion-section-pipeline/evidence-pack-builder";
import { analyzeMicroStageWithGpt55 } from "../src/modules/digital-profile/orion-section-pipeline/gpt55-microstage-analyzer";
import { composeFinalDeckManifest } from "../src/modules/digital-profile/orion-section-pipeline/deck-composer";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import { buildMicroStageSlideManifest } from "../src/modules/digital-profile/orion-section-pipeline/slide-manifest-builder";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const blueprint = loadOrionBlueprint();
  check("ORION blueprint loads", blueprint.mode === "orion_section_pipeline_v1");

  const sectionKeys = blueprint.macroSections.map((x) => x.macroSectionKey);
  check("Required macro section: executive", sectionKeys.includes("executive"));
  check("Required macro section: ru_profile", sectionKeys.includes("ru_profile"));
  check("Required macro section: uae_profile", sectionKeys.includes("uae_profile"));
  check("Required macro section: compliance_databases", sectionKeys.includes("compliance_databases"));
  check("Required macro section: offer", sectionKeys.includes("offer"));
  check("Required macro section: about", sectionKeys.includes("about"));

  const allStages = blueprint.macroSections.flatMap((x) => x.microStages);
  check("Micro-stage count > 40", allStages.length > 40, String(allStages.length));
  check(
    "Micro-stage order deterministic",
    allStages.every((stage, idx, arr) => idx === 0 || stage.order >= arr[idx - 1]!.order)
  );

  const sample = allStages.find((x) => x.microStageKey === "ru_search_links_overview") ?? allStages[0]!;
  const packed = buildMicroStageEvidencePack({
    microStage: sample,
    subject: { fullName: "Иван Иванов", aliases: [] },
    locale: "ru",
    region: "RU",
    rawEvidence: [
      {
        evidenceId: "e-1",
        type: "search_result",
        source: "google",
        title: "Example adverse article",
        snippet: "Possible adverse signal",
        domain: "example.com",
        url: "https://example.com/adverse",
        classification: "requires_review",
        themeLabel: "Негативные публикации",
      },
    ],
  });
  check("Evidence pack builder works", packed.evidencePack.topResults.length === 1);

  const fallback = buildDeterministicMicrostageAnalysis({
    microStage: sample,
    evidencePack: packed.evidencePack,
  });
  check("Deterministic fallback works", fallback.generatedBy === "deterministic");

  const gpt = await analyzeMicroStageWithGpt55({ microStage: sample, evidencePack: packed.evidencePack });
  if (!process.env.OPENAI_API_KEY) {
    check("GPT path skipped safely without API key", gpt.diagnostics.status === "fallback", gpt.diagnostics.reason ?? "");
  } else {
    check("GPT path executed when API key present", gpt.diagnostics.provider === "openai");
  }

  const manifest = buildMicroStageSlideManifest({
    microStage: sample,
    analysis: gpt.analysis,
  });
  check("Slide manifest generated", manifest.slides.length > 0);

  const composed = composeFinalDeckManifest({
    runId: "smoke-r90",
    blueprint,
    slideManifests: [manifest],
  });
  check("Final deck manifest composed", composed.finalManifest.sections.length > 0);
  check("TOC page numbers computed", composed.finalManifest.tocEntries.every((x) => x.page > 0));
  check("Client sanitizer strips internal-only slides", composed.clientSlides.every((x) => !x.internalOnly));

  const filesExist = [
    "src/modules/digital-profile/orion-section-pipeline/orion-blueprint.ts",
    "src/modules/digital-profile/orion-section-pipeline/types.ts",
    "src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline.ts",
  ];
  for (const rel of filesExist) {
    check(`${rel} exists`, existsSync(join(process.cwd(), rel)));
  }

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

