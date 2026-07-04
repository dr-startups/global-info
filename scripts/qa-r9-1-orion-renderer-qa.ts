import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-1-orion-renderer-qa");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
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
    writeFileSync(
      outPath,
      JSON.stringify({ r9ModeDetected: false, warnings: ["inspect output summary json not found"], raw: out }, null, 2),
      "utf-8"
    );
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return result.status ?? 1;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const result = await runExactOrionPipeline("qa-r9-1-case", {
    outputRoot: OUT,
    locale: "ru",
    renderMode: "manifest_renderer_v1",
  });

  const required = [
    "run-manifest.json",
    "blueprint.json",
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
  ];
  for (const rel of required) {
    check(`${rel} exists`, existsSync(join(OUT, rel)));
  }
  const internalPagesDir = join(OUT, "composed", "pages-pdf");
  const clientPagesDir = join(OUT, "composed", "client-pages-pdf");
  check("composed/pages-pdf exists", existsSync(internalPagesDir));
  check("composed/client-pages-pdf exists", existsSync(clientPagesDir));

  for (const key of ["executive_narrative_summary", "ru_search_links_overview", "lexisnexis_visual_pages", "how_to_start"]) {
    const stage = join(OUT, "micro-stages", key);
    check(`${key}/evidence-pack.json`, existsSync(join(stage, "evidence-pack.json")));
    check(`${key}/final-analysis.json`, existsSync(join(stage, "final-analysis.json")));
    check(`${key}/slide-manifest.json`, existsSync(join(stage, "slide-manifest.json")));
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

  check("r9-inspect-internal.json exists", existsSync(join(OUT, "composed", "r9-inspect-internal.json")));
  check("r9-inspect-client.json exists", existsSync(join(OUT, "composed", "r9-inspect-client.json")));

  const composition = readJson<{ missingMicroStages?: unknown[]; internalPageCount?: number; clientPageCount?: number }>(
    join(OUT, "composed", "composition-inspection.json")
  );
  check("No missing micro stages", (composition.missingMicroStages ?? []).length === 0);
  check("Internal page count > 0", Number(composition.internalPageCount ?? 0) > 0);
  check("Client page count > 0", Number(composition.clientPageCount ?? 0) > 0);

  const consistency = readJson<{ status?: string }>(join(OUT, "composed", "consistency-inspection.json"));
  check("Consistency inspection pass", String(consistency.status ?? "") === "PASS");
  const policy = readJson<{ status?: string }>(join(OUT, "composed", "client-policy-inspection.json"));
  check("Client policy inspection pass", String(policy.status ?? "") === "PASS");

  writeFileSync(
    join(OUT, "qa-summary.json"),
    JSON.stringify(
      {
        status: failures ? "BLOCKED" : "PASS",
        runId: result.run.runId,
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

