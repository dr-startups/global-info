/**
 * Step 05.1 — payload for GPT section analysis.
 *
 * The analyzer used to hand the model only `title / domain / relevance /
 * humanReason`. Snippets, URLs, regions and risk signals were already sitting
 * on `EvidenceDecisionRecord` and were simply dropped, so the model had nothing
 * concrete to write from and produced generic due-diligence boilerplate.
 *
 * This module is pure: it turns a `SectionEvidencePack` into the JSON payload,
 * enforcing a character budget so richer evidence cannot silently blow up the
 * request. Kept separate from the analyzer so the shaping rules are unit
 * testable without touching the network.
 */

import { toDisplayDate } from "../../providers/published-date";
import type { EvidenceDecisionRecord, SectionEvidencePack } from "../types";

/**
 * Budgets are expressed in characters, not tokens: the payload is JSON with
 * mixed RU/EN text where a token is ~2.5–3 chars, and a character budget is
 * both deterministic and cheap to assert in tests.
 */
export const SECTION_PAYLOAD_LIMITS = {
  /** Per-snippet cap — enough for a lead paragraph, not a whole article. */
  snippetChars: 400,
  /** Per-title cap; SERP titles are short, this only guards pathological input. */
  titleChars: 200,
  /** Upper bound on analysed evidence items before the budget pass. */
  maxSelected: 40,
  /** Excluded items are summarised, not analysed — a short tail is enough. */
  maxExcluded: 15,
  /** Total budget for the serialised evidence arrays. */
  totalEvidenceChars: 24_000,
} as const;

export type SectionPayloadEvidence = {
  ref: string;
  title: string;
  snippet?: string;
  domain?: string;
  url?: string;
  region?: string;
  language?: string;
  sourceType?: string;
  /** `YYYY-MM-DD`; absent when the provider reported no date. */
  publishedAt?: string;
  relevance: string;
  riskTheme?: string;
  riskLevel?: string;
  /** 0–1 identity match score, rounded — lets the model hedge appropriately. */
  entityMatchScore?: number;
  humanReason: string;
  snippetTruncated?: true;
};

export type SectionAnalysisPayload = {
  sectionKey: string;
  clientTitle: string;
  subjectName: string;
  metrics: Record<string, number | string>;
  selectedEvidence: SectionPayloadEvidence[];
  excludedSummary: Array<{ title: string; reason: string }>;
  /** Set when the character budget dropped items, so the model can say so. */
  evidenceOmitted?: number;
};

