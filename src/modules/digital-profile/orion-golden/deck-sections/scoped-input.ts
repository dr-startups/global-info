/**
 * Scoped inputs for independent section/surface builders.
 *
 * Allowed shared read-only inputs: SubjectProfile, VerifiedFindingBundle,
 * MetricSnapshot, ThemeSet, TemplateRegistry. Every fragment builder receives
 * ONLY a scoped slice filtered by region / surface / subjectMatch / findingId
 * — never UAE findings inside an RU builder, never the raw observation
 * dataset, never the whole executive summary.
 */

import { createHash } from "node:crypto";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";

export type SubjectProfileInput = {
  displayName: string;
  aliases: string[];
};

export type MetricSnapshot = {
  metricSnapshotId: string;
  datasetId: string;
  reportRunId: string;
  baseCount: number;
  enrichmentCount: number;
  compositeCount: number;
  subjectMatchCount: number;
  /** Surname+context / shared domain — visible but not KPI (§2.1). */
  likelySubjectCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  adverseFindingCount: number;
  perRegionCounts: Record<string, number>;
};

export type FragmentScope = {
  regions: string[] | null; // null = all regions (executive)
  surfaces: SurfaceKind[] | null; // null = all surfaces
  /**
   * Optional override for surface-unit filtering when it must differ from the
   * finding filter (e.g. regional summary: all regional findings + url_audit
   * units only). When omitted, `surfaces` governs both.
   */
  unitSurfaces?: SurfaceKind[] | null;
  subjectMatch: Array<Finding["subjectMatch"]> | null;
  findingIds: string[] | null;
};

/** Point lookup for scoped evidence refs only — never the raw dataset. */
export type ScopedEvidenceIndex = Record<
  string,
  {
    url?: string;
    domain?: string;
    title?: string;
    adverse?: boolean;
    kind?: string;
    region?: string;
    /** Search engine the observation was captured from (YANDEX/GOOGLE). */
    engine?: string;
    /** Compliance databases: human-readable provider name (Dow Jones, ...). */
    providerLabel?: string;
    /** Compliance databases: match category (PEP / ADVERSE_MEDIA / SANCTIONS). */
    matchCategory?: string;
    /** Compliance databases: match score 0–100. */
    matchScore?: number;
    /** Compliance databases: review status (e.g. PENDING). */
    reviewStatus?: string;
    /** WikipediaCheck.exists — factual check, not SERP domain inference. */
    wikipediaExists?: boolean;
    /** WikipediaCheck.language (ru / en / …). */
    language?: string;
    /** Subject-resolution decision for this evidence ref (§2.1). */
    subjectDecision?: string;
  }
>;

export type ScopedFragmentInput = {
  subject: SubjectProfileInput;
  findings: Finding[];
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  /** Evidence details restricted to refs reachable from the scoped slice. */
  evidenceIndex: ScopedEvidenceIndex;
};

const REGION_ALIASES: Record<string, string[]> = {
  RU: ["RU"],
  UAE: ["UAE", "INTERNATIONAL", "GLOBAL"],
};

/**
 * Normalize evidence refs so a run's asset refs (`serp_observation:<id>`,
 * `ru_search_results-sf-<id>`) and finding refs (`inventory:serp-obs-<id>`,
 * `inventory:ss-<id>`) compare by the underlying observation/result id.
 */
export function normalizeEvidenceRef(ref: string): string {
  return ref
    .replace(/^serp_observation:/u, "")
    .replace(/^inventory:serp-obs-/u, "")
    .replace(/^inventory:ss-/u, "")
    .replace(/^[a-z]+_search_results-sf-/u, "");
}

export function regionMatches(scopeRegion: string, value: string | undefined): boolean {
  if (!value) return false;
  const aliases = REGION_ALIASES[scopeRegion] ?? [scopeRegion];
  return aliases.includes(value.toUpperCase());
}

