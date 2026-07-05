import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeMetricCards,
  normalizeSlideTableRows,
  scanClientReportText,
} from "../src/modules/digital-profile/orion-section-pipeline/client-slide-contract";
import { buildDeterministicMicrostageAnalysis } from "../src/modules/digital-profile/orion-section-pipeline/deterministic-microstage-analysis";
import { buildMicroStageEvidencePack } from "../src/modules/digital-profile/orion-section-pipeline/evidence-pack-builder";
import { loadOrionBlueprint } from "../src/modules/digital-profile/orion-section-pipeline/orion-blueprint";
import { buildMicroStageSlideManifest } from "../src/modules/digital-profile/orion-section-pipeline/slide-manifest-builder";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const contractText = readFileSync(
    join(process.cwd(), "src/modules/digital-profile/orion-section-pipeline/client-slide-contract.ts"),
    "utf-8"
  );
  check("client-slide-contract exists", contractText.includes("scanClientReportText"));
  check("renderer row fallback removed", !readFileSync(join(process.cwd(), "renderer/report_template_v3.py"), "utf-8").includes('or "row"'));
  check("ORION_STATIC removed from adapter", !readFileSync(join(process.cwd(), "src/modules/digital-profile/orion-section-pipeline/real-case-data-adapter.ts"), "utf-8").includes('"ORION_STATIC"'));

  const blueprint = loadOrionBlueprint();
  const lexisStage = blueprint.macroSections
    .flatMap((s) => s.microStages)
    .find((s) => s.microStageKey === "lexisnexis_profile_overview");
  check("lexis overview stage exists", Boolean(lexisStage));
  if (lexisStage) {
    const pack = buildMicroStageEvidencePack({
      microStage: lexisStage,
      subject: { fullName: "Test Subject" },
      locale: "ru",
      region: "RU",
      rawEvidence: [
        {
          evidenceId: "lexis-1",
          type: "lexis_signal",
          source: "LEXISNEXIS",
          title: "Sanctions match",
          snippet: "Official watchlist record requires EDD.",
          classification: "requires_review",
          themeLabel: "Sanctions / watchlist",
        },
      ],
    });
    const analysis = buildDeterministicMicrostageAnalysis({ microStage: lexisStage, evidencePack: pack.evidencePack });
    check("lexis deterministic summary mentions screening", /комплаенс-скрининга/i.test(analysis.clientNarrative.plainConclusion));
    const manifest = buildMicroStageSlideManifest({ microStage: lexisStage, analysis });
    check("slide manifest avoids generic subheadline", manifest.slides[0]?.subtitle !== "Этап анализа");
    check("slide tables have no row placeholder", !JSON.stringify(manifest.slides[0]?.tables ?? []).includes('"row"'));
  }

  const tableRows = normalizeSlideTableRows([{ key: "", value: "" }, { label: "Domain", value: "example.com" }]);
  check("normalizeSlideTableRows drops empty rows", tableRows.length === 1 && tableRows[0]?.label === "Domain");
  const metrics = normalizeMetricCards([{ label: "Total", value: "" }, { label: "Signals", value: 3 }]);
  check("normalizeMetricCards drops empty values", metrics.length === 1 && metrics[0]?.label === "Signals");

  const out = join(process.cwd(), "storage", "digital-profile", "qa-r9-6a-orion-report-quality");
  const result = await runExactOrionPipeline("qa-r96a-case", {
    outputRoot: out,
    locale: "ru",
    useRealCaseData: false,
    allowDeterministicFallback: true,
  });
  const clientJsonPath = join(out, "composed", "final-report-json-client.json");
  const clientJson = existsSync(clientJsonPath) ? readFileSync(clientJsonPath, "utf-8") : "";
  const issues = scanClientReportText(clientJson);
  check("composed client json quality scan clean", issues.length === 0, issues.join("; "));
  check("client page count > 0", Number(result.compositionInspection.finalClientPageCount) > 0);

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
