import { existsSync } from "node:fs";
import { join } from "node:path";
import { runR98aLegacyVisualGpt, R98A_OUTPUT_ROOT } from "../src/modules/digital-profile/orion-report-spec/run-r98a-legacy-visual-gpt";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  check("legacy-gpt-narrative-injector exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/legacy-gpt-narrative-injector.ts")));
  check("legacy-render-qa-client exists", existsSync(join(process.cwd(), "src/modules/digital-profile/orion-report-spec/legacy-render-qa-client.ts")));
  check("inspect-r98a-visual-export.py exists", existsSync(join(process.cwd(), "scripts/inspect-r98a-visual-export.py")));

  const result = await runR98aLegacyVisualGpt({
    outputRoot: R98A_OUTPUT_ROOT,
    requireGpt: false,
    allowDeterministicFallback: true,
  });

  check("legacy report JSON before GPT", existsSync(join(result.outputRoot, "legacy-report-json-before-gpt.json")));
  check("legacy report JSON after GPT", existsSync(join(result.outputRoot, "legacy-report-json-after-gpt.json")));
  check("rendered PDF", existsSync(join(result.outputRoot, "rendered-client.pdf")));
  check("rendered PPTX", existsSync(join(result.outputRoot, "rendered-client.pptx")));
  check("visual export inspection", existsSync(join(result.outputRoot, "visual-export-inspection.json")));
  check("legacy renderer path", result.visualInspection.legacyRendererUsed);
    check("PDF has images", result.visualInspection.pdfAnyImages, String(result.visualInspection.pdfAnyImages));
    check(
      "PPTX has embedded blips",
      result.visualInspection.pptxHasPictures || result.visualInspection.pdfSerpHasImages,
      String(result.visualInspection.pptxHasPictures)
    );
  check("page count >= 10", result.pageCount >= 10, String(result.pageCount));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
