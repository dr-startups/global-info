/**
 * Stage 3 — deterministic, coverage-aware RepresentativeEvidenceSelector.
 * Ensures every material theme gets 1–2 concrete examples before any top-N cut.
 */

import { createHash } from "node:crypto";
import type { CanonicalClaim, CanonicalThemeId, MaterialityLevel } from "../contracts/canonical-claim";
import type { CanonicalClaimsBundle } from "../contracts/canonical-claim";
import {
  EXCLUDED_MATERIALITY_SCHEMA_VERSION,
  REPRESENTATIVE_COVERAGE_SCHEMA_VERSION,
  REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
  RepresentativeEvidenceSelectionSchema,
  RepresentativeCoverageReportSchema,
  ExcludedMaterialityReportSchema,
  type RepresentativeEvidenceSelection,
  type RepresentativeCoverageReport,
  type ExcludedMaterialityReport,
  type SelectedRepresentative,
  type IsolatedSignificantItem,
  type P1P2Account,
} from "../contracts/representative-evidence";
import { themeLabelRu } from "./canonical-themes";

const MATERIAL_LEVELS = new Set<MaterialityLevel>(["CRITICAL", "HIGH", "MEDIUM"]);
const LEVEL_RANK: Record<MaterialityLevel, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  CONTEXT_ONLY: 1,
};

const OFFICIAL_DOMAIN = /\.gov(?:[./]|$)|treasury\.|ofac\.|justice\.|kad\.arbitr|nalog\.ru/iu;
const REPUTABLE =
  /reuters\.|nytimes\.|theguardian\.|bbc\.|ft\.com|wsj\.|bloomberg\.|cnbc\.|kommersant\.|rbc\.ru|vedomosti\.|currenttime\.|tass\.|interfax\./iu;

const DANGLING_EXCERPT =
  /(?:^|[^\p{L}\p{N}_])(?:and|or|of|the|a|an|to|for|with|from|by|over|и|в|во|на|по|с|со|о|об|из|из-за|для|как|что)\s*$/iu;

export type RepresentativeSelectInput = {
  caseId: string;
  datasetId: string;
  subjectId: string;
  sourceHashes: string[];
  claimsBundle: CanonicalClaimsBundle;
};

