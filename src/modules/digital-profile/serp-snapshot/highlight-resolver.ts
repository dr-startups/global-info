/**
 * Stage N1.3 — deterministic ORION-snapshot highlight resolver.
 *
 * PURE. Decides whether one search result should be drawn with a red frame and,
 * if so, which risk theme it belongs to. Conservative + evidence-first.
 *
 * Precedence (highest wins):
 *   1. Manual override (analyst): adverse → highlight; neutral → never highlight.
 *   2. Linked risk_findings: an active (PENDING/REVIEWED) finding → highlight;
 *      if every linked finding is DISMISSED → suppress (human said "not risk").
 *   3. Automatic classifier: risky class with MEDIUM/HIGH confidence → highlight.
 *   4. Legacy enum fallback: classification ADVERSE_MEDIA/LEGAL → highlight
 *      (keeps existing mock/manual-enum cases working).
 *   5. Otherwise: not highlighted.
 */

import {
  isRiskyResultClass,
  themeForClass,
  type ResultConfidence,
  type ResultRiskTheme,
  type StoredRiskClassification,
} from "../risk-classifier/result-classifier";

export interface LinkedFinding {
  reviewStatus: string; // PENDING | REVIEWED | DISMISSED
  riskTheme: string | null;
}

export interface HighlightInput {
  /** Prisma enum classification on the row (e.g. ADVERSE_MEDIA). */
  enumClassification: string | null;
  /** Namespaced rawMetadata.riskClassification (auto + manual). */
  riskClassification: StoredRiskClassification | null;
  /** Findings whose evidenceRefs reference this result id. */
  findings: LinkedFinding[];
}

export type HighlightSource = "manual" | "finding" | "auto" | "enum" | "none";

export interface HighlightDecision {
  isHighlighted: boolean;
  /** Effective risk theme key when highlighted, else null. */
  riskTheme: ResultRiskTheme | string | null;
  source: HighlightSource;
}

const STRONG_CONFIDENCE: ReadonlySet<ResultConfidence> = new Set<ResultConfidence>(["MEDIUM", "HIGH"]);
const LEGACY_RISKY_ENUM = new Set(["ADVERSE_MEDIA", "LEGAL"]);

function notHighlighted(source: HighlightSource): HighlightDecision {
  return { isHighlighted: false, riskTheme: null, source };
}

export function resolveHighlight(input: HighlightInput): HighlightDecision {
  const manual = input.riskClassification?.manual ?? null;
  const auto = input.riskClassification?.auto ?? null;

  // 1. Manual override is decisive in both directions.
  if (manual && manual.classification) {
    if (isRiskyResultClass(manual.classification)) {
      return {
        isHighlighted: true,
        riskTheme: manual.riskTheme ?? themeForClass(manual.classification),
        source: "manual",
      };
    }
    // Manual neutral (or any non-risky manual class) excludes from highlights.
    return notHighlighted("manual");
  }

  // 2. Linked findings: active wins; all-dismissed suppresses.
  if (input.findings.length > 0) {
    const active = input.findings.filter((f) => f.reviewStatus !== "DISMISSED");
    if (active.length > 0) {
      const themed = active.find((f) => f.riskTheme && f.riskTheme.trim() !== "");
      return { isHighlighted: true, riskTheme: themed?.riskTheme ?? "other", source: "finding" };
    }
    // Every linked finding was dismissed by a reviewer → not a risk highlight.
    return notHighlighted("finding");
  }

  // 3. Automatic classifier — only MEDIUM/HIGH risky classes highlight.
  if (
    auto &&
    isRiskyResultClass(auto.classification) &&
    STRONG_CONFIDENCE.has(auto.confidence)
  ) {
    return {
      isHighlighted: true,
      riskTheme: auto.riskTheme ?? themeForClass(auto.classification),
      source: "auto",
    };
  }

  // 4. Legacy enum fallback (mock/manual-enum cases without structured data).
  const enumClass = (input.enumClassification ?? "").toUpperCase();
  if (!auto && !manual && LEGACY_RISKY_ENUM.has(enumClass)) {
    return { isHighlighted: true, riskTheme: themeForClass(enumClass), source: "enum" };
  }

  return notHighlighted("none");
}
