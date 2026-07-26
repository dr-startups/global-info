/**
 * Prompt 2 — benchmark trace.
 * Traces where each benchmark theme stands in the pipeline. Benchmark items
 * are coverage checklist themes only — their claims are never copied into
 * report facts; only the computed statuses are emitted.
 */

import type { RawInventoryItem } from "../types";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import type { Finding } from "../contracts/finding";
import { ADVERSE_PATTERNS } from "./surface-analyzers";

export type BenchmarkTraceStatus =
  | "ABSENT_IN_RAW"
  | "FILTERED_AS_NOISE"
  | "SUBJECT_AMBIGUOUS"
  | "PRESENT_NOT_SYNTHESIZED"
  | "SYNTHESIZED_NOT_PROMOTED"
  | "PROMOTED";

export type BenchmarkThemeDef = {
  benchmarkId: string;
  label: string;
  keywords: RegExp;
  /** themeIds from FINDING_THEMES that would satisfy this benchmark item. */
  findingThemeIds: string[];
};

/** ORION coverage checklist (themes only, not claims). */
export const BENCHMARK_THEMES: BenchmarkThemeDef[] = [
  {
    benchmarkId: "bm-political-exposure",
    label: "Политическая / публичная экспозиция",
    keywords: /полит|politic|депутат|парти|выбор|electoral|минист|правительств|парламент/iu,
    findingThemeIds: ["political_exposure"],
  },
  {
    benchmarkId: "bm-business-associations",
    label: "Деловые связи",
    keywords: /партнер|associate|соучредител|co-?founder|бизнес.{0,20}связ/iu,
    findingThemeIds: ["family_associates", "business_profile"],
  },
  {
    benchmarkId: "bm-spouse",
    label: "Супруга / экс-супруга",
    keywords: /жена|супруг|spouse|ex-?wife/iu,
    findingThemeIds: ["family_associates"],
  },
  {
    benchmarkId: "bm-offshore",
    label: "Офшоры",
    keywords: /офшор|offshore|кипр|cyprus|\bbvi\b|панам|panama/iu,
    findingThemeIds: ["offshore_corporate"],
  },
  {
    benchmarkId: "bm-corporate-ownership",
    label: "Корпоративное владение",
    keywords: /владел|ownership|бенефициар|beneficia|учредител|акционер|shareholder/iu,
    findingThemeIds: ["offshore_corporate", "business_profile"],
  },
  {
    benchmarkId: "bm-pep-rca",
    label: "PEP / RCA",
    keywords: /\bpep\b|\brca\b|rupep|watch.?list|world.?check|dow.?jones/iu,
    findingThemeIds: ["pep_rca_watchlist"],
  },
  {
    benchmarkId: "bm-criminal-judicial",
    label: "Криминал / суды",
    keywords: /уголов|criminal|арест|суд|прокур|следств|компромат/iu,
    findingThemeIds: ["criminal_legal"],
  },
  {
    benchmarkId: "bm-defense-natsec",
    label: "Оборона / национальная безопасность",
    keywords: /оборон|defen[cs]e|national security|спецслужб|фсб|security service/iu,
    findingThemeIds: ["security_scrutiny"],
  },
];

export type BenchmarkTraceRow = {
  benchmarkId: string;
  label: string;
  status: BenchmarkTraceStatus;
  rawMatchCount: number;
  subjectMatchCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  noiseCount: number;
  findingIds: string[];
  promotedFindingIds: string[];
  notes: string[];
};

export type BenchmarkTrace = {
  schemaVersion: "benchmark-trace-v1";
  caseId: string;
  datasetId: string;
  disclaimer: string;
  rows: BenchmarkTraceRow[];
};

const NOISE_PATTERNS = /aliexpress|ozon|wildberries|market\.yandex|ebay|amazon\.|купить|цена|лампа/iu;

function itemText(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ");
}

