/**
 * Section-level QA — every SectionPack must pass before assembly.
 * A failed pack never reaches the DeckAssembler.
 */

import { SectionPackV2Schema, type SectionPackV2 } from "./contracts";
import { normalizeEvidenceRef, type ScopedEvidenceIndex } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";

export type SectionValidationReport = {
  fragmentKey: string;
  passed: boolean;
  issues: string[];
};

/**
 * Templates whose dynamic sidebar/what-found copy must be strictly derived
 * from the slide's own evidence refs (page scope) — never from region- or
 * bundle-level findings/domains.
 */
const PAGE_SCOPED_TEMPLATES = new Set([
  "serp-screenshot-analysis",
  "suggestions",
  "image-grid",
  "wikipedia-knowledge",
  "ai-overview",
  "related-queries",
  "serp-table",
]);

/** Fragments whose serp-table slides carry region-level summary rows. */
const REGION_SUMMARY_FRAGMENTS = new Set(["RU_SUMMARY", "UAE_SUMMARY", "COMPLIANCE_MAIN"]);

// Domain-like tokens: labels ending in an alphabetic TLD (avoids numbers/dates).
const DOMAIN_TOKEN_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu;

const INTERNAL_TOKENS =
  /\baudit\b|reportRunId|report_run|datasetId|pipeline|arsenkin|serp[-_]obs|inventoryId|schemaVersion/iu;

const TEXT_BUDGETS = {
  title: 120,
  narrative: 900,
  bullet: 400,
  whatWasFound: 400,
  whyItMatters: 320,
  whatToCheck: 220,
};

