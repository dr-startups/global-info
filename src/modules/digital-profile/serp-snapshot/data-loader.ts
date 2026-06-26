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
    select: { reviewStatus: true, riskTheme: true, evidenceRefs: true },
  });
  const map = new Map<string, LinkedFinding[]>();
  for (const f of findings) {
    for (const id of resultIdsOf(f.evidenceRefs)) {
      const list = map.get(id) ?? [];
      list.push({ reviewStatus: f.reviewStatus, riskTheme: f.riskTheme });
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
    // Stage N1.2 — pick real/mock per the preference, then cap.
    return selectByPreference(mapped, sourcePreference).slice(0, maxPerEngine);
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