export function buildBenchmarkTrace(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  verifiedFindings: Finding[];
  ambiguousFindings: Finding[];
  promotedFindingIds: Set<string>;
  themeAssignments: Map<string, string[]>;
}): BenchmarkTrace {
  const rows: BenchmarkTraceRow[] = BENCHMARK_THEMES.map((bm) => {
    const matched = input.items.filter((i) => bm.keywords.test(itemText(i)));
    const notes: string[] = [];

    if (matched.length === 0) {
      return {
        benchmarkId: bm.benchmarkId,
        label: bm.label,
        status: "ABSENT_IN_RAW" as const,
        rawMatchCount: 0,
        subjectMatchCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        noiseCount: 0,
        findingIds: [],
        promotedFindingIds: [],
        notes,
      };
    }

    let subjectMatchCount = 0;
    let ambiguousCount = 0;
    let otherSubjectCount = 0;
    let noiseCount = 0;
    for (const item of matched) {
      if (NOISE_PATTERNS.test(itemText(item))) {
        noiseCount += 1;
        continue;
      }
      const d = input.resolutionByRef.get(`inventory:${item.inventoryId}`)?.decision;
      if (d === "SUBJECT_MATCH") subjectMatchCount += 1;
      else if (d === "AMBIGUOUS") ambiguousCount += 1;
      else if (d === "OTHER_SUBJECT") otherSubjectCount += 1;
    }

    const relatedVerified = input.verifiedFindings.filter((f) =>
      bm.findingThemeIds.some((tid) => f.findingId.includes(tid))
    );
    const relatedAmbiguous = input.ambiguousFindings.filter((f) =>
      bm.findingThemeIds.some((tid) => f.findingId.includes(tid))
    );
    const promoted = relatedVerified.filter((f) => input.promotedFindingIds.has(f.findingId));

    let status: BenchmarkTraceStatus;
    if (promoted.length > 0) {
      status = "PROMOTED";
    } else if (relatedVerified.length > 0) {
      status = "SYNTHESIZED_NOT_PROMOTED";
      const p12 = relatedVerified.filter(
        (f) => f.promotionPriority === "P1" || f.promotionPriority === "P2"
      );
      if (p12.length > 0) {
        notes.push(
          `ALERT: adverse P1/P2 finding not promoted to summary: ${p12
            .map((f) => f.findingId)
            .join(", ")}`
        );
      }
      // Explicit promotion exclusion reason for every non-promoted finding.
      for (const f of relatedVerified) {
        notes.push(
          `promotion-exclusion: ${f.findingId} promotionPriority=${f.promotionPriority}, riskLevel=${f.riskLevel} — ниже порога продвижения в summary или вытеснен более приоритетными findings`
        );
      }
    } else if (subjectMatchCount > 0) {
      status = "PRESENT_NOT_SYNTHESIZED";
    } else if (ambiguousCount > 0 || relatedAmbiguous.length > 0) {
      status = "SUBJECT_AMBIGUOUS";
    } else if (noiseCount > 0 || otherSubjectCount > 0) {
      status = "FILTERED_AS_NOISE";
    } else {
      status = "SUBJECT_AMBIGUOUS";
      notes.push("Raw matches carry insufficient identifiers.");
    }

    return {
      benchmarkId: bm.benchmarkId,
      label: bm.label,
      status,
      rawMatchCount: matched.length,
      subjectMatchCount,
      ambiguousCount,
      otherSubjectCount,
      noiseCount,
      findingIds: [...relatedVerified, ...relatedAmbiguous].map((f) => f.findingId),
      promotedFindingIds: promoted.map((f) => f.findingId),
      notes,
    };
  });

  return {
    schemaVersion: "benchmark-trace-v1",
    caseId: input.caseId,
    datasetId: input.datasetId,
    disclaimer:
      "Benchmark items are coverage checklist themes. Their claims are not report facts; only pipeline statuses are recorded.",
    rows,
  };
}
