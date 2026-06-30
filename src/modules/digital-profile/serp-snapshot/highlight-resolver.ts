/**
 * Stage N1.3 + R1.1.3 — deterministic ORION-snapshot highlight resolver.
 *
 * Red frames = confirmed/strong risk only:
 *   1. Manual adverse override by analyst
 *   2. REVIEWED linked finding, or PENDING with HIGH/CRITICAL severity
 *   3. Automatic classifier: risky class + HIGH riskConfidence + identity not LOW
 *   4. Legacy enum on mock/demo rows only (no structured classification)
 */

import {
  isRiskyResultClass,
  isStrongAutoSnapshotRisk,
  themeForClass,
  type StoredRiskClassification,
} from "../risk-classifier/result-classifier";

export interface LinkedFinding {
  reviewStatus: string;
  riskTheme: string | null;
  severity?: string | null;
}

export interface HighlightInput {
  enumClassification: string | null;
  riskClassification: StoredRiskClassification | null;
  findings: LinkedFinding[];
  /** When true, legacy enum fallback is allowed (mock/demo rows). */
  sourceIsMock?: boolean;
}

export type HighlightSource = "manual" | "finding" | "auto" | "enum" | "none";

export interface HighlightDecision {
  isHighlighted: boolean;
  riskTheme: string | null;
  source: HighlightSource;
}

const LEGACY_RISKY_ENUM = new Set(["ADVERSE_MEDIA", "LEGAL"]);

function notHighlighted(source: HighlightSource): HighlightDecision {
  return { isHighlighted: false, riskTheme: null, source };
}

function isStrongLinkedFinding(f: LinkedFinding): boolean {
  if (f.reviewStatus === "REVIEWED") return true;
  if (f.reviewStatus === "DISMISSED") return false;
  const sev = (f.severity ?? "").toUpperCase();
  return sev === "HIGH" || sev === "CRITICAL";
}

export function resolveHighlight(input: HighlightInput): HighlightDecision {
  const manual = input.riskClassification?.manual ?? null;
  const auto = input.riskClassification?.auto ?? null;

  if (manual?.classification) {
    if (isRiskyResultClass(manual.classification)) {
      return {
        isHighlighted: true,
        riskTheme: manual.riskTheme ?? themeForClass(manual.classification),
        source: "manual",
      };
    }
    return notHighlighted("manual");
  }

  if (input.findings.length > 0) {
    const active = input.findings.filter((f) => f.reviewStatus !== "DISMISSED");
    if (active.length === 0) {
      return notHighlighted("finding");
    }
    const strong = active.filter(isStrongLinkedFinding);
    if (strong.length > 0) {
      const themed = strong.find((f) => f.riskTheme && f.riskTheme.trim() !== "");
      return { isHighlighted: true, riskTheme: themed?.riskTheme ?? "other", source: "finding" };
    }
    // Weak/pending linked findings do not highlight; fall through to auto/manual.
  }

  if (auto && isStrongAutoSnapshotRisk(auto)) {
    return {
      isHighlighted: true,
      riskTheme: auto.riskTheme ?? themeForClass(auto.classification),
      source: "auto",
    };
  }

  const enumClass = (input.enumClassification ?? "").toUpperCase();
  if (!auto && !manual && input.sourceIsMock && LEGACY_RISKY_ENUM.has(enumClass)) {
    return { isHighlighted: true, riskTheme: themeForClass(enumClass), source: "enum" };
  }

  return notHighlighted("none");
}
