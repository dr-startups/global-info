/**
 * REMEDIATION_PLAN §1.3 / F6 part 2 — analyst overrides into analytics.
 *
 * Sources: SearchResult manual classification, orion-golden admin-review
 * decisions, RiskFinding with reviewStatus REVIEWED ("approved").
 * Applied after subject resolution and before surface analyzers / findings.
 */

import { createHash } from "node:crypto";
import type { RawInventoryItem } from "../orion-golden/types";
import type { SubjectResolution, SubjectResolutionItem } from "../orion-golden/contracts/subject-resolution";
import type { Finding } from "../orion-golden/contracts/finding";
import {
  FINDING_SCHEMA_VERSION,
  FindingSchema,
} from "../orion-golden/contracts/finding";
import type { VerifiedFindingBundle } from "../orion-golden/contracts/verified-finding-bundle";
import { FINDING_THEMES } from "../orion-golden/analytics/finding-synthesizer";
import { domainOf } from "../orion-golden/analytics/composite-dataset-builder";
import { mapRegionBucket } from "../orion-golden/classic/composite-serp-overlay-merge";
import {
  isRiskyResultClass,
  readRiskClassification,
  type ResultClass,
  type ResultRiskTheme,
} from "../risk-classifier/result-classifier";
import { normalizeUrl } from "./evidence-service";
import type { AdminReviewStatus } from "../orion-golden/evidence/admin-review-decision";
import { loadAdminReviewDecisions } from "../orion-golden/evidence/admin-review-decision-store";

export type ClassificationOverride = {
  searchResultId: string;
  url?: string | null;
  classification: ResultClass | string;
  riskTheme?: ResultRiskTheme | string | null;
  source: "result_classification";
};

export type ManualReviewOverride = {
  evidenceId: string;
  status: AdminReviewStatus | string;
  source: "orion_manual_review";
};

export type ApprovedFindingOverride = {
  findingId: string;
  riskTheme: string | null;
  category: string;
  title: string;
  evidenceRefs: string[];
  source: "risk_finding_reviewed";
};

export type AnalystOverridesBundle = {
  version: "analyst-overrides-v1";
  caseId: string;
  classification: ClassificationOverride[];
  manualReview: ManualReviewOverride[];
  approvedFindings: ApprovedFindingOverride[];
};

export type AppliedOverrideRecord = {
  kind:
    | "classification_adverse"
    | "classification_neutral"
    | "identity_other_subject"
    | "manual_review_wrong_subject"
    | "manual_review_excluded"
    | "approved_finding";
  matchKey: string;
  inventoryId?: string;
  effect: string;
};

export type AnalystOverridesAppliedArtifact = {
  version: "analyst-overrides-applied-v1";
  caseId: string;
  count: number;
  applied: AppliedOverrideRecord[];
};

export type AnalystOverridesPrisma = {
  searchResult: {
    // `any` args: PrismaClient delegates must assign without enum/filter friction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<
      Array<{
        id: string;
        url?: string | null;
        rawMetadata?: unknown;
      }>
    >;
  };
  riskFinding: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<
      Array<{
        id: string;
        category: string;
        riskTheme?: string | null;
        title: string;
        evidenceRefs?: unknown;
      }>
    >;
  };
};

function emptyBundle(caseId: string): AnalystOverridesBundle {
  return {
    version: "analyst-overrides-v1",
    caseId,
    classification: [],
    manualReview: [],
    approvedFindings: [],
  };
}

function normalizeSearchResultKey(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /^(?:searchResult|SEARCH_RESULT|search_result):(.+)$/iu.exec(s);
  if (m) return `searchResult:${m[1]}`;
  // bare id (cuid / fixture) — treat as searchResult
  if (!s.includes(":")) return `searchResult:${s}`;
  return null;
}

function evidenceRefStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const kind = String(o.kind ?? o.type ?? "evidence");
        const id = String(o.id ?? o.ref ?? "");
        return id ? `${kind}:${id}` : "";
      }
      return "";
    })
    .filter(Boolean);
}

