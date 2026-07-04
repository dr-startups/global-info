import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCase } from "../src/modules/digital-profile/services/case-service";
import { runFullAudit } from "../src/modules/digital-profile/services/agent-run-service";
import { importLexisNexisHybridReport } from "../src/modules/digital-profile/compliance-providers/service";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-2-orion-real-case-bridge");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function runInspect(pptx: string, reportJson: string, outPath: string): number {
  const result = spawnSync("python", ["scripts/inspect-0541-pptx.py", pptx, reportJson], {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  const match = out.match(/\{[\s\S]*\}/);
  if (match) {
    writeFileSync(outPath, `${match[0]}\n`, "utf-8");
  } else {
    writeFileSync(outPath, JSON.stringify({ r9ModeDetected: false, raw: out }, null, 2), "utf-8");
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return result.status ?? 1;
}

function resolveLexisFixturePath(): string | null {
  const candidates = [
    process.env.LEXIS_FIXTURE_PATH,
    join(process.cwd(), "storage", "digital-profile", "fixtures", "lexisnexis-sample.docx"),
    join(process.cwd(), "storage", "digital-profile", "fixtures", "lexis-sample.docx"),
  ].filter((x): x is string => Boolean(x && x.trim()));
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function ensureCaseId(): Promise<string> {
  if (process.env.CASE_ID && process.env.CASE_ID.trim()) {
    return process.env.CASE_ID.trim();
  }
  const created = await createCase({
    fullName: `R9.2 QA Subject ${new Date().toISOString().slice(0, 19)}`,
    aliases: ["Konstantin Tomilin"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    notes: "R9.2 non-destructive QA case",
  });
  return created.id;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const caseId = await ensureCaseId();
  writeFileSync(join(OUT, "qa-case-id.txt"), `${caseId}\n`, "utf-8");

  try {
    const fullAudit = await runFullAudit(caseId, { actorId: "qa-r9-2" }, { runtimeMode: "real_first_with_fallback" });
    writeFileSync(
      join(OUT, "full-audit-runtime.json"),
      JSON.stringify(
        {
          outcome: fullAudit.outcome,
          runtimeStrategy: fullAudit.runtimeStrategy,
          runSummary: fullAudit.runSummary,
        },
        null,
        2
      ),
      "utf-8"
    );
    check("full audit executed", true, fullAudit.outcome);
  } catch (error) {
    check("full audit executed", false, error instanceof Error ? error.message : String(error));
  }

  const fixture = resolveLexisFixturePath();
  if (fixture) {
    try {
      const file = readFileSync(fixture);
      const imported = await importLexisNexisHybridReport(
        caseId,
        { fileName: "lexis-r92-fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: file },
        { actorId: "qa-r9-2" }
      );
      writeFileSync(join(OUT, "lexis-import.json"), JSON.stringify(imported, null, 2), "utf-8");
      check("lexis fixture import", true, `signals=${imported.parsedSignalsCreated}`);
    } catch (error) {
      check("lexis fixture import", false, error instanceof Error ? error.message : String(error));
    }
  } else {
    console.log("[WARN] Lexis fixture not found; running without fixture import.");
  }

  const pipeline = await runExactOrionPipeline(caseId, {
    outputRoot: OUT,
    locale: "ru",
    useRealCaseData: true,
  });
  check("pipeline composed", pipeline.compositionInspection.errors.length === 0);

  const required = [
    "run-manifest.json",
    "blueprint.json",
    "real-case-context-inspection.json",
    "micro-stage-mapping-inspection.json",
    "composed/final-deck-manifest.json",
    "composed/final-report-json-internal.json",
    "composed/final-report-json-client.json",
    "composed/final-report-v17-ru-internal-draft.pptx",
    "composed/final-report-v17-ru-internal-draft.pdf",
    "composed/final-report-v17-ru-client.pptx",
    "composed/final-report-v17-ru-client.pdf",
    "composed/composition-inspection.json",
    "composed/consistency-inspection.json",
    "composed/client-policy-inspection.json",
    "composed/r7-r9-comparison-inspection.json",
  ];
  for (const rel of required) {
    check(`${rel} exists`, existsSync(join(OUT, rel)));
  }
  for (const key of ["ru_search_links_overview", "uae_google_search_links_overview", "lexisnexis_profile_overview", "lexisnexis_visual_pages"]) {
    const dir = join(OUT, "micro-stages", key);
    check(`${key}/raw-evidence.json`, existsSync(join(dir, "raw-evidence.json")));
    check(`${key}/evidence-pack.json`, existsSync(join(dir, "evidence-pack.json")));
    check(`${key}/final-analysis.json`, existsSync(join(dir, "final-analysis.json")));
    check(`${key}/slide-manifest.json`, existsSync(join(dir, "slide-manifest.json")));
  }

  const inspectInternal = runInspect(
    join(OUT, "composed", "final-report-v17-ru-internal-draft.pptx"),
    join(OUT, "composed", "final-report-json-internal.json"),
    join(OUT, "composed", "r9-inspect-internal.json")
  );
  check("R9 inspect internal", inspectInternal === 0, `rc=${inspectInternal}`);

  const inspectClient = runInspect(
    join(OUT, "composed", "final-report-v17-ru-client.pptx"),
    join(OUT, "composed", "final-report-json-client.json"),
    join(OUT, "composed", "r9-inspect-client.json")
  );
  check("R9 inspect client", inspectClient === 0, `rc=${inspectClient}`);

  writeFileSync(
    join(OUT, "qa-summary.json"),
    JSON.stringify(
      {
        status: failures ? "BLOCKED" : "PASS",
        caseId,
        runId: pipeline.run.runId,
        output: OUT,
        failures,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

