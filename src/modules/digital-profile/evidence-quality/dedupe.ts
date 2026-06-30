/**
 * Stage O5 — dedupe and clustering across evidence items.
 */

import type { EvidenceItemInput, GatedEvidenceItem } from "./types";
import { evaluateEvidenceItem } from "./gate";

function normalizeUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/$/, "");
  }
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeKey(item: EvidenceItemInput): string {
  const url = normalizeUrl(item.url);
  if (url) return `url:${url}`;
  const title = normalizeText(item.title ?? item.query);
  const domain = normalizeText(item.domain);
  if (title && domain) return `domain-title:${domain}|${title}`;
  if (title) return `title:${title}`;
  return `id:${item.id ?? Math.random()}`;
}

export interface DedupeResult<T extends EvidenceItemInput> {
  items: Array<T & { quality: ReturnType<typeof evaluateEvidenceItem>; duplicateCount: number }>;
  duplicatesCollapsed: number;
}

/** Collapses duplicate URLs / titles; marks duplicates as EXCLUDE via gate. */
export function dedupeEvidenceItems<T extends EvidenceItemInput>(
  items: T[],
  subjectFullName?: string | null
): DedupeResult<T> {
  const seen = new Map<string, number>();
  const out: DedupeResult<T>["items"] = [];
  let duplicatesCollapsed = 0;

  for (const item of items) {
    const key = dedupeKey(item);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    const isDuplicate = count > 0;
    if (isDuplicate) duplicatesCollapsed += 1;

    const quality = evaluateEvidenceItem(
      { ...item, subjectFullName: item.subjectFullName ?? subjectFullName ?? null },
      { isDuplicate }
    );
    out.push({ ...item, quality, duplicateCount: count });
  }

  return { items: out, duplicatesCollapsed };
}

export function pickBestRepresentatives(
  items: GatedEvidenceItem[],
  limit: number
): GatedEvidenceItem[] {
  const ranked = [...items].sort((a, b) => {
    const score = (x: GatedEvidenceItem) => {
      let s = 0;
      if (x.quality.reportEligibility === "CLIENT_INCLUDE") s += 100;
      if (x.quality.isAdverseForReport) s += 50;
      if (x.quality.isUsefulProfileMaterial) s += 30;
      if (x.quality.identityConfidence === "HIGH") s += 20;
      if (x.quality.identityConfidence === "MEDIUM") s += 10;
      if (x.quality.reportEligibility === "REVIEW_REQUIRED") s += 5;
      return s;
    };
    return score(b) - score(a);
  });
  return ranked.slice(0, limit);
}