function itemSearchResultKeys(item: RawInventoryItem): string[] {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const keys = new Set<string>();
  for (const ref of [
    ...evidenceRefStrings(meta.sourceEvidenceRefs),
    ...evidenceRefStrings(meta.evidenceRefs),
  ]) {
    const k = normalizeSearchResultKey(ref);
    if (k) keys.add(k);
  }
  const baseId = meta.baseSearchResultId;
  if (typeof baseId === "string" && baseId.trim()) {
    keys.add(`searchResult:${baseId.trim()}`);
  }
  return [...keys];
}

function itemNormalizedUrl(item: RawInventoryItem): string {
  return item.sourceUrl ? normalizeUrl(item.sourceUrl) : "";
}

/** Index inventory for override matching. */
export function buildInventoryOverrideIndex(items: RawInventoryItem[]): {
  bySearchResult: Map<string, RawInventoryItem[]>;
  byUrl: Map<string, RawInventoryItem[]>;
  byInventoryId: Map<string, RawInventoryItem>;
} {
  const bySearchResult = new Map<string, RawInventoryItem[]>();
  const byUrl = new Map<string, RawInventoryItem[]>();
  const byInventoryId = new Map<string, RawInventoryItem>();
  for (const item of items) {
    byInventoryId.set(item.inventoryId, item);
    for (const key of itemSearchResultKeys(item)) {
      const bucket = bySearchResult.get(key) ?? [];
      bucket.push(item);
      bySearchResult.set(key, bucket);
    }
    const url = itemNormalizedUrl(item);
    if (url) {
      const bucket = byUrl.get(url) ?? [];
      bucket.push(item);
      byUrl.set(url, bucket);
    }
  }
  return { bySearchResult, byUrl, byInventoryId };
}

export function findInventoryForOverride(
  index: ReturnType<typeof buildInventoryOverrideIndex>,
  opts: { searchResultId?: string; url?: string | null; evidenceId?: string }
): RawInventoryItem[] {
  const out: RawInventoryItem[] = [];
  const seen = new Set<string>();
  const push = (items: RawInventoryItem[] | undefined) => {
    for (const it of items ?? []) {
      if (seen.has(it.inventoryId)) continue;
      seen.add(it.inventoryId);
      out.push(it);
    }
  };

  if (opts.searchResultId) {
    const key = normalizeSearchResultKey(opts.searchResultId);
    if (key) push(index.bySearchResult.get(key));
  }
  if (opts.evidenceId) {
    const key = normalizeSearchResultKey(opts.evidenceId);
    if (key) push(index.bySearchResult.get(key));
    const inv = index.byInventoryId.get(opts.evidenceId.replace(/^inventory:/u, ""));
    if (inv) push([inv]);
    // evidenceId may be inventory:obs-… or bare inventoryId
    if (opts.evidenceId.startsWith("inventory:")) {
      const inv2 = index.byInventoryId.get(opts.evidenceId.slice("inventory:".length));
      if (inv2) push([inv2]);
    }
  }
  if (opts.url) {
    push(index.byUrl.get(normalizeUrl(opts.url)));
  }
  return out;
}