/** Trims to `max` characters on a word boundary where one is close enough. */
export function truncateText(value: string, max: number): { text: string; truncated: boolean } {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const hard = clean.slice(0, max);
  const lastSpace = hard.lastIndexOf(" ");
  // Only honour the word boundary if it does not cost more than 15% of the budget.
  const cut = lastSpace > max * 0.85 ? hard.slice(0, lastSpace) : hard;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Ranks evidence for budget trimming: the model should lose the weakest items
 * first, never the strongest. Higher is kept longer.
 */
function evidenceWeight(record: EvidenceDecisionRecord): number {
  const relevanceRank: Record<string, number> = {
    strong_relevant: 4,
    potentially_relevant: 3,
    weak_match: 2,
    excluded_noise: 1,
  };
  const base = relevanceRank[record.relevanceClass] ?? 2;
  const risk = record.riskTheme ? 1 : 0;
  const match = typeof record.entityMatchScore === "number" ? record.entityMatchScore : 0;
  return base * 10 + risk * 5 + match;
}

function toPayloadEvidence(record: EvidenceDecisionRecord, index: number): SectionPayloadEvidence {
  const title = truncateText(record.normalizedTitle ?? "", SECTION_PAYLOAD_LIMITS.titleChars);
  const snippetSource = optional(record.normalizedSnippet);
  const snippet = snippetSource
    ? truncateText(snippetSource, SECTION_PAYLOAD_LIMITS.snippetChars)
    : null;

  return {
    // Opaque positional handle. Internal inventory ids are deliberately not
    // exposed — they must never reach client-facing copy.
    ref: `e${index + 1}`,
    title: title.text,
    ...(snippet ? { snippet: snippet.text } : {}),
    ...(snippet?.truncated ? { snippetTruncated: true as const } : {}),
    ...(optional(record.domain) ? { domain: record.domain!.trim() } : {}),
    ...(optional(record.canonicalUrl) ? { url: record.canonicalUrl!.trim() } : {}),
    ...(optional(record.region) ? { region: record.region!.trim() } : {}),
    ...(optional(record.language) ? { language: record.language!.trim() } : {}),
    ...(optional(record.evidenceType) ? { sourceType: record.evidenceType.trim() } : {}),
    ...(toDisplayDate(record.publishedAt) ? { publishedAt: toDisplayDate(record.publishedAt)! } : {}),
    relevance: record.relevanceClass,
    ...(optional(record.riskTheme) ? { riskTheme: record.riskTheme!.trim() } : {}),
    ...(optional(record.riskLevel) ? { riskLevel: record.riskLevel!.trim() } : {}),
    ...(typeof record.entityMatchScore === "number" && Number.isFinite(record.entityMatchScore)
      ? { entityMatchScore: Math.round(record.entityMatchScore * 100) / 100 }
      : {}),
    humanReason: truncateText(record.humanReason ?? "", SECTION_PAYLOAD_LIMITS.snippetChars).text,
  };
}

/** Drops the weakest items until the serialised evidence fits the budget. */
function applyCharacterBudget(items: SectionPayloadEvidence[], ranked: number[]): {
  kept: SectionPayloadEvidence[];
  omitted: number;
} {
  const size = (list: SectionPayloadEvidence[]) => JSON.stringify(list).length;
  if (size(items) <= SECTION_PAYLOAD_LIMITS.totalEvidenceChars) {
    return { kept: items, omitted: 0 };
  }
  // Weakest-first removal order, keeping original presentation order intact.
  const order = [...items.keys()].sort((a, b) => (ranked[a] ?? 0) - (ranked[b] ?? 0));
  const dropped = new Set<number>();
  for (const index of order) {
    dropped.add(index);
    const kept = items.filter((_, i) => !dropped.has(i));
    if (size(kept) <= SECTION_PAYLOAD_LIMITS.totalEvidenceChars) {
      return { kept, omitted: dropped.size };
    }
  }
  return { kept: [], omitted: items.length };
}

/**
 * Builds the user payload for one section analysis call.
 *
 * `pack` may be undefined — a section with no evidence still gets analysed so
 * the model can produce an honest "not collected" narrative rather than the
 * caller silently skipping the slide.
 */
export function buildSectionAnalysisPayload(input: {
  sectionKey: string;
  clientTitle: string;
  subjectName: string;
  pack: SectionEvidencePack | undefined;
}): SectionAnalysisPayload {
  const { pack } = input;
  const selectedRecords = (pack?.selectedForAnalysis ?? []).slice(
    0,
    SECTION_PAYLOAD_LIMITS.maxSelected
  );
  const excludedRecords = (pack?.excluded ?? []).slice(0, SECTION_PAYLOAD_LIMITS.maxExcluded);

  const mapped = selectedRecords.map(toPayloadEvidence);
  const weights = selectedRecords.map(evidenceWeight);
  const { kept, omitted } = applyCharacterBudget(mapped, weights);

  return {
    sectionKey: input.sectionKey,
    clientTitle: input.clientTitle,
    subjectName: input.subjectName,
    metrics: pack?.metrics ?? {},
    selectedEvidence: kept,
    excludedSummary: excludedRecords.map((e) => ({
      title: truncateText(e.normalizedTitle ?? "", SECTION_PAYLOAD_LIMITS.titleChars).text,
      reason: e.exclusionReason ?? e.relevanceClass,
    })),
    ...(omitted > 0 ? { evidenceOmitted: omitted } : {}),
  };
}