export function validateSectionPack(input: {
  pack: SectionPackV2;
  expectedReportRunId: string;
  expectedDatasetId: string;
  bundle: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  /** Full run evidence index for the sidebar domain-derivation gate. */
  evidenceIndex?: ScopedEvidenceIndex;
}): SectionValidationReport {
  const issues: string[] = [];
  const { pack } = input;

  // 1. Schema valid.
  const parsed = SectionPackV2Schema.safeParse(pack);
  if (!parsed.success) {
    issues.push(`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  // 2/3. Lineage matches.
  if (pack.reportRunId !== input.expectedReportRunId) {
    issues.push(`foreign reportRunId: ${pack.reportRunId}`);
  }
  if (pack.sourceDatasetId !== input.expectedDatasetId) {
    issues.push(`stale sourceDatasetId: ${pack.sourceDatasetId}`);
  }

  // 4/5. All findingIds and evidenceRefs must exist.
  const knownFindings = new Set([
    ...input.bundle.findings.map((f) => f.findingId),
    ...(input.bundle.excludedFindingIds ?? []),
  ]);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!knownFindings.has(id)) issues.push(`unknown findingId on ${slide.slideId}: ${id}`);
    }
    for (const ref of slide.evidenceRefs) {
      if (!input.knownEvidenceRefs.has(ref)) {
        issues.push(`unknown evidenceRef on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 6. OTHER_SUBJECT never enters subject KPI slides.
  const otherSubjectIds = new Set(
    input.bundle.findings
      .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
      .map((f) => f.findingId)
  );
  if (pack.fragmentKey !== "APPENDIX_MAIN") {
    for (const slide of pack.slides) {
      for (const id of slide.findingIds) {
        if (otherSubjectIds.has(id)) {
          issues.push(`OTHER_SUBJECT finding in subject KPI slide ${slide.slideId}: ${id}`);
        }
      }
    }
  }

  // 7. Client text within budgets; 8. no internal tokens; unsupported claims
  // guard: any narrative sentence naming a findingId must reference a known one
  // (covered by findingIds check + bullets carry [findingId] markers).
  for (const slide of pack.slides) {
    checkText(issues, slide.slideId, "title", slide.title, TEXT_BUDGETS.title);
    checkText(issues, slide.slideId, "narrative", slide.content.narrative, TEXT_BUDGETS.narrative);
    checkText(issues, slide.slideId, "whatWasFound", slide.content.whatWasFound, TEXT_BUDGETS.whatWasFound);
    checkText(issues, slide.slideId, "whyItMatters", slide.content.whyItMatters, TEXT_BUDGETS.whyItMatters);
    checkText(issues, slide.slideId, "whatToCheck", slide.content.whatToCheck, TEXT_BUDGETS.whatToCheck);
    for (const b of slide.content.bullets ?? []) {
      // AI answers are exempt from the bullet budget (no truncation allowed),
      // but never from the internal-token check.
      const budget = slide.templateId === "ai-overview" ? Number.MAX_SAFE_INTEGER : TEXT_BUDGETS.bullet;
      checkText(issues, slide.slideId, "bullet", b, budget);
    }
    for (const row of slide.content.table?.rows ?? []) {
      for (const cell of row) {
        if (INTERNAL_TOKENS.test(stripFindingMarkers(cell))) {
          issues.push(`internal token in table cell on ${slide.slideId}: "${cell.slice(0, 60)}"`);
        }
      }
    }
  }

  // 9. Local metrics reconcile.
  if (pack.metrics.adverseDisplayedCount > pack.metrics.adverseDatasetCount) {
    issues.push("metrics: adverseDisplayedCount > adverseDatasetCount");
  }
  if (pack.metrics.displayedCount > pack.metrics.datasetCount && pack.metrics.datasetCount > 0) {
    issues.push("metrics: displayedCount > datasetCount");
  }

  // 10. Continuation structure valid: each continuation references an earlier
  // base slide in the same pack and indexes are sequential.
  const baseIds = new Set(pack.slides.filter((s) => !s.isContinuation).map((s) => s.slideId));
  const contByBase = new Map<string, number[]>();
  for (const slide of pack.slides) {
    if (!slide.isContinuation) continue;
    if (!slide.continuationOf || !baseIds.has(slide.continuationOf)) {
      issues.push(`continuation ${slide.slideId} has no base slide in pack`);
      continue;
    }
    const list = contByBase.get(slide.continuationOf) ?? [];
    list.push(slide.continuationIndex ?? -1);
    contByBase.set(slide.continuationOf, list);
  }
  for (const [b, idx] of contByBase) {
    const sorted = [...idx].sort((a, z) => a - z);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        issues.push(`continuation indexes for ${b} not sequential: ${sorted.join(",")}`);
        break;
      }
    }
  }

  // Status/slide coherence.
  if (pack.status === "READY" && pack.slides.length === 0) {
    issues.push("READY pack has no slides");
  }
  if (pack.status === "EMPTY_VALID" && pack.slides.length > 0) {
    issues.push("EMPTY_VALID pack must not carry slides");
  }

  // 11. Sidebar scope subsets (fail closed): every slide's findingIds and
  // evidenceRefs must stay inside the fragment's own scoped inputs — no
  // fallback to global VerifiedFindingBundle findings or global domains.
  const inputFindingIds = new Set(pack.inputs.findingIds);
  const inputRefs = new Set(pack.inputs.evidenceRefs);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!inputFindingIds.has(id)) {
        issues.push(`sidebar findingId outside fragment scope on ${slide.slideId}: ${id}`);
      }
    }
    for (const ref of slide.evidenceRefs) {
      if (!inputRefs.has(ref)) {
        issues.push(`sidebar evidenceRef outside fragment scope on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 12. Page-scope domain derivation (fail closed): on page-scoped templates
  // every source domain named in the dynamic conclusion, source footer or
  // highlight explanations must be derivable from that slide's OWN evidence
  // refs — never from an unrelated global domain list.
  if (input.evidenceIndex && !REGION_SUMMARY_FRAGMENTS.has(pack.fragmentKey)) {
    for (const slide of pack.slides) {
      if (!PAGE_SCOPED_TEMPLATES.has(slide.templateId)) continue;
      const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
      const allowed = new Set<string>();
      for (const [ref, e] of Object.entries(input.evidenceIndex)) {
        if (!e.domain || e.domain === "—") continue;
        if (normRefs.has(normalizeEvidenceRef(ref))) allowed.add(e.domain.toLowerCase());
      }
      const dynamicTexts = [
        slide.content.whatWasFound,
        slide.content.sourceNote,
        ...(slide.content.highlightExplanations ?? []).map((h) => h.clientReason),
      ].filter((t): t is string => Boolean(t));
      for (const text of dynamicTexts) {
        for (const m of text.matchAll(DOMAIN_TOKEN_RE)) {
          const domain = m[0].toLowerCase();
          if (!allowed.has(domain)) {
            issues.push(
              `sidebar domain not derived from page evidence on ${slide.slideId}: ${domain}`
            );
          }
        }
      }
    }
  }

  return { fragmentKey: pack.fragmentKey, passed: issues.length === 0, issues };
}

function stripFindingMarkers(text: string): string {
  return (
    text
      .replace(/\[finding-[^\]]+\]/gu, "")
      // Domains from evidence URLs are legitimate client-facing content
      // (e.g. audit-it.ru); the technical-token check must not match them.
      .replace(/\b[\w-]+(?:\.[\w-]+)+\b/gu, "")
  );
}

function checkText(
  issues: string[],
  slideId: string,
  field: string,
  value: string | undefined,
  budget: number
): void {
  if (!value) return;
  if (value.length > budget) {
    issues.push(`${field} over budget on ${slideId}: ${value.length}>${budget}`);
  }
  if (INTERNAL_TOKENS.test(stripFindingMarkers(value))) {
    issues.push(`internal token in ${field} on ${slideId}: "${value.slice(0, 60)}"`);
  }
}