function maxLevel(levels: MaterialityLevel[]): MaterialityLevel {
  let best: MaterialityLevel = "CONTEXT_ONLY";
  for (const l of levels) {
    if (LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
  }
  return best;
}

function isMaterialClaim(c: CanonicalClaim): boolean {
  if (c.subjectMatch === "OTHER_SUBJECT") return false;
  if (!MATERIAL_LEVELS.has(c.materialityLevel)) return false;
  if (c.subjectMatch === "AMBIGUOUS" || c.subjectMatch === "INSUFFICIENT_IDENTIFIERS") {
    return c.materialityLevel === "CRITICAL" || c.materialityLevel === "HIGH";
  }
  return (
    c.subjectMatch === "SUBJECT_MATCH" ||
    c.subjectMatch === "LIKELY_SUBJECT" ||
    c.summaryOverrideRequired
  );
}

function plotKeyOf(claim: CanonicalClaim): string {
  const title = claim.originalTitle
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[^a-z0-9а-яё]+/giu, " ")
    .trim()
    .slice(0, 80);
  const domain = (claim.sourceDomains[0] ?? "").toLowerCase();
  const themePart = [...claim.themeIds].sort().join("+");
  return createHash("sha1")
    .update(`${themePart}|${domain}|${title}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Semantic excerpt: prefer finished sentence(s); never mid-cut names/accusations.
 * Falls back to title + neutral description with full-text ref preserved on the row.
 */
export function buildSemanticDisplayExcerpt(claim: CanonicalClaim, maxChars = 480): string {
  const full = String(claim.fullClaimText ?? "").trim();
  const lines = full
    .split(/\n+/u)
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer quote lines — they are concrete theses.
  const quoteLines = lines.filter((l) => /^«/.test(l) && /источник/iu.test(l));
  let candidate = "";
  if (quoteLines.length > 0) {
    candidate = quoteLines.slice(0, 2).join(" ");
  } else if (full.length > 0) {
    candidate = full.replace(/\s+/gu, " ");
  } else if (claim.originalTitle.trim()) {
    candidate = `«${claim.originalTitle.trim()}»${
      claim.sourceDomains[0] ? ` — источник ${claim.sourceDomains[0]}` : ""
    }. Материал учтён в трассе доказательств.`;
  } else {
    candidate = "Материал учтён в трассе доказательств.";
  }

  if (candidate.length <= maxChars) {
    return finalizeExcerpt(candidate);
  }

  const slice = candidate.slice(0, maxChars);
  const ends = [
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("». "),
    slice.lastIndexOf("» —"),
  ];
  const best = Math.max(...ends);
  if (best >= Math.floor(maxChars * 0.4)) {
    const end = slice[best] === "»" ? best + 1 : best + 1;
    return finalizeExcerpt(slice.slice(0, end).trim());
  }
  // Do not word-slice through a quote — fall back to title description.
  if (claim.originalTitle.trim()) {
    return finalizeExcerpt(
      `«${claim.originalTitle.trim()}»${
        claim.sourceDomains[0] ? ` — источник ${claim.sourceDomains[0]}` : ""
      }. Полный текст сохранён в evidence/trace.`
    );
  }
  return finalizeExcerpt(candidate.slice(0, maxChars).trim());
}

function finalizeExcerpt(text: string): string {
  let t = text.trim();
  // Strip dangling preposition tails rather than publishing them.
  while (DANGLING_EXCERPT.test(t)) {
    t = t.replace(DANGLING_EXCERPT, "").trim();
  }
  if (t && !/[.!?…»)]$/u.test(t)) t = `${t}.`;
  return t;
}

function countSemanticTruncations(excerpt: string, full: string): number {
  if (!excerpt) return 1;
  if (DANGLING_EXCERPT.test(excerpt.replace(/[.!?…»)]+$/u, "").trim())) return 1;
  // Mid-cut marker: excerpt ends with letter and full continues with letter without boundary.
  if (/[A-Za-zА-Яа-яЁё]$/u.test(excerpt) && full.length > excerpt.length + 5) {
    // Allowed only if we intentionally used title fallback ending with period.
    if (!/[.!?…»)]$/u.test(excerpt)) return 1;
  }
  return 0;
}

function subjectDirectnessScore(c: CanonicalClaim): number {
  switch (c.subjectMatch) {
    case "SUBJECT_MATCH":
      return 100;
    case "LIKELY_SUBJECT":
      return 70;
    case "AMBIGUOUS":
      return 40;
    default:
      return 10;
  }
}

function concreteThesisScore(c: CanonicalClaim): number {
  let s = 0;
  if (/«[^»]{12,}»/.test(c.fullClaimText)) s += 40;
  if (/—\s*источник\s+\S+/iu.test(c.fullClaimText)) s += 20;
  if (c.originalTitle.trim().length >= 24) s += 15;
  if (c.fullClaimText.length >= 80) s += 10;
  // Prefer not bare bio SEO.
  if (/биограф|личная жизнь|фото/iu.test(c.originalTitle) && !c.adverseType) s -= 25;
  return s;
}

/**
 * Domain of the material `originalTitle` belongs to.
 *
 * `sourceDomains` aggregates every domain behind the claim in an order that has
 * nothing to do with the lead title, so pairing the two misattributed
 * headlines. Returns "" when the lead material has no known domain — callers
 * must then omit the attribution rather than substitute another outlet.
 */
export function leadDomainOf(c: CanonicalClaim): string {
  return (c.originalDomain ?? "").trim();
}

function domainScore(c: CanonicalClaim): number {
  if (c.sourceDomains.some((d) => OFFICIAL_DOMAIN.test(d))) return 40;
  if (c.sourceDomains.some((d) => REPUTABLE.test(d))) return 30;
  if (c.sourceDomains.length > 0) return 10;
  return 0;
}

function rankClaimForTheme(c: CanonicalClaim, themeId: CanonicalThemeId): number {
  return (
    LEVEL_RANK[c.materialityLevel] * 50 +
    subjectDirectnessScore(c) +
    concreteThesisScore(c) +
    domainScore(c) +
    (c.summaryOverrideRequired && c.themeIds.includes(themeId) ? 25 : 0) +
    (c.themeIds[0] === themeId ? 5 : 0)
  );
}

function collectMaterialThemes(claims: CanonicalClaim[]): CanonicalThemeId[] {
  const themeBest = new Map<CanonicalThemeId, MaterialityLevel>();
  for (const c of claims) {
    if (!isMaterialClaim(c)) continue;
    for (const t of c.themeIds) {
      // identity_mismatch is not a summary risk theme for coverage.
      if (t === "identity_mismatch") continue;
      const prev = themeBest.get(t);
      if (!prev || LEVEL_RANK[c.materialityLevel] > LEVEL_RANK[prev]) {
        themeBest.set(t, c.materialityLevel);
      }
    }
  }
  // CRITICAL/HIGH first, then MEDIUM with SUBJECT/LIKELY.
  const criticalHigh: CanonicalThemeId[] = [];
  const medium: CanonicalThemeId[] = [];
  for (const [t, level] of themeBest) {
    if (level === "CRITICAL" || level === "HIGH") criticalHigh.push(t);
    else if (level === "MEDIUM") medium.push(t);
  }
  const byName = (a: CanonicalThemeId, b: CanonicalThemeId) => a.localeCompare(b);
  return [...criticalHigh.sort(byName), ...medium.sort(byName)];
}

function selectForTheme(
  themeId: CanonicalThemeId,
  candidates: CanonicalClaim[],
  usedPlots: Set<string>,
  usedDomainsInTheme: Set<string>,
  options: {
    /**
     * When false, evidence already representing another theme is skipped. The
     * caller retries with true only for a theme that would otherwise end up
     * empty, so a theme still gets a representative but the deck stops showing
     * one article as proof of five unrelated themes (step 05.3-bis).
     */
    allowReuse?: boolean;
    /** Slots to fill in this pass. */
    maxSlots?: number;
    /** Already chosen for this theme by an earlier pass. */
    existing?: SelectedRepresentative[];
  } = {}
): SelectedRepresentative[] {
  const allowReuse = options.allowReuse ?? false;
  const maxSlots = options.maxSlots ?? 2;
  const existing = options.existing ?? [];
  const ranked = [...candidates].sort((a, b) => {
    const diff = rankClaimForTheme(b, themeId) - rankClaimForTheme(a, themeId);
    if (diff !== 0) return diff;
    return a.claimId.localeCompare(b.claimId);
  });

  const selected: SelectedRepresentative[] = [];
  const alreadyChosen = new Set(existing.map((e) => e.claimId));
  for (const claim of ranked) {
    if (selected.length >= maxSlots) break;
    if (alreadyChosen.has(claim.claimId)) continue;
    const plot = plotKeyOf(claim);
    if (!allowReuse && usedPlots.has(plot)) continue;
    // Domain of the material the lead title came from — never sourceDomains[0],
    // whose order is unrelated to originalTitle (step 05.3).
    const domain = leadDomainOf(claim);
    // Prefer independent domain for 2nd slot; allow same domain only if no alternative.
    if (
      existing.length + selected.length === 1 &&
      domain &&
      usedDomainsInTheme.has(domain) &&
      ranked.some((c) => {
        const d = leadDomainOf(c);
        return d && !usedDomainsInTheme.has(d) && (allowReuse || !usedPlots.has(plotKeyOf(c)));
      })
    ) {
      continue;
    }

    const excerpt = buildSemanticDisplayExcerpt(claim);
    const reasons = [
      `coverage_theme:${themeId}`,
      `materiality:${claim.materialityLevel}`,
      `subject:${claim.subjectMatch}`,
      `rank:${rankClaimForTheme(claim, themeId)}`,
    ];
    if (domain && REPUTABLE.test(domain)) reasons.push("reputable_domain");
    if (domain && OFFICIAL_DOMAIN.test(domain)) reasons.push("official_domain");
    if (existing.length + selected.length === 1 && domain && !usedDomainsInTheme.has(domain)) {
      reasons.push("independent_domain_slot");
    }
    if (allowReuse && usedPlots.has(plot)) reasons.push("reused_across_themes");

    selected.push({
      claimId: claim.claimId,
      themeId,
      rankInTheme: existing.length + selected.length + 1,
      originalTitle: claim.originalTitle,
      sourceDomain: domain,
      displayExcerpt: excerpt,
      fullClaimTextRef: `claim:${claim.claimId}:fullClaimText`,
      claimKind: claim.claimKind,
      materialityLevel: claim.materialityLevel,
      evidenceRefs: [...claim.evidenceRefs],
      selectionReasons: reasons,
      plotKey: plot,
    });
    usedPlots.add(plot);
    if (domain) usedDomainsInTheme.add(domain);
  }
  return selected;
}

export function selectRepresentativeEvidence(
  input: RepresentativeSelectInput
): {
  selection: RepresentativeEvidenceSelection;
  coverage: RepresentativeCoverageReport;
  excluded: ExcludedMaterialityReport;
} {
  // Deterministic claim order.
  const claims = [...input.claimsBundle.claims].sort((a, b) =>
    a.claimId.localeCompare(b.claimId)
  );
  const materialThemes = collectMaterialThemes(claims);

  // Pass 1: CRITICAL/HIGH themes, Pass 2: MEDIUM — already ordered in materialThemes.
  // Plot dedupe spans themes: a theme first looks for evidence nobody else is
  // using. Reuse stays possible, but only as a fallback for a theme that would
  // otherwise be empty — see selectForTheme(allowReuse).
  const usedPlotsAcrossThemes = new Set<string>();
  const selectedByTheme: Record<string, SelectedRepresentative[]> = {};
  const selectedClaimIds = new Set<string>();
  let excerptTruncations = 0;

  // Slots are handed out in rounds rather than theme by theme: a greedy first
  // theme used to take both of its slots and leave the next theme nothing but
  // reused evidence. Round 1 gives every theme one material nobody else shows,
  // round 2 tops themes up to two, and only then may a still-empty theme reuse.
  const candidatesByTheme = new Map<CanonicalThemeId, CanonicalClaim[]>();
  const domainsByTheme = new Map<CanonicalThemeId, Set<string>>();
  for (const themeId of materialThemes) {
    candidatesByTheme.set(
      themeId,
      claims.filter(
        (c) =>
          isMaterialClaim(c) &&
          c.themeIds.includes(themeId) &&
          (c.subjectMatch === "SUBJECT_MATCH" ||
            c.subjectMatch === "LIKELY_SUBJECT" ||
            c.summaryOverrideRequired)
      )
    );
    domainsByTheme.set(themeId, new Set<string>());
    selectedByTheme[themeId] = [];
  }

  const passes: Array<{ maxSlots: number; allowReuse: boolean; onlyIfEmpty: boolean }> = [
    { maxSlots: 1, allowReuse: false, onlyIfEmpty: false },
    { maxSlots: 1, allowReuse: false, onlyIfEmpty: false },
    { maxSlots: 1, allowReuse: true, onlyIfEmpty: true },
  ];

  for (const pass of passes) {
    for (const themeId of materialThemes) {
      const existing = selectedByTheme[themeId]!;
      if (pass.onlyIfEmpty && existing.length > 0) continue;
      if (existing.length >= 2) continue;
      const picked = selectForTheme(
        themeId,
        candidatesByTheme.get(themeId) ?? [],
        usedPlotsAcrossThemes,
        domainsByTheme.get(themeId)!,
        { allowReuse: pass.allowReuse, maxSlots: pass.maxSlots, existing }
      );
      existing.push(...picked);
    }
  }

  for (const themeId of materialThemes) {
    for (const s of selectedByTheme[themeId] ?? []) {
      selectedClaimIds.add(s.claimId);
      const claim = claims.find((c) => c.claimId === s.claimId);
      if (claim) {
        excerptTruncations += countSemanticTruncations(s.displayExcerpt, claim.fullClaimText);
      }
    }
  }

  // Isolated HIGH/CRITICAL that did not form a covered material theme slot
  // and were not selected (single-shot significant items).
  const isolatedSignificantItems: IsolatedSignificantItem[] = [];
  for (const c of claims) {
    if (c.subjectMatch === "OTHER_SUBJECT") continue;
    if (c.materialityLevel !== "CRITICAL" && c.materialityLevel !== "HIGH") continue;
    if (selectedClaimIds.has(c.claimId)) continue;
    const themes = c.themeIds.filter((t) => t !== "identity_mismatch");
    const coveredByTheme = themes.some((t) => (selectedByTheme[t] ?? []).length > 0);
    // If claim's themes are all uncovered (no material theme list entry) → isolated.
    const inMaterialList = themes.some((t) => materialThemes.includes(t));
    if (!inMaterialList || !coveredByTheme) {
      const excerpt = buildSemanticDisplayExcerpt(c);
      excerptTruncations += countSemanticTruncations(excerpt, c.fullClaimText);
      isolatedSignificantItems.push({
        claimId: c.claimId,
        reasonCode: !inMaterialList
          ? "isolated_significant:no_stable_theme"
          : "isolated_significant:not_selected_for_theme_slots",
        materialityLevel: c.materialityLevel,
        originalTitle: c.originalTitle,
        sourceDomains: [...c.sourceDomains],
        evidenceRefs: [...c.evidenceRefs],
        displayExcerpt: excerpt,
        fullClaimTextRef: `claim:${c.claimId}:fullClaimText`,
      });
      selectedClaimIds.add(c.claimId);
    }
  }
  isolatedSignificantItems.sort((a, b) => a.claimId.localeCompare(b.claimId));

  // P1/P2 finding accounting from claim provenance.findingIds.
  const p1p2FindingIds = new Set<string>();
  for (const c of claims) {
    for (const fid of c.provenance.findingIds) {
      if (/-(subject_match|likely_subject)-/iu.test(fid) || fid.includes("finding-")) {
        // Heuristic: finding ids from synthesizer with P1/P2 are on SUBJECT_MATCH claims
        // with CRITICAL/HIGH or summaryOverride.
        if (
          c.subjectMatch === "SUBJECT_MATCH" &&
          (c.materialityLevel === "CRITICAL" ||
            c.materialityLevel === "HIGH" ||
            c.summaryOverrideRequired)
        ) {
          p1p2FindingIds.add(fid);
        }
      }
    }
  }

  const p1p2Account: P1P2Account[] = [];
  for (const findingId of [...p1p2FindingIds].sort()) {
    const related = claims.filter((c) => c.provenance.findingIds.includes(findingId));
    const inSelection = related.some((c) => selectedClaimIds.has(c.claimId));
    if (inSelection) {
      p1p2Account.push({
        findingId,
        status: "IN_SUMMARY_SELECTION",
        reasonCode: "represented_via_selected_claim",
        claimIds: related.filter((c) => selectedClaimIds.has(c.claimId)).map((c) => c.claimId),
      });
    } else {
      p1p2Account.push({
        findingId,
        status: "APPENDIX_WITH_REASON",
        reasonCode: "appendix:covered_by_theme_quota_or_duplicate_plot",
        claimIds: related.map((c) => c.claimId),
      });
    }
  }

  const coveredThemes = materialThemes.filter((t) => (selectedByTheme[t] ?? []).length > 0);
  const coveragePct =
    materialThemes.length === 0
      ? 100
      : Math.round((coveredThemes.length / materialThemes.length) * 10000) / 100;
  const p1p2AccountedPct =
    p1p2Account.length === 0
      ? 100
      : Math.round(
          (p1p2Account.filter((a) => a.status === "IN_SUMMARY_SELECTION" || a.reasonCode.length > 0)
            .length /
            p1p2Account.length) *
            10000
        ) / 100;

  // Excluded materiality: material claims not selected and not isolated.
  const excludedRows: ExcludedMaterialityReport["excluded"] = [];
  for (const c of claims) {
    if (!isMaterialClaim(c)) continue;
    if (selectedClaimIds.has(c.claimId)) continue;
    if (isolatedSignificantItems.some((i) => i.claimId === c.claimId)) continue;
    excludedRows.push({
      claimId: c.claimId,
      materialityLevel: c.materialityLevel,
      themeIds: [...c.themeIds],
      reasonCode: "excluded_after_theme_coverage:duplicate_plot_or_slot_filled",
      evidenceRefs: [...c.evidenceRefs],
    });
  }

  const selection: RepresentativeEvidenceSelection = {
    schemaVersion: REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: [
      ...new Set(
        Object.values(selectedByTheme)
          .flat()
          .flatMap((s) => s.evidenceRefs)
          .concat(isolatedSignificantItems.flatMap((i) => i.evidenceRefs))
      ),
    ],
    subjectId: input.subjectId,
    materialThemeIds: materialThemes,
    selectedByTheme,
    isolatedSignificantItems,
    p1p2Account,
    gates: {
      MATERIAL_THEME_COVERAGE: coveragePct,
      P1_P2_ACCOUNTED: p1p2AccountedPct,
      SEMANTIC_EXCERPT_TRUNCATIONS: excerptTruncations,
    },
  };

  const coverage: RepresentativeCoverageReport = {
    schemaVersion: REPRESENTATIVE_COVERAGE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    subjectId: input.subjectId,
    themes: materialThemes.map((themeId) => {
      const sels = selectedByTheme[themeId] ?? [];
      const levels = claims
        .filter((c) => c.themeIds.includes(themeId) && isMaterialClaim(c))
        .map((c) => c.materialityLevel);
      return {
        themeId,
        materialityCeiling: maxLevel(levels),
        selectedClaimIds: sels.map((s) => s.claimId),
        evidenceRefs: [...new Set(sels.flatMap((s) => s.evidenceRefs))],
        covered: sels.length > 0,
      };
    }),
    generatedAt: new Date().toISOString(),
  };

  const excluded: ExcludedMaterialityReport = {
    schemaVersion: EXCLUDED_MATERIALITY_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    excluded: excludedRows.sort((a, b) => a.claimId.localeCompare(b.claimId)),
    generatedAt: new Date().toISOString(),
  };

  return {
    selection: RepresentativeEvidenceSelectionSchema.parse(selection),
    coverage: RepresentativeCoverageReportSchema.parse(coverage),
    excluded: ExcludedMaterialityReportSchema.parse(excluded),
  };
}

export function assertRepresentativeGatesPass(
  selection: RepresentativeEvidenceSelection
): void {
  const g = selection.gates;
  if (g.MATERIAL_THEME_COVERAGE !== 100) {
    throw new Error(`MATERIAL_THEME_COVERAGE=${g.MATERIAL_THEME_COVERAGE}`);
  }
  if (g.P1_P2_ACCOUNTED !== 100) {
    throw new Error(`P1_P2_ACCOUNTED=${g.P1_P2_ACCOUNTED}`);
  }
  if (g.SEMANTIC_EXCERPT_TRUNCATIONS !== 0) {
    throw new Error(`SEMANTIC_EXCERPT_TRUNCATIONS=${g.SEMANTIC_EXCERPT_TRUNCATIONS}`);
  }
}

export function representativeSelectionFingerprint(
  selection: RepresentativeEvidenceSelection
): string {
  const rows: string[] = [];
  for (const themeId of [...selection.materialThemeIds].sort()) {
    for (const s of selection.selectedByTheme[themeId] ?? []) {
      rows.push(`${themeId}|${s.rankInTheme}|${s.claimId}|${s.plotKey}`);
    }
  }
  for (const i of selection.isolatedSignificantItems) {
    rows.push(`isolated|${i.claimId}|${i.reasonCode}`);
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export function themeCoverageLabel(themeId: CanonicalThemeId): string {
  return themeLabelRu(themeId);
}
