import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCase } from "../src/modules/digital-profile/services/case-service";
import {
  getOrionV2Summary,
  runOrionV2Report,
} from "../src/modules/digital-profile/services/orion-v2-report-service";
import { digitalProfileConfig } from "../src/modules/digital-profile/config";

const OUT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-5-orion-ui-integration"
);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function hasForbidden(text: string): string[] {
  const forbidden = [
    "storageKey",
    "rawPrompt",
    "rawModelResponse",
    "providerInternal",
    "runtimeInternal",
    "C:\\\\",
    "/mnt/",
    "debug",
  ];
  return forbidden.filter((token) => text.toLowerCase().includes(token.toLowerCase()));
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const created = await createCase({
    fullName: `R9.5 ORION UI ${new Date().toISOString().slice(0, 19)}`,
    aliases: ["ORION UI QA"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    targetRegions: ["RU", "UAE"],
    notes: "R9.5 UI integration QA case",
  });
  const caseId = created.id;
  writeFileSync(join(OUT, "qa-case-id.txt"), `${caseId}\n`, "utf-8");

  const run = await runOrionV2Report({
    caseId,
    storeMode: digitalProfileConfig.orionPipelineStore,
    gpt55Validate: false,
    includeInternalArtifacts: true,
  });
  writeJson(join(OUT, "run-record.json"), run);
  check("ORION v2 run id exists", !!run.runId);
  check("run mode is section pipeline", run.reportMode === "orion_section_pipeline_v1");

  const summary = getOrionV2Summary(caseId, "ADMIN");
  writeJson(join(OUT, "summary-admin.json"), summary);
  check("status endpoint simulation returns ok", summary.ok === true);
  check("status endpoint simulation has runId", !!summary.runId);
  check(
    "artifact summary has client fields",
    typeof summary.artifacts.clientPdf.available === "boolean" &&
      typeof summary.artifacts.clientPptx.available === "boolean"
  );

  const safeJson = JSON.stringify(summary);
  const forbiddenHits = hasForbidden(safeJson);
  writeJson(join(OUT, "client-safety-inspection.json"), {
    forbiddenHits,
    safe: forbiddenHits.length === 0,
  });
  check("summary is client-safe", forbiddenHits.length === 0, forbiddenHits.join(", "));

  const ru = readFileSync(
    join(process.cwd(), "src/modules/digital-profile/i18n/dictionaries/ru.ts"),
    "utf-8"
  );
  const en = readFileSync(
    join(process.cwd(), "src/modules/digital-profile/i18n/dictionaries/en.ts"),
    "utf-8"
  );
  const ruOrionLabels = ru
    .split("\n")
    .filter((line) => line.includes("orionV2"))
    .join("\n")
    .toLowerCase();
  const enOrionLabels = en
    .split("\n")
    .filter((line) => line.includes("orionV2"))
    .join("\n")
    .toLowerCase();
  const labelForbidden = ["mock", "provider", "runtime", "storage/", "c:\\\\"];
  const labelHits = labelForbidden.filter(
    (token) => ruOrionLabels.includes(token) || enOrionLabels.includes(token)
  );
  check("ORION UI labels avoid forbidden words", labelHits.length === 0, labelHits.join(", "));

  const generateRoute = await import(
    "../src/app/api/digital-profile/cases/[id]/report/generate/route"
  );
  const renderRoute = await import(
    "../src/app/api/digital-profile/cases/[id]/report/render/route"
  );
  check("existing report generate route compiles", typeof generateRoute.POST === "function");
  check("existing report render route compiles", typeof renderRoute.POST === "function");

  writeJson(join(OUT, "qa-summary.json"), {
    status: failures ? "BLOCKED" : "PASS",
    failures,
    caseId,
    runId: run.runId,
  });

  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

