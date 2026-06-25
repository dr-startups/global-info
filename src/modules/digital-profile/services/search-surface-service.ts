/**
 * Search surface service (Stage H3).
 *
 * Manages dp_search_surface_items: manual creation, bulk import (agents), soft
 * delete, human review, and idempotent de-duplication. Shared by manual UI input
 * and by the mock/real surface agents — exactly like search_results in H2.
 *
 * Dedup: a per-case hash of type|source|(normalizedUrl || query || title).
 * Re-running an agent or re-adding the same item resolves to the existing row.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { ConflictError, NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { normalizeUrl } from "./evidence-service";
import type { ActorContext } from "./case-service";
import type {
  SearchSurfaceFilters,
  SearchSurfaceInput,
  SearchSurfaceItem,
} from "../search-surfaces/types";

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Stable dedup key for a surface item within a case. */
export function surfaceDedupHash(item: {
  type: string;
  source: string;
  url?: string | null;
  query?: string | null;
  title?: string | null;
}): string {
  const key =
    item.url && item.url.trim()
      ? normalizeUrl(item.url)
      : (item.query ?? item.title ?? "").trim().toLowerCase();
  return createHash("sha256").update(`${item.type}|${item.source}|${key}`).digest("hex");
}

const surfaceSelect = {
  id: true,
  caseId: true,
  type: true,
  provider: true,
  source: true,
  query: true,
  region: true,
  language: true,
  title: true,
  snippet: true,
  url: true,
  domain: true,
  imageUrl: true,
  thumbnailUrl: true,
  videoUrl: true,
  rank: true,
  classification: true,
  riskTheme: true,
  rawMetadata: true,
  capturedAt: true,
  demo: true,
  reviewStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SearchSurfaceItemSelect;

type SurfaceRow = Prisma.SearchSurfaceItemGetPayload<{ select: typeof surfaceSelect }>;

function toDTO(row: SurfaceRow): SearchSurfaceItem {
  return row as SearchSurfaceItem;
}

async function ensureActiveCase(caseId: string): Promise<void> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");
}

function domainOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function listSearchSurfaceItems(
  caseId: string,
  filters: SearchSurfaceFilters = {}
): Promise<SearchSurfaceItem[]> {
  await ensureActiveCase(caseId);
  const rows = await prisma.searchSurfaceItem.findMany({
    where: {
      caseId,
      deletedAt: null,
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.provider ? { provider: filters.provider } : {}),
    },
    orderBy: [{ type: "asc" }, { rank: "asc" }, { createdAt: "desc" }],
    select: surfaceSelect,
  });
  return rows.map(toDTO);
}

/**
 * Creates one surface item. Idempotent: if the dedup hash already exists for the
 * case it returns the existing row with `deduplicated: true` instead of failing.
 */
export async function createSearchSurfaceItem(
  caseId: string,
  input: SearchSurfaceInput,
  ctx: ActorContext = {}
): Promise<{ item: SearchSurfaceItem; deduplicated: boolean }> {
  await ensureActiveCase(caseId);
  const dedupHash = surfaceDedupHash(input);

  const existing = await prisma.searchSurfaceItem.findFirst({
    where: { caseId, dedupHash, deletedAt: null },
    select: surfaceSelect,
  });
  if (existing) return { item: toDTO(existing), deduplicated: true };

  try {
    const row = await prisma.searchSurfaceItem.create({
      data: {
        caseId,
        type: input.type,
        source: input.source,
        provider: input.provider ?? null,
        query: input.query ?? null,
        region: input.region ?? null,
        language: input.language ?? null,
        title: input.title ?? null,
        snippet: input.snippet ?? null,
        url: input.url ?? null,
        domain: input.domain ?? domainOf(input.url),
        imageUrl: input.imageUrl ?? null,
        thumbnailUrl: input.thumbnailUrl ?? null,
        videoUrl: input.videoUrl ?? null,
        rank: input.rank ?? null,
        classification: input.classification ?? null,
        riskTheme: input.riskTheme ?? null,
        rawMetadata: toJson(input.rawMetadata),
        demo: input.demo ?? false,
        dedupHash,
      },
      select: surfaceSelect,
    });
    await recordAudit({
      caseId,
      action: "SEARCH_SURFACE_ADDED",
      actorId: ctx.actorId,
      metadata: { surfaceId: row.id, type: row.type, source: row.source },
    });
    return { item: toDTO(row), deduplicated: false };
  } catch (err) {
    // Concurrent insert hit the unique constraint — return the existing row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await prisma.searchSurfaceItem.findFirst({
        where: { caseId, dedupHash },
        select: surfaceSelect,
      });
      if (row) return { item: toDTO(row), deduplicated: true };
      throw new ConflictError("Duplicate search surface item");
    }
    throw err;
  }
}