export async function loadAnalystOverrides(input: {
  caseId: string;
  prisma?: AnalystOverridesPrisma | null;
  /** Offline fixture wins over prisma. */
  fixture?: AnalystOverridesBundle | null;
}): Promise<AnalystOverridesBundle> {
  if (input.fixture != null) {
    return {
      ...emptyBundle(input.caseId),
      ...input.fixture,
      version: "analyst-overrides-v1",
      caseId: input.caseId,
    };
  }
  if (!input.prisma) return emptyBundle(input.caseId);

  const classification: ClassificationOverride[] = [];
  const rows = await input.prisma.searchResult.findMany({
    where: { caseId: input.caseId },
    select: { id: true, url: true, rawMetadata: true },
  });
  for (const row of rows) {
    const manual = readRiskClassification(row.rawMetadata)?.manual;
    if (!manual) continue;
    classification.push({
      searchResultId: row.id,
      url: row.url ?? null,
      classification: manual.classification,
      riskTheme: manual.riskTheme,
      source: "result_classification",
    });
  }

  const manualReview: ManualReviewOverride[] = [];
  const decisions = loadAdminReviewDecisions(input.caseId);
  for (const d of decisions?.decisions ?? []) {
    if (!d.evidenceId || !d.status || d.status === "PENDING") continue;
    manualReview.push({
      evidenceId: d.evidenceId,
      status: d.status,
      source: "orion_manual_review",
    });
  }

  const approvedFindings: ApprovedFindingOverride[] = [];
  const findings = await input.prisma.riskFinding.findMany({
    where: { caseId: input.caseId, reviewStatus: "REVIEWED" },
    select: {
      id: true,
      category: true,
      riskTheme: true,
      title: true,
      evidenceRefs: true,
    },
  });
  for (const f of findings) {
    approvedFindings.push({
      findingId: f.id,
      riskTheme: f.riskTheme ?? null,
      category: f.category,
      title: f.title,
      evidenceRefs: evidenceRefStrings(f.evidenceRefs).map(
        (r) => normalizeSearchResultKey(r) ?? r
      ),
      source: "risk_finding_reviewed",
    });
  }

  return {
    version: "analyst-overrides-v1",
    caseId: input.caseId,
    classification,
    manualReview,
    approvedFindings,
  };
}

function setIdentityDecision(
  resolutionByRef: Map<string, SubjectResolutionItem>,
  subjectResolution: SubjectResolution,
  inventoryId: string,
  decision: "OTHER_SUBJECT",
  reasonCode: string
): void {
  const evidenceRef = `inventory:${inventoryId}`;
  const prev = resolutionByRef.get(evidenceRef);
  const next: SubjectResolutionItem = {
    evidenceRef,
    decision,
    confidence: 0.99,
    matchedIdentifiers: prev?.matchedIdentifiers ?? [],
    conflictingIdentifiers: prev?.conflictingIdentifiers ?? [],
    reasonCode,
  };
  resolutionByRef.set(evidenceRef, next);
  const idx = subjectResolution.items.findIndex((i) => i.evidenceRef === evidenceRef);
  if (idx >= 0) subjectResolution.items[idx] = next;
  else subjectResolution.items.push(next);
}

function markAdverse(item: RawInventoryItem, riskTheme?: string | null): void {
  item.classification = "adverse_media";
  const meta = { ...(item.rawMetadata ?? {}) };
  meta.analystAdverse = true;
  delete meta.analystNeutral;
  if (riskTheme) meta.riskTheme = riskTheme;
  item.rawMetadata = meta;
}

function markNeutral(item: RawInventoryItem): void {
  item.classification = "neutral";
  const meta = { ...(item.rawMetadata ?? {}) };
  meta.analystNeutral = true;
  delete meta.analystAdverse;
  item.rawMetadata = meta;
}

/**
 * Apply loaded overrides onto inventory + subject resolution.
 * Mutates items / resolution maps in place; returns applied audit trail.
 */
