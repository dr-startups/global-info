import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOrionSupabaseSchemaPlan } from "../src/modules/digital-profile/orion-section-pipeline/supabase-schema-plan";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-0-exact-orion-section-pipeline");
const SEED_DIR = join(process.cwd(), "storage", "digital-profile", "qa-r8-3-gpt55-analyst-narrative");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const seedJsonPath = join(SEED_DIR, "report-json-ru-internal.json");
  const seedJson = existsSync(seedJsonPath)
    ? (readJson(seedJsonPath) as Record<string, unknown>)
    : ({ subject: { fullName: "Unknown subject" } } as Record<string, unknown>);

  const pipeline = await runExactOrionPipeline("qa-r9-0-case", {
    outputRoot: OUT,
    locale: "ru",
    reportJsonSeed: seedJson,
    renderSeedArtifactsFrom: SEED_DIR,
  });

  const schemaPlan = buildOrionSupabaseSchemaPlan();
  writeFileSync(join(OUT, "supabase-schema-plan.json"), JSON.stringify(schemaPlan, null, 2), "utf-8");

  check("run-manifest.json created", existsSync(join(OUT, "run-manifest.json")));
  check("blueprint.json created", existsSync(join(OUT, "blueprint.json")));
  check("composed/final-deck-manifest.json created", existsSync(join(OUT, "composed", "final-deck-manifest.json")));
  check("composed/final-report-json-internal.json created", existsSync(join(OUT, "composed", "final-report-json-internal.json")));
  check("composed/final-report-json-client.json created", existsSync(join(OUT, "composed", "final-report-json-client.json")));
  check("composed/composition-inspection.json created", existsSync(join(OUT, "composed", "composition-inspection.json")));
  check("composed/consistency-inspection.json created", existsSync(join(OUT, "composed", "consistency-inspection.json")));
  check("composed/client-policy-inspection.json created", existsSync(join(OUT, "composed", "client-policy-inspection.json")));

  const requiredMicroStages = [
    "executive_narrative_summary",
    "ru_search_links_overview",
    "ru_top20_serp_matrix",
    "uae_google_top20_serp_matrix",
    "lexisnexis_visual_pages",
    "how_to_start",
  ];
  for (const key of requiredMicroStages) {
    const stageDir = join(OUT, "micro-stages", key);
    check(`${key}/evidence-pack.json`, existsSync(join(stageDir, "evidence-pack.json")));
    check(`${key}/final-analysis.json`, existsSync(join(stageDir, "final-analysis.json")));
    check(`${key}/slide-manifest.json`, existsSync(join(stageDir, "slide-manifest.json")));
  }

  check(
    "composed final internal pptx exists",
    existsSync(join(OUT, "composed", "final-report-v17-ru-internal-draft.pptx"))
  );
  check(
    "composed final internal pdf exists",
    existsSync(join(OUT, "composed", "final-report-v17-ru-internal-draft.pdf"))
  );
  check(
    "composed final client pptx exists",
    existsSync(join(OUT, "composed", "final-report-v17-ru-client.pptx"))
  );
  check(
    "composed final client pdf exists",
    existsSync(join(OUT, "composed", "final-report-v17-ru-client.pdf"))
  );

  const composition = readJson(join(OUT, "composed", "composition-inspection.json")) as {
    finalInternalPageCount?: number;
    finalClientPageCount?: number;
    missingMicroStages?: string[];
  };
  check("No missing micro-stages in composition", (composition.missingMicroStages ?? []).length === 0);
  check("Internal page count computed", Number(composition.finalInternalPageCount ?? 0) > 0);
  check("Client page count computed", Number(composition.finalClientPageCount ?? 0) > 0);

  const consistency = readJson(join(OUT, "composed", "consistency-inspection.json")) as {
    status?: string;
  };
  check("Consistency check passes", String(consistency.status ?? "") === "PASS");

  const policy = readJson(join(OUT, "composed", "client-policy-inspection.json")) as {
    status?: string;
  };
  check("Client policy inspection passes", String(policy.status ?? "") === "PASS");

  check(
    "Supabase schema plan written",
    existsSync(join(OUT, "supabase-schema-plan.json")),
    `${schemaPlan.tables.length} planned tables`
  );

  const summary = {
    status: failures > 0 ? "BLOCKED" : "PASS",
    outputRoot: OUT,
    runId: pipeline.run.runId,
    checksFailed: failures,
  };
  writeFileSync(join(OUT, "qa-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