export function scopeFindings(bundle: VerifiedFindingBundle, scope: FragmentScope): Finding[] {
  return bundle.findings.filter((f) => {
    if (scope.findingIds && !scope.findingIds.includes(f.findingId)) return false;
    if (scope.subjectMatch && !scope.subjectMatch.includes(f.subjectMatch)) return false;
    if (scope.regions) {
      const hit = scope.regions.some((r) => (f.regions ?? []).some((fr) => regionMatches(r, fr)));
      if (!hit) return false;
    }
    // Empty surfaces array means "no surface units, but findings unfiltered"
    // (summary/executive scopes depend on findings, not per-surface claims).
    if (scope.surfaces && scope.surfaces.length > 0) {
      const kinds = (f.surfaceKinds ?? []) as string[];
      // Findings without surface tags stay visible to summary-level scopes only.
      if (kinds.length > 0 && !kinds.some((k) => (scope.surfaces as string[]).includes(k))) {
        return false;
      }
    }
    return true;
  });
}

export function scopeSurfaceUnits(
  units: SurfaceAnalysisUnit[],
  scope: FragmentScope
): SurfaceAnalysisUnit[] {
  const unitFilter = scope.unitSurfaces !== undefined ? scope.unitSurfaces : scope.surfaces;
  return units.filter((u) => {
    if (unitFilter && !unitFilter.includes(u.surface)) return false;
    if (scope.regions && !scope.regions.some((r) => regionMatches(r, u.region))) return false;
    return true;
  });
}

export function buildScopedInput(input: {
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  evidenceIndex?: ScopedEvidenceIndex;
}): ScopedFragmentInput {
  const findings = scopeFindings(input.bundle, input.scope);
  const surfaceUnits = scopeSurfaceUnits(input.surfaceUnits, input.scope);
  // Restrict the evidence index to refs reachable from the scoped slice.
  const reachable = new Set<string>();
  for (const f of findings) for (const r of f.evidenceRefs) reachable.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) reachable.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) reachable.add(r);
  }
  const evidenceIndex: ScopedEvidenceIndex = {};
  const unitFilter =
    input.scope.unitSurfaces !== undefined ? input.scope.unitSurfaces : input.scope.surfaces;
  const wantsSurface = (s: string): boolean =>
    unitFilter == null || (unitFilter as string[]).includes(s);
  // Region+surface-scoped observation evidence not reachable through claims
  // (e.g. the exact observation rows a bound visual asset was built from).
  // `kind` carries the surface for composite observations; visual/structured
  // kinds map onto their owning surface explicitly.
  const KIND_TO_SURFACE: Record<string, string> = {
    serp_screenshot: "organic",
    knowledge_block: "ai_answers",
  };
  for (const [ref, entry] of Object.entries(input.evidenceIndex ?? {})) {
    if (reachable.has(ref)) {
      evidenceIndex[ref] = entry;
      continue;
    }
    // REMEDIATION §3.2 — themeless subject materials are not attached to
    // findings/units; admit them by region so regional summaries can cite them
    // without failing sidebar-scope QA.
    if (entry.kind === "uncategorized") {
      if (
        input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region))
      ) {
        evidenceIndex[ref] = entry;
      }
      continue;
    }
    const surfaceOfKind = entry.kind ? KIND_TO_SURFACE[entry.kind] ?? entry.kind : undefined;
    if (
      surfaceOfKind &&
      wantsSurface(surfaceOfKind) &&
      (input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region)))
    ) {
      evidenceIndex[ref] = entry;
    }
  }
  return {
    subject: input.subject,
    findings,
    surfaceUnits,
    metricSnapshot: input.metricSnapshot,
    scope: input.scope,
    evidenceIndex,
  };
}

/** Deterministic hash of the scoped input (cache key with promptVersion). */
export function scopedInputHash(scoped: ScopedFragmentInput): string {
  const payload = JSON.stringify({
    subject: scoped.subject,
    findings: scoped.findings.map((f) => ({
      id: f.findingId,
      claim: f.claim,
      risk: f.riskLevel,
      match: f.subjectMatch,
      refs: f.evidenceRefs,
      priority: f.promotionPriority,
    })),
    units: scoped.surfaceUnits.map((u) => ({
      surface: u.surface,
      region: u.region,
      metrics: u.metrics,
      claims: u.claims.map((c) => ({ id: c.claimId, text: c.text, match: c.subjectMatch })),
    })),
    snapshot: scoped.metricSnapshot,
    scope: scoped.scope,
    evidence: scoped.evidenceIndex,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