export function applyAnalystOverrides(input: {
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  subjectResolution: SubjectResolution;
  overrides: AnalystOverridesBundle;
}): {
  applied: AppliedOverrideRecord[];
  guaranteedFindings: ApprovedFindingOverride[];
} {
  const index = buildInventoryOverrideIndex(input.items);
  const applied: AppliedOverrideRecord[] = [];

  for (const ov of input.overrides.classification) {
    const matched = findInventoryForOverride(index, {
      searchResultId: ov.searchResultId,
      url: ov.url,
    });
    const matchKey = `searchResult:${ov.searchResultId}`;
    if (matched.length === 0) continue;

    const risky = isRiskyResultClass(ov.classification);
    const neutral =
      String(ov.classification).toUpperCase() === "NEUTRAL" ||
      String(ov.classification).toUpperCase() === "POSITIVE" ||
      String(ov.classification).toUpperCase() === "IRRELEVANT";

    for (const item of matched) {
      if (risky) {
        markAdverse(item, ov.riskTheme ? String(ov.riskTheme) : null);
        applied.push({
          kind: "classification_adverse",
          matchKey,
          inventoryId: item.inventoryId,
          effect: `classification:=adverse_media theme=${ov.riskTheme ?? "n/a"}`,
        });
      } else if (neutral) {
        markNeutral(item);
        applied.push({
          kind: "classification_neutral",
          matchKey,
          inventoryId: item.inventoryId,
          effect: "exclude from adverse counts",
        });
      }
    }
  }

  for (const ov of input.overrides.manualReview) {
    const matched = findInventoryForOverride(index, { evidenceId: ov.evidenceId });
    const status = String(ov.status).toUpperCase();
    for (const item of matched) {
      if (status === "WRONG_SUBJECT") {
        setIdentityDecision(
          input.resolutionByRef,
          input.subjectResolution,
          item.inventoryId,
          "OTHER_SUBJECT",
          "analyst_override_wrong_subject"
        );
        applied.push({
          kind: "manual_review_wrong_subject",
          matchKey: ov.evidenceId,
          inventoryId: item.inventoryId,
          effect: "decision:=OTHER_SUBJECT",
        });
      } else if (status === "EXCLUDED") {
        markNeutral(item);
        applied.push({
          kind: "manual_review_excluded",
          matchKey: ov.evidenceId,
          inventoryId: item.inventoryId,
          effect: "exclude from adverse counts",
        });
      }
    }
  }

  // Classification-level «не субъект» is not a ResultClass; identity overrides
  // also accepted via manualReview WRONG_SUBJECT. Extra: if a fixture puts
  // classification OTHER_SUBJECT as string on a synthetic override — handled below.
  for (const ov of input.overrides.classification) {
    if (String(ov.classification).toUpperCase() !== "OTHER_SUBJECT") continue;
    const matched = findInventoryForOverride(index, {
      searchResultId: ov.searchResultId,
      url: ov.url,
    });
    for (const item of matched) {
      setIdentityDecision(
        input.resolutionByRef,
        input.subjectResolution,
        item.inventoryId,
        "OTHER_SUBJECT",
        "analyst_override_other_subject"
      );
      applied.push({
        kind: "identity_other_subject",
        matchKey: `searchResult:${ov.searchResultId}`,
        inventoryId: item.inventoryId,
        effect: "decision:=OTHER_SUBJECT",
      });
    }
  }

  return {
    applied,
    guaranteedFindings: input.overrides.approvedFindings,
  };
}

const THEME_BY_RISK: Record<string, string> = {
  criminal: "criminal_legal",
  legal_dispute: "criminal_legal",
  sanctions: "pep_rca_watchlist",
  pep: "pep_rca_watchlist",
  political_exposure: "political_exposure",
  adverse_media: "criminal_legal",
  reputation: "criminal_legal",
  business_conflict: "family_associates",
  offshore: "offshore_corporate",
  other: "criminal_legal",
};

function themeIdForApproved(ov: ApprovedFindingOverride): string {
  const key = String(ov.riskTheme ?? ov.category ?? "other")
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (THEME_BY_RISK[key]) return THEME_BY_RISK[key]!;
  const byLabel = FINDING_THEMES.find(
    (t) => t.themeId === key || t.label.toLowerCase().includes(key)
  );
  return byLabel?.themeId ?? "criminal_legal";
}

/**
 * Ensure REVIEWED RiskFindings appear as SUBJECT_MATCH findings in the bundle.
 */
