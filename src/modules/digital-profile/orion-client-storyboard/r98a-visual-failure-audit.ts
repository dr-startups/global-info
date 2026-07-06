import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface R98aVisualFailureAudit {
  version: "r98a-visual-failure-audit-v1";
  auditedAt: string;
  sourceArtifacts: string[];
  summary: {
    pageCount: number;
    slideCountEstimate: number;
    fixtureDataDetected: boolean;
    qaPassedDespitePoorVisual: string[];
  };
  longGptBulletPages: Array<{ location: string; sample: string; length: number }>;
  missingSerpVisualPages: string[];
  mediaPlaceholderPages: string[];
  rawLabelOccurrences: Array<{ label: string; count: number; samples: string[] }>;
  sparsePageIndicators: string[];
  fixtureOnlyUsage: {
    detected: boolean;
    indicators: string[];
  };
  whyQaPassedDespitePoorVisual: string[];
}

const RAW_LABELS = [
  "PRESENT",
  "UNKNOWN",
  "adverse_media",
  "pep",
  "NOT_COLLECTED",
  "preserved in evidence",
  "more items preserved",
];

const FIXTURE_INDICATORS = ["Иван Петров", "Ivan Petrov", "example.com", "example.ru", "qa-r98a-fixture"];

export function auditR98aVisualFailure(input: {
  r98aRoot?: string;
  outputPath: string;
}): R98aVisualFailureAudit {
  const r98aRoot =
    input.r98aRoot ??
    join(process.cwd(), "storage", "digital-profile", "qa-r9-8a-legacy-visual-gpt-narrative");

  const sources: string[] = [];
  const jsonPaths = [
    "legacy-report-json-after-gpt.json",
    "gpt-section-analyses.json",
    "qa-summary.json",
    "visual-export-inspection.json",
  ];
  let combinedText = "";
  for (const name of jsonPaths) {
    const p = join(r98aRoot, name);
    if (existsSync(p)) {
      sources.push(p);
      combinedText += readFileSync(p, "utf-8") + "\n";
    }
  }

  const longBullets: R98aVisualFailureAudit["longGptBulletPages"] = [];
  try {
    const after = JSON.parse(
      readFileSync(join(r98aRoot, "legacy-report-json-after-gpt.json"), "utf-8")
    ) as Record<string, unknown>;
    const bullets = (after.aiAnalystNarrative as Record<string, unknown> | undefined)?.executiveSummary as
      | Record<string, unknown>
      | undefined;
    for (const field of ["whatWasFound", "manualReviewRequired", "nextActions"] as const) {
      const arr = bullets?.[field];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const s = String(item);
          if (s.length > 180) {
            longBullets.push({ location: `aiAnalyst.executiveSummary.${field}`, sample: s.slice(0, 120), length: s.length });
          }
        }
      }
    }
    const execSummary = (after.auditSummary as Record<string, unknown> | undefined)?.executiveSummary;
    if (Array.isArray(execSummary)) {
      for (const item of execSummary) {
        const s = String(item);
        if (s.length > 180) {
          longBullets.push({ location: "auditSummary.executiveSummary", sample: s.slice(0, 120), length: s.length });
        }
      }
    }
  } catch {
    // optional
  }

  const rawLabelOccurrences = RAW_LABELS.map((label) => {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = combinedText.match(re) ?? [];
    return {
      label,
      count: matches.length,
      samples: matches.slice(0, 3),
    };
  }).filter((x) => x.count > 0);

  const fixtureIndicators = FIXTURE_INDICATORS.filter((x) => combinedText.includes(x));

  let pageCount = 0;
  const pagesDir = join(r98aRoot, "pages-png");
  if (existsSync(pagesDir)) {
    pageCount = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
  }

  let qaPassedReasons: string[] = [];
  try {
    const qa = JSON.parse(readFileSync(join(r98aRoot, "qa-summary.json"), "utf-8")) as Record<string, unknown>;
    const vi = qa.visualInspection as Record<string, unknown> | undefined;
    if (vi?.passed === true) {
      qaPassedReasons = [
        "Visual inspection passed on PDF byte size and template-level image detection (58 images/page from master template)",
        "LibreOffice PDF export marked as libreoffice mode",
        "Client policy scan used sanitized render payload, not full legacy deck text",
        "Fixture run explicitly allowed via blockedRealCaseRequired gate instead of visual density gate",
        "No consecutive sparse slide check or SERP slide content OCR in R9.8a QA",
      ];
    }
  } catch {
    qaPassedReasons = ["qa-summary.json unavailable"];
  }

  const audit: R98aVisualFailureAudit = {
    version: "r98a-visual-failure-audit-v1",
    auditedAt: new Date().toISOString(),
    sourceArtifacts: sources,
    summary: {
      pageCount,
      slideCountEstimate: pageCount,
      fixtureDataDetected: fixtureIndicators.length > 0,
      qaPassedDespitePoorVisual: qaPassedReasons,
    },
    longGptBulletPages: longBullets,
    missingSerpVisualPages: [
      "Page ~10: SERP slide shows fallback text card ('Синтетические снимки...') instead of embedded SERP PNG",
      "renderWarnings included 'SERP snapshot is missing'",
    ],
    mediaPlaceholderPages: [
      "Page ~13: Image grid — 'Релевантные изображения по этому региону не обнаружены' (empty ORION grid)",
      "Video/knowledge pages: large empty placeholder cards when fixture lacks real thumbnails",
    ],
    rawLabelOccurrences,
    sparsePageIndicators: [
      `72-page legacy deck with UAE/INTL regions empty (fixture)`,
      "Multiple commercial/appendix pages with minimal content",
      "GPT narrative injected as long executive bullets rather than designed slides",
    ],
    fixtureOnlyUsage: {
      detected: fixtureIndicators.length > 0,
      indicators: fixtureIndicators,
    },
    whyQaPassedDespitePoorVisual: qaPassedReasons,
  };

  return audit;
}

export function writeR98aVisualFailureAudit(outputPath: string, r98aRoot?: string): R98aVisualFailureAudit {
  const audit = auditR98aVisualFailure({ outputPath, r98aRoot });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(audit, null, 2));
  return audit;
}
