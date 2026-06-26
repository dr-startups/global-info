/**
 * Loads stored search_results for a case and shapes them for snapshot rendering
 * (Stage S1). PURE data access — no rendering, no external calls. Only YANDEX and
 * GOOGLE engines are surfaced (the two ORION-style SERP blocks); other engines
 * are ignored for this view.
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import type { LoadedResult, LoadedResults, SerpEngine, SerpSourceMode } from "./types";

/** A row is "real" when an agent tagged its source as real:<PROVIDER>. */
function isRealSource(source: string | null): boolean {
  return typeof source === "string" && source.toLowerCase().startsWith("real:");
}

/** Derives MOCK_ONLY / REAL_ONLY / MIXED from the loaded rows' source field. */
export function deriveSourceMode(rows: { source: string | null }[]): SerpSourceMode {
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

/**
 * Loads up to `maxPerEngine` results per engine (YANDEX + GOOGLE), ordered by
 * rank then recency. Also resolves the subject full name for the header/query.
 * Throws NotFound if the case is missing or soft-deleted.
 */
export async function loadCaseResults(
  caseId: string,
  maxPerEngine: number
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

  async function loadEngine(engine: SerpEngine): Promise<LoadedResult[]> {
    const rows = await prisma.searchResult.findMany({
      where: { caseId, engine },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      take: maxPerEngine,
      select: {
        id: true,
        engine: true,
        rank: true,
        title: true,
        url: true,
        snippet: true,
        classification: true,
        source: true,
        rawMetadata: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      engine,
      rank: r.rank,
      title: r.title,
      url: r.url,
      domain: domainOf(r.url),
      snippet: r.snippet,
      classification: String(r.classification),
      riskTheme: riskThemeOf(r.rawMetadata),
      region: null,
      language: null,
      source: r.source,
      createdAt: r.createdAt,
    }));
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
    hasRealResults: sourceMode !== "MOCK_ONLY",
  };
}