export function mergeGuaranteedFindings(input: {
  caseId: string;
  datasetId: string;
  sourceHashes: string[];
  bundle: VerifiedFindingBundle;
  guaranteed: ApprovedFindingOverride[];
  items: RawInventoryItem[];
  applied: AppliedOverrideRecord[];
}): VerifiedFindingBundle {
  if (input.guaranteed.length === 0) return input.bundle;

  const index = buildInventoryOverrideIndex(input.items);
  const findings = [...input.bundle.findings];

  for (const ov of input.guaranteed) {
    const themeId = themeIdForApproved(ov);
    const theme = FINDING_THEMES.find((t) => t.themeId === themeId) ?? FINDING_THEMES[1]!;
    const matchedItems: RawInventoryItem[] = [];
    for (const ref of ov.evidenceRefs) {
      matchedItems.push(
        ...findInventoryForOverride(index, {
          searchResultId: normalizeSearchResultKey(ref) ?? ref,
        })
      );
    }
    const evidenceRefs =
      matchedItems.length > 0
        ? matchedItems.map((i) => `inventory:${i.inventoryId}`)
        : ov.evidenceRefs.map((r) =>
            r.startsWith("inventory:") ? r : `inventory:rf-${ov.findingId}`
          );

    const existing = findings.find(
      (f) =>
        f.subjectMatch === "SUBJECT_MATCH" &&
        (f.theme === theme.label || f.findingId.includes(themeId))
    );
    if (existing) {
      const merged = new Set([...existing.evidenceRefs, ...evidenceRefs]);
      existing.evidenceRefs = [...merged];
      input.applied.push({
        kind: "approved_finding",
        matchKey: ov.findingId,
        effect: `merged refs into ${existing.findingId}`,
      });
      continue;
    }

    const domains = [
      ...new Set(matchedItems.map((i) => domainOf(i.sourceUrl)).filter(Boolean)),
    ];
    const finding: Finding = FindingSchema.parse({
      schemaVersion: FINDING_SCHEMA_VERSION,
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      evidenceRefs,
      findingId: `finding-approved-${ov.findingId}-${createHash("sha1")
        .update(evidenceRefs.join("|"))
        .digest("hex")
        .slice(0, 8)}`,
      theme: theme.label,
      claim:
        ov.title ||
        `Подтверждённый аналитиком сигнал (${theme.label}). Источники: ${domains.slice(0, 4).join(", ") || "без URL"}.`,
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: theme.baseRisk === "none" ? "medium" : theme.baseRisk,
      confidence: 0.9,
      regions: [
        ...new Set(
          (matchedItems.length ? matchedItems : [{ region: "RU" } as RawInventoryItem]).map((i) =>
            mapRegionBucket(i.region)
          )
        ),
      ],
      sourceDomains: domains,
      providers: [
        ...new Set(matchedItems.map((i) => String(i.provider ?? "analyst").toLowerCase())),
      ],
      recommendedAction: theme.recommendedAction,
      contradictions: [],
      limitations: ["Сигнал подтверждён аналитиком (RiskFinding REVIEWED)."],
      promotionPriority: "P1",
      surfaceKinds: ["organic"],
    });
    findings.push(finding);
    input.applied.push({
      kind: "approved_finding",
      matchKey: ov.findingId,
      effect: `guaranteed finding ${finding.findingId}`,
    });
  }

  return {
    ...input.bundle,
    findings,
    evidenceRefs: findings
      .filter((f) => f.subjectMatch === "SUBJECT_MATCH")
      .flatMap((f) => f.evidenceRefs),
  };
}

/** Whether item was manually marked neutral / excluded from adverse. */
export function isAnalystNeutral(item: RawInventoryItem): boolean {
  return (item.rawMetadata as Record<string, unknown> | undefined)?.analystNeutral === true;
}

/** Whether item was manually marked adverse. */
export function isAnalystAdverse(item: RawInventoryItem): boolean {
  return (item.rawMetadata as Record<string, unknown> | undefined)?.analystAdverse === true;
}
