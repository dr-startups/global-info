/**
 * R9.12 — Root-cause audit of R9.11 client-visible quality failures.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R911 = join(process.cwd(), "storage", "digital-profile", "qa-r9-11-orion-visual-polish");
const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-12-client-quality-storyboard");

const ID_PATTERNS = [
  /cmr[a-z0-9]{10,}/gi,
  /executive_summary-rf-/gi,
  /ru_audit_summary-rf-/gi,
  /-sr-cmr[a-z0-9]+/gi,
  /executive_summary-sr-/gi,
];

function collectClientText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(obj);
  return parts.join("\n");
}

function main() {
  const storyboard = JSON.parse(readFileSync(join(R911, "client-storyboard.json"), "utf-8"));
  const inspection = existsSync(join(R911, "r911-visual-polish-inspection.json"))
    ? JSON.parse(readFileSync(join(R911, "r911-visual-polish-inspection.json"), "utf-8"))
    : null;
  const text = collectClientText(storyboard);
  const idLeaks = ID_PATTERNS.flatMap((re) => {
    const m = text.match(re);
    return m ? [...new Set(m)] : [];
  });

  const noiseTerms = ["лампа", "aliexpress", "lilygo", "navigator nll", "прошивка vw"];
  const noiseHits = noiseTerms.filter((t) => text.toLowerCase().includes(t));

  const audit = {
    version: "r912-r911-client-quality-audit-v1",
    auditedAt: new Date().toISOString(),
    sourceRoot: R911,
    rootCauses: {
      technicalIdLeak: {
        detected: idLeaks.length > 0,
        sampleIds: idLeaks.slice(0, 8),
        cause:
          "GPT confirmedFacts/unconfirmedSignals copied raw evidenceRef strings; composer mapped them into finding summaries without sanitization.",
      },
      irrelevantSearchResults: {
        detected: noiseHits.length > 0,
        samples: noiseHits,
        cause:
          "search_results_table and search_overview used unfiltered searchRows.slice(0,5) without relevance classifier.",
      },
      genericManualReviewLanguage: {
        detected: (text.match(/требует ручной проверки/gi) ?? []).length > 8,
        count: (text.match(/требует ручной проверки/gi) ?? []).length,
        cause: "GPT prompt mandated repeated phrase; no variation or excluded-noise summary.",
      },
      layoutOverlap: {
        detected: true,
        cause:
          "orion_visual_composer.py stacked labeled_block + metrics + 3 cards at fixed Y without height measurement; executive slide content exceeds safe area.",
      },
      weakLexisAnalysis: {
        detected: true,
        cause:
          "Lexis section only had metrics + generic takeaway; no GPT lexis_summary; visual pages used as primary content at small scale.",
      },
      serpLayoutWeakness: {
        detected: true,
        cause:
          "Separate Yandex/Google slides each full-width; no relevance explanation slide; empty engine columns not applicable but SERP lacks paired relevance narrative.",
      },
      qaFalsePass: {
        detected: true,
        cause:
          "R911 inspection checked file presence, policy scan on limited fields, PDF size — not ID patterns, noise exclusion, or layout overlap.",
        r911InspectionPassed: inspection?.passed ?? null,
      },
    },
    recommendations: [
      "sanitizeClientNarrativeText on all GPT and composer outputs",
      "evidence-relevance-classifier before storyboard compose",
      "split executive into summary + risk slides with layout measurement",
      "add Lexis GPT analytical summary + signals slides before appendix",
      "strict R912 client-quality-inspection with ID and noise gates",
    ],
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "r911-client-quality-audit.json"), JSON.stringify(audit, null, 2));
  console.log(`[INFO] Wrote ${join(OUT, "r911-client-quality-audit.json")}`);
  console.log(`[INFO] ID leaks: ${idLeaks.length}, noise hits: ${noiseHits.length}`);
}

main();
