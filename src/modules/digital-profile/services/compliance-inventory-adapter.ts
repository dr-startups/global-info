/**
 * REMEDIATION_PLAN §1.2 / F6 — DatabaseProfile → canonical RawInventoryItem.
 *
 * Active compliance hits enter the analytics inventory as `compliance_hit`
 * so surface analyzers and p33–p36 fragments can render real LexisNexis /
 * Dow Jones / World-Check rows. Soft-delete lives on Case; dismissed /
 * false-positive hits are filtered here.
 */

import type { RawInventoryItem } from "../orion-golden/types";

/** Subset of DatabaseProfile columns needed for inventory adaptation. */
export type DatabaseProfileHitInput = {
  id: string;
  provider: string;
  importMethod?: string | null;
  hitSource?: string | null;
  matchedName?: string | null;
  subjectName?: string | null;
  matchType?: string | null;
  matchScore?: number | null;
  reviewStatus?: string | null;
  riskTypes?: unknown;
  summary?: string | null;
  profileUrl?: string | null;
  evidenceRefs?: unknown;
  rawMetadataSafe?: unknown;
  importedAt?: Date | string | null;
};

export type ComplianceInventoryPrisma = {
  databaseProfile: {
    findMany: (args: {
      where: { caseId: string };
      orderBy?: Array<Record<string, "asc" | "desc">>;
    }) => Promise<DatabaseProfileHitInput[]>;
  };
};

/** Review statuses that must not appear as active report hits. */
const EXCLUDED_REVIEW = new Set(["DISMISSED", "FALSE_POSITIVE"]);

function asObj(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function riskTypesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x)).filter(Boolean);
}

function matchCategoryOf(row: DatabaseProfileHitInput): string | undefined {
  const fromType = String(row.matchType ?? "").trim();
  if (fromType) return fromType.toUpperCase();
  const firstRisk = riskTypesOf(row.riskTypes)[0];
  return firstRisk ? firstRisk.toUpperCase() : undefined;
}

function collectedAtOf(row: DatabaseProfileHitInput): string {
  if (!row.importedAt) return new Date(0).toISOString();
  if (row.importedAt instanceof Date) return row.importedAt.toISOString();
  const d = new Date(row.importedAt);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function isActiveComplianceHit(row: DatabaseProfileHitInput): boolean {
  const status = String(row.reviewStatus ?? "PENDING").toUpperCase();
  return !EXCLUDED_REVIEW.has(status);
}

/**
 * Map a DatabaseProfile row (or fixture DTO) to a RawInventoryItem for the
 * canonical analytics pipeline. Identity is decided from reviewStatus later
 * (skipTextClassifier marker) — not by the surname/token classifier.
 */
export function adaptDatabaseProfileToInventoryItem(input: {
  row: DatabaseProfileHitInput;
  caseId: string;
  reportRunId: string;
}): RawInventoryItem | null {
  const { row, caseId, reportRunId } = input;
  if (!row.id || !isActiveComplianceHit(row)) return null;

  const provider = String(row.provider ?? "OTHER").toUpperCase();
  const matchCategory = matchCategoryOf(row);
  const reviewStatus = String(row.reviewStatus ?? "PENDING").toUpperCase();
  const riskTypes = riskTypesOf(row.riskTypes);
  const safeMeta = asObj(row.rawMetadataSafe);
  const profileUrl = String(row.profileUrl ?? "").trim();
  const title =
    String(row.matchedName ?? "").trim() ||
    String(row.subjectName ?? "").trim() ||
    String(row.summary ?? "").trim() ||
    provider;

  return {
    inventoryId: `db-${row.id}`,
    caseId,
    reportRunId,
    source: "database_profile",
    provider,
    region: "GLOBAL",
    collectedAt: collectedAtOf(row),
    evidenceType: "compliance_hit",
    title,
    snippet: String(row.summary ?? ""),
    sourceUrl: profileUrl || undefined,
    classification: reviewStatus,
    rawMetadata: {
      ...safeMeta,
      surface: "compliance_hit",
      provider,
      matchType: matchCategory,
      matchCategory,
      matchScore: row.matchScore ?? undefined,
      reviewStatus,
      riskTypes,
      importMethod: row.importMethod ?? undefined,
      hitSource: row.hitSource ?? undefined,
      matchedName: row.matchedName ?? undefined,
      profileUrl: profileUrl || undefined,
      evidenceRefs: [`databaseProfile:${row.id}`],
      /** Identity branch: do not run surname/token F1 classifier. */
      skipTextClassifier: true,
      identityFromReview: true,
    },
  };
}

export function adaptDatabaseProfilesToInventory(input: {
  rows: DatabaseProfileHitInput[];
  caseId: string;
  reportRunId: string;
}): RawInventoryItem[] {
  const out: RawInventoryItem[] = [];
  for (const row of input.rows) {
    const item = adaptDatabaseProfileToInventoryItem({
      row,
      caseId: input.caseId,
      reportRunId: input.reportRunId,
    });
    if (item) out.push(item);
  }
  return out;
}

/** Load active DatabaseProfile rows for a case (live path). */
export async function loadComplianceHitsFromPrisma(input: {
  prisma: ComplianceInventoryPrisma;
  caseId: string;
}): Promise<DatabaseProfileHitInput[]> {
  const rows = await input.prisma.databaseProfile.findMany({
    where: { caseId: input.caseId },
    orderBy: [{ importedAt: "desc" }],
  });
  return rows.filter(isActiveComplianceHit);
}

/**
 * Resolve compliance inventory items: explicit fixture/deps wins; otherwise
 * load from prisma when available.
 */
export async function resolveComplianceInventoryItems(input: {
  caseId: string;
  reportRunId: string;
  complianceHits?: DatabaseProfileHitInput[] | null;
  prisma?: ComplianceInventoryPrisma | null;
}): Promise<RawInventoryItem[]> {
  let rows: DatabaseProfileHitInput[] = [];
  if (input.complianceHits != null) {
    rows = input.complianceHits;
  } else if (input.prisma?.databaseProfile) {
    rows = await loadComplianceHitsFromPrisma({
      prisma: input.prisma,
      caseId: input.caseId,
    });
  }
  return adaptDatabaseProfilesToInventory({
    rows,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
  });
}
