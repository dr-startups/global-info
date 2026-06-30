/**
 * Loads stored search_results for a case and shapes them for snapshot rendering
 * (Stage S1). PURE data access — no rendering, no external calls. Only YANDEX and
 * GOOGLE engines are surfaced (the two ORION-style SERP blocks); other engines
 * are ignored for this view.
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { readRiskClassification } from "../risk-classifier/result-classifier";
import { resolveHighlight, type LinkedFinding } from "./highlight-resolver";
import {
  DEFAULT_SOURCE_PREFERENCE,
  type EngineSourceMode,
  type LoadedResult,
  type LoadedResults,
  type SerpEngine,
  type SerpSourceMode,
  type SourcePreference,
} from "./types";

/** A row is "real" when an agent tagged its source as real:<PROVIDER>. */
export function isRealSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source.toLowerCase().startsWith("real:");
}

/**
 * Stage N1.2 — applies the source preference to one engine's rows (already
 * ordered by rank/recency). PURE + deterministic so the smoke test can exercise
 * it without a database:
 *  - prefer_real: real rows when any exist, otherwise the mock rows (fallback).
 *  - real_only:   only real rows (empty when none).
 *  - mock_only:   only mock/demo rows.
 *  - mixed:       every row, original order preserved.
 */
export function selectByPreference<T extends { source: string | null }>(
  rows: T[],
  preference: SourcePreference
): T[] {
  const real = rows.filter((r) => isRealSource(r.source));
  const mock = rows.filter((r) => !isRealSource(r.source));
  switch (preference) {
    case "real_only":
      return real;
    case "mock_only":
      return mock;
    case "mixed":
      return rows;
    case "prefer_real":
    default:
      return real.length > 0 ? real : mock;
  }
}

/** Per-engine source mode for an already-selected set of rows (Stage N1.2). */
export function engineSourceModeOf(rows: { source: string | null }[]): EngineSourceMode {
  if (rows.length === 0) return "EMPTY";
  // If a real row survived the selection, the engine is treated as REAL (the
  // overall MIXED mode captures any cross-engine real+mock combination).
  return rows.some((r) => isRealSource(r.source)) ? "REAL" : "MOCK";
}

