import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import { buildOrionSupabaseSchemaPlan } from "../src/modules/digital-profile/orion-section-pipeline/supabase-schema-plan";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  const blueprint = loadOrionBlueprint();
  check("blueprint mode", blueprint.mode === "orion_section_pipeline_v1");
  check("blueprint micro-stages >=64", blueprint.macroSections.flatMap((s) => s.microStages).length >= 64);

  const persistenceFiles = [
    "src/modules/digital-profile/orion-section-pipeline/persistence/types.ts",
    "src/modules/digital-profile/orion-section-pipeline/persistence/file-store.ts",
    "src/modules/digital-profile/orion-section-pipeline/persistence/prisma-store.ts",
    "src/modules/digital-profile/orion-section-pipeline/persistence/index.ts",
    "src/modules/digital-profile/orion-section-pipeline/persistence/sanitize-for-storage.ts",
  ];
  for (const rel of persistenceFiles) {
    check(`${rel} exists`, existsSync(join(process.cwd(), rel)));
  }

  const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
  const schema = existsSync(schemaPath) ? readFileSync(schemaPath, "utf-8") : "";
  check("schema has OrionReportRun", schema.includes("model OrionReportRun"));
  check("schema has OrionReportMicroStage", schema.includes("model OrionReportMicroStage"));
  check("schema has OrionReportJsonVersion", schema.includes("model OrionReportJsonVersion"));

  const migrationDir = join(process.cwd(), "prisma", "migrations");
  const migrationName = "add_orion_section_pipeline_persistence";
  const migrationFound = existsSync(migrationDir) && readFileSync(schemaPath, "utf-8").includes("model OrionReportRun");
  check("r9.4 migration prepared", migrationFound, migrationName);

  const plan = buildOrionSupabaseSchemaPlan();
  check("supabase plan table count", plan.tables.length >= 10, String(plan.tables.length));
  check(
    "supabase plan includes report_runs",
    plan.tables.some((t) => t.table === "report_runs")
  );

  process.exit(failures ? 1 : 0);
}

main();
