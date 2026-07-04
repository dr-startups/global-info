import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import {
  loadRealCaseContext,
  mapCaseDataToMicroStageInputs,
} from "../src/modules/digital-profile/orion-section-pipeline/real-case-data-adapter";

const R93_GPT55_STAGES = [
  "executive_narrative_summary",
  "ru_audit_summary",
  "ru_search_links_overview",
  "uae_audit_summary",
  "compliance_risk_matrix",
  "lexisnexis_profile_overview",
  "compliance_database_summary_for_risk_matrix",
];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function resolveLexisFixturePath(): string | null {
  const candidates = [
    process.env.LEXISNEXIS_FIXTURE_PATH,
    process.env.LEXIS_FIXTURE_PATH,
    join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-r7-4a-real-lexisnexis-docx",
      "fixtures",
      "LexisNexis_Дерипаска.docx"
    ),
  ].filter((x): x is string => Boolean(x && x.trim()));
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function main() {
  const blueprint = loadOrionBlueprint();
  check("blueprint micro-stages >= 64", blueprint.macroSections.flatMap((s) => s.microStages).length >= 64);

  const pipelinePath = join(
    process.cwd(),
    "src",
    "modules",
    "digital-profile",
    "orion-section-pipeline",
    "run-exact-orion-pipeline.ts"
  );
  check("run-exact-orion-pipeline exists", existsSync(pipelinePath));

  const qaScript = join(process.cwd(), "scripts", "qa-r9-3-lexis-gpt55-e2e.ts");
  check("qa-r9-3 script exists", existsSync(qaScript));

  const fixture = resolveLexisFixturePath();
  if (fixture) {
    check("lexis fixture discoverable", true, fixture);
  } else {
    console.log("[WARN] Lexis fixture not found; smoke continues with mapping-only checks.");
  }

  check("R9_3 GPT55 stage list length", R93_GPT55_STAGES.length === 7);

  const caseId = process.env.CASE_ID?.trim();
  if (!caseId) {
    console.log("[WARN] CASE_ID not provided; smoke skips DB-backed mapping checks.");
    process.exit(failures ? 1 : 0);
  }

  const context = await loadRealCaseContext(caseId, { locale: "ru" });
  check("real case subject loaded", Boolean(context.subject.fullName));
  const mapped = mapCaseDataToMicroStageInputs(context, blueprint);
  check(
    "mapped all blueprint micro-stages",
    Object.keys(mapped).length === blueprint.macroSections.flatMap((s) => s.microStages).length
  );
  check(
    "lexis visual mapping contract",
    (mapped.lexisnexis_visual_pages?.lexisEvidence ?? []).every(
      (x) => x.type !== "lexis_visual_page" || Boolean(x.visualRef)
    )
  );
  check(
    "lexis profile overview has import or fallback evidence",
    (mapped.lexisnexis_profile_overview?.lexisEvidence ?? []).length > 0
  );

  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