/** Derives MOCK_ONLY / REAL_ONLY / MIXED / EMPTY from selected rows (Stage N1/N1.2). */
export function deriveSourceMode(rows: { source: string | null }[]): SerpSourceMode {
  if (rows.length === 0) return "EMPTY";
  let real = false;
  let nonReal = false;
  for (const r of rows) {
    if (isRealSource(r.source)) real = true;
    else nonReal = true;
  }
  if (real && nonReal) return "MIXED";
  if (real) return "REAL_ONLY";
  return "MOCK_ONLY";
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Extract a free-form risk theme from rawMetadata without trusting its shape. */
function riskThemeOf(rawMetadata: unknown): string | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const obj = rawMetadata as Record<string, unknown>;
  for (const key of ["riskTheme", "theme", "topic", "category"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Pulls SEARCH_RESULT evidence ids out of a finding's evidenceRefs JSON. */
export function searchResultIdsFromEvidence(evidenceRefs: unknown): string[] {
  return resultIdsOf(evidenceRefs);
}

function byRankThenAge(a: LoadedResult, b: LoadedResult): number {
  const ra = a.rank ?? 9999;
  const rb = b.rank ?? 9999;
  if (ra !== rb) return ra - rb;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Stage R1.1.2 — applies source preference, then keeps highlighted rows in the
 * visible cap even when their rank is outside the normal top-N window.
 */
export function selectEngineRowsForSnapshot(
  mapped: LoadedResult[],
  sourcePreference: SourcePreference,
  maxPerEngine: number
): LoadedResult[] {
  const selected = selectByPreference(mapped, sourcePreference);
  const highlighted = selected.filter((r) => r.isHighlighted).sort(byRankThenAge);
  const normal = selected.filter((r) => !r.isHighlighted).sort(byRankThenAge);

  const out: LoadedResult[] = [];
  const seen = new Set<string>();

  for (const row of highlighted) {
    if (out.length >= maxPerEngine) break;
    out.push(row);
    seen.add(row.id);
  }
  for (const row of normal) {
    if (out.length >= maxPerEngine) break;
    if (seen.has(row.id)) continue;
    out.push(row);
    seen.add(row.id);
  }
  return out;
}

/** Active findings with no SEARCH_RESULT evidence link (phantom-theme guard). */
export async function countUnlinkedActiveRiskFindings(caseId: string): Promise<number> {
  const findings = await prisma.riskFinding.findMany({
    where: { caseId, reviewStatus: { not: "DISMISSED" } },
    select: { evidenceRefs: true },
  });
  let n = 0;
  for (const f of findings) {
    if (searchResultIdsFromEvidence(f.evidenceRefs).length === 0) n += 1;
  }
  return n;
}
function resultIdsOf(evidenceRefs: unknown): string[] {
  if (!Array.isArray(evidenceRefs)) return [];
  const ids: string[] = [];
  for (const ref of evidenceRefs) {
    if (ref && typeof ref === "object") {
      const r = ref as Record<string, unknown>;
      if (typeof r.id === "string" && (r.type === undefined || r.type === "SEARCH_RESULT")) {
        ids.push(r.id);
      }
    }
  }
  return ids;
}

/** Builds resultId -> linked findings map for a case (Stage N1.3 highlights). */
async function loadFindingsByResult(caseId: string): Promise<Map<string, LinkedFinding[]>> {
  const findings = await prisma.riskFinding.findMany({
    where: { caseId },
    select: { reviewStatus: true, riskTheme: true, severity: true, evidenceRefs: true },
  });
  const map = new Map<string, LinkedFinding[]>();
  for (const f of findings) {
    for (const id of resultIdsOf(f.evidenceRefs)) {
      const list = map.get(id) ?? [];
      list.push({ reviewStatus: f.reviewStatus, riskTheme: f.riskTheme, severity: f.severity });
      map.set(id, list);
    }
  }
  return map;
}

/**
 * Upper bound on rows fetched per engine BEFORE the source preference is applied.
 * We over-fetch so that, e.g., real rows are not lost behind higher-ranked mock
 * rows when prefer_real/real_only is requested; the final list is sliced to
 * `maxPerEngine` afterwards.
 */
const FETCH_CAP_PER_ENGINE = 200;

/**
 * Loads results per engine (YANDEX + GOOGLE), ordered by rank then recency, then
 * applies the Stage N1.2 source preference and keeps up to `maxPerEngine` rows.
 * Also resolves the subject full name for the header/query.
 * Throws NotFound if the case is missing or soft-deleted.
 */
export async function loadCaseResults(
  caseId: string,
  maxPerEngine: number,
  sourcePreference: SourcePreference = DEFAULT_SOURCE_PREFERENCE
): Promise<LoadedResults> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fullName: true },
      },
    },
  });
  if (!found) throw new NotFoundError("Case not found");

  const subjectName = found.subjects[0]?.fullName ?? "";
  const findingsByResult = await loadFindingsByResult(caseId);

  async function loadEngine(engine: SerpEngine): Promise<LoadedResult[]> {
    const rows = await prisma.searchResult.findMany({
      where: { caseId, engine },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      take: FETCH_CAP_PER_ENGINE,
      select: {
        id: true,
        engine: true,
        rank: true,
        title: true,
        url: true,
        snippet: true,
        classification: true,
        reviewStatus: true,
        source: true,
        rawMetadata: true,
        createdAt: true,
      },
    });
    const mapped: LoadedResult[] = rows.map((r) => {
      // Stage N1.3 — resolve red-frame highlight (manual > findings > auto > enum).
      const riskClassification = readRiskClassification(r.rawMetadata);
      const decision = resolveHighlight({
        enumClassification: String(r.classification),
        riskClassification,
        findings: findingsByResult.get(r.id) ?? [],
        sourceIsMock: !(r.source ?? "").toLowerCase().startsWith("real:"),
      });
      return {
        id: r.id,
        engine,
        rank: r.rank,
        title: r.title,
        url: r.url,
        domain: domainOf(r.url),
        snippet: r.snippet,
        classification: String(r.classification),
        riskTheme: decision.isHighlighted
          ? (decision.riskTheme as string | null) ?? riskThemeOf(r.rawMetadata)
          : null,
        region: null,
        language: null,
        source: r.source,
        createdAt: r.createdAt,
        isHighlighted: decision.isHighlighted,
        themeTitle: null,
      };
    });
    // Stage N1.2 — pick real/mock per the preference, then cap with highlighted-first ordering (R1.1.2).
    return selectEngineRowsForSnapshot(mapped, sourcePreference, maxPerEngine);
  }

  const [yandex, google] = await Promise.all([loadEngine("YANDEX"), loadEngine("GOOGLE")]);

  const combined = [...yandex, ...google];
  const sourceMode = deriveSourceMode(combined);

  return {
    subjectName,
    yandex,
    google,
    total: combined.length,
    sourceMode,
    hasRealResults: combined.some((r) => isRealSource(r.source)),
    sourcePreference,
    perEngine: {
      yandex: engineSourceModeOf(yandex),
      google: engineSourceModeOf(google),
    },
  };
}
