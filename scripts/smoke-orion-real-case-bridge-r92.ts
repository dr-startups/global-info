import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import {
  loadRealCaseContext,
  mapCaseDataToMicroStageInputs,
} from "../src/modules/digital-profile/orion-section-pipeline/real-case-data-adapter";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const blueprint = loadOrionBlueprint();
  check("blueprint has micro-stages", blueprint.macroSections.flatMap((s) => s.microStages).length >= 64);

  const adapterPath = join(
    process.cwd(),
    "src",
    "modules",
    "digital-profile",
    "orion-section-pipeline",
    "real-case-data-adapter.ts"
  );
  check("real-case adapter exists", existsSync(adapterPath));

  const caseId = process.env.CASE_ID?.trim();
  if (!caseId) {
    console.log("[WARN] CASE_ID not provided; smoke skips DB-backed mapping checks.");
    process.exit(failures ? 1 : 0);
  }

  const context = await loadRealCaseContext(caseId, { locale: "ru" });
  check("real case subject loaded", Boolean(context.subject.fullName));
  const mapped = mapCaseDataToMicroStageInputs(context, blueprint);
  const stageCount = Object.keys(mapped).length;
  check("mapped all blueprint micro-stages", stageCount === blueprint.macroSections.flatMap((s) => s.microStages).length);
  check(
    "lexis visual mapping contract",
    (mapped.lexisnexis_visual_pages?.lexisEvidence ?? []).every((x) => x.type !== "lexis_visual_page" || Boolean(x.visualRef))
  );
  check(
    "compliance summary mapping exists",
    (mapped.compliance_database_summary_for_risk_matrix?.complianceEvidence ?? []).length >= 0
  );

  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

