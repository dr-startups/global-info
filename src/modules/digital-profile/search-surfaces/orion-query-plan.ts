/**
 * Stage O1 — deterministic ORION-style multi-query search plan.
 *
 * Builds primary name variants per region (RU / UAE / INTERNATIONAL) plus optional
 * risk probes. No LLM, no suggestion APIs — pure string composition.
 */

import { parseSubjectName } from "../risk-classifier/entity-disambiguation";
import type { QuerySubject } from "../providers/query-builder";

export type OrionRegionCode = "RU" | "UAE" | "INTERNATIONAL";

export type QueryPriority = "primary" | "risk_probe";

export interface OrionQuerySpec {
  query: string;
  language: string;
  region: OrionRegionCode;
  priority: QueryPriority;
  /** Stable order within the plan (1-based). */
  planRank: number;
}

export interface OrionQueryPlanOptions {
  /** Max primary queries per region (default 5). */
  maxPrimaryPerRegion?: number;
  /** Append adverse-context probes (default false). */
  includeRiskProbes?: boolean;
  /** Which regions to include (default: inferred from subject.targetRegions). */
  regions?: OrionRegionCode[];
}

const DEFAULT_MAX_PRIMARY = 5;

const RU_RISK_TERMS = ["суд", "санкции", "бизнес", "офшор", "скандал"] as const;
const EN_RISK_TERMS = ["court", "sanctions", "business", "offshore", "scandal"] as const;

/** Minimal Cyrillic → Latin transliteration for EN query variants. */
const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

export function transliterateRuToEn(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map((ch) => {
          const lower = ch.toLowerCase();
          const lat = CYR_TO_LAT[lower];
          if (lat !== undefined) return ch === lower ? lat : lat.charAt(0).toUpperCase() + lat.slice(1);
          return ch;
        })
        .join("")
    )
    .join(" ");
}

function resolveRegions(subject: QuerySubject, override?: OrionRegionCode[]): OrionRegionCode[] {
  if (override?.length) return override;
  const raw = (subject.targetRegions ?? []).map((r) => r.toUpperCase());
  const out = new Set<OrionRegionCode>();
  if (raw.includes("RU") || hasCyrillic(subject.fullName)) out.add("RU");
  if (raw.some((r) => ["UAE", "AE"].includes(r))) out.add("UAE");
  if (
    raw.length === 0 ||
    raw.some((r) => ["GLOBAL", "INTERNATIONAL", "EU", "US", "INTL"].includes(r))
  ) {
    out.add("INTERNATIONAL");
  }
  if (out.size === 0) out.add(hasCyrillic(subject.fullName) ? "RU" : "INTERNATIONAL");
  return [...out];
}

function enNameParts(subject: QuerySubject): { full: string; first: string; last: string; middle: string } {
  const aliases = (subject.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const latinAlias = aliases.find((a) => !hasCyrillic(a));
  const full = latinAlias ?? (hasCyrillic(subject.fullName) ? transliterateRuToEn(subject.fullName) : subject.fullName);
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    return { full, first: parts[0] ?? "", middle: parts[1] ?? "", last: parts.slice(2).join(" ") };
  }
  if (parts.length === 2) {
    return { full, first: parts[0] ?? "", last: parts[1] ?? "", middle: "" };
  }
  return { full, first: parts[0] ?? "", last: "", middle: "" };
}

function buildRuPrimary(subject: QuerySubject): string[] {
  const id = parseSubjectName(subject.fullName);
  const last = id.surname ?? "";
  const first = id.givenName ?? "";
  const pat = id.patronymic ?? "";
  const queries: string[] = [];
  if (last && first && pat) queries.push(`${last} ${first} ${pat}`);
  if (first && last) queries.push(`${first} ${last}`);
  if (last && first) queries.push(`${last} ${first}`);
  if (first && pat && last) queries.push(`${first} ${pat} ${last}`);
  queries.push(`${subject.fullName.trim()} биография`);
  return queries;
}

function buildEnPrimary(subject: QuerySubject): string[] {
  const { full, first, last, middle } = enNameParts(subject);
  const queries: string[] = [];
  if (first && last) {
    queries.push(`${first} ${last}`);
    queries.push(`${last} ${first}`);
  }
  if (first && middle && last) queries.push(`${first} ${middle} ${last}`);
  queries.push(full);
  queries.push(`${full} biography`);
  return queries;
}

function dedupeSpecs(specs: OrionQuerySpec[]): OrionQuerySpec[] {
  const seen = new Set<string>();
  const out: OrionQuerySpec[] = [];
  let rank = 0;
  for (const spec of specs) {
    const key = `${spec.region}|${spec.language}|${spec.query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rank += 1;
    out.push({ ...spec, planRank: rank });
  }
  return out;
}

/**
 * Builds the full ORION query plan for a subject.
 * Primary queries are capped per region; risk probes are appended when enabled.
 */
export function buildOrionQueryPlan(
  subject: QuerySubject,
  options: OrionQueryPlanOptions = {}
): OrionQuerySpec[] {
  const maxPrimary = options.maxPrimaryPerRegion ?? DEFAULT_MAX_PRIMARY;
  const regions = resolveRegions(subject, options.regions);
  const specs: OrionQuerySpec[] = [];

  for (const region of regions) {
    if (region === "RU") {
      const primary = buildRuPrimary(subject).slice(0, maxPrimary);
      for (const q of primary) {
        specs.push({ query: q, language: "ru", region, priority: "primary", planRank: 0 });
      }
      if (options.includeRiskProbes) {
        for (const term of RU_RISK_TERMS) {
          specs.push({
            query: `${subject.fullName.trim()} ${term}`,
            language: "ru",
            region,
            priority: "risk_probe",
            planRank: 0,
          });
        }
      }
    } else {
      const primary = buildEnPrimary(subject).slice(0, maxPrimary);
      for (const q of primary) {
        specs.push({ query: q, language: "en", region, priority: "primary", planRank: 0 });
      }
      if (options.includeRiskProbes) {
        const { full } = enNameParts(subject);
        for (const term of EN_RISK_TERMS) {
          specs.push({
            query: `${full} ${term}`,
            language: "en",
            region,
            priority: "risk_probe",
            planRank: 0,
          });
        }
      }
    }
  }

  return dedupeSpecs(specs);
}

/** Primary queries only — used for Serper surface collection (suggestions/images/etc.). */
export function primaryQueriesForRegion(
  plan: OrionQuerySpec[],
  region: OrionRegionCode
): OrionQuerySpec[] {
  return plan.filter((q) => q.region === region && q.priority === "primary");
}