/**
 * Bulk create (used by agents). Idempotent via createMany + skipDuplicates on the
 * [caseId, dedupHash] unique constraint. Returns the number actually inserted.
 */
export async function createManySearchSurfaceItems(
  caseId: string,
  items: SearchSurfaceInput[],
  ctx: ActorContext = {}
): Promise<{ created: number; requested: number }> {
  await ensureActiveCase(caseId);
  if (items.length === 0) return { created: 0, requested: 0 };

  // De-duplicate within the batch first (same hash twice would otherwise rely on
  // skipDuplicates and report inconsistent counts).
  const byHash = new Map<string, SearchSurfaceInput & { dedupHash: string }>();
  for (const it of items) {
    const dedupHash = surfaceDedupHash(it);
    if (!byHash.has(dedupHash)) byHash.set(dedupHash, { ...it, dedupHash });
  }

  const data = [...byHash.values()].map((it) => ({
    caseId,
    type: it.type,
    source: it.source,
    provider: it.provider ?? null,
    query: it.query ?? null,
    region: it.region ?? null,
    language: it.language ?? null,
    title: it.title ?? null,
    snippet: it.snippet ?? null,
    url: it.url ?? null,
    domain: it.domain ?? domainOf(it.url),
    imageUrl: it.imageUrl ?? null,
    thumbnailUrl: it.thumbnailUrl ?? null,
    videoUrl: it.videoUrl ?? null,
    rank: it.rank ?? null,
    classification: it.classification ?? null,
    riskTheme: it.riskTheme ?? null,
    rawMetadata: toJson(it.rawMetadata),
    demo: it.demo ?? false,
    dedupHash: it.dedupHash,
  }));

  const result = await prisma.searchSurfaceItem.createMany({ data, skipDuplicates: true });
  await recordAudit({
    caseId,
    action: "SEARCH_SURFACE_BULK_ADDED",
    actorId: ctx.actorId,
    metadata: { requested: items.length, created: result.count },
  });
  return { created: result.count, requested: items.length };
}

export async function markSearchSurfaceItemReviewed(
  surfaceId: string,
  reviewStatus: "PENDING" | "REVIEWED" | "DISMISSED",
  ctx: ActorContext = {}
): Promise<SearchSurfaceItem> {
  const existing = await prisma.searchSurfaceItem.findFirst({
    where: { id: surfaceId, deletedAt: null },
    select: { id: true, caseId: true },
  });
  if (!existing) throw new NotFoundError("Search surface item not found");

  const row = await prisma.searchSurfaceItem.update({
    where: { id: surfaceId },
    data: { reviewStatus },
    select: surfaceSelect,
  });
  await recordAudit({
    caseId: existing.caseId,
    action: "SEARCH_SURFACE_REVIEWED",
    actorId: ctx.actorId,
    metadata: { surfaceId, reviewStatus },
  });
  return toDTO(row);
}

export async function deleteSearchSurfaceItemSoft(
  surfaceId: string,
  ctx: ActorContext = {}
): Promise<{ id: string }> {
  const existing = await prisma.searchSurfaceItem.findFirst({
    where: { id: surfaceId, deletedAt: null },
    select: { id: true, caseId: true },
  });
  if (!existing) throw new NotFoundError("Search surface item not found");

  await prisma.searchSurfaceItem.update({
    where: { id: surfaceId },
    data: { deletedAt: new Date(), deletedBy: ctx.actorId ?? "system" },
  });
  await recordAudit({
    caseId: existing.caseId,
    action: "SEARCH_SURFACE_SOFT_DELETED",
    actorId: ctx.actorId,
    metadata: { surfaceId },
  });
  return { id: surfaceId };
}
