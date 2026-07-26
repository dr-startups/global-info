import type {
  EvidenceItemInput,
  GatedEvidenceItem,
  SourceFingerprint,
  SourceSurfaceType,
} from "./types";

function normText(v: string | null | undefined): string {
  return String(v ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(v: string): string[] {
  return v
    .split(/[^a-z0-9а-яё]+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function jaccard(a: string, b: string): number {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (aa.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const t of aa) if (bb.has(t)) inter += 1;
  const union = aa.size + bb.size - inter;
  return union > 0 ? inter / union : 0;
}

export function canonicalUrlKey(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

export function canonicalDomain(urlOrDomain: string | null | undefined): string | null {
  const raw = String(urlOrDomain ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./i, "").toLowerCase();
  }
}

export function canonicalTitleKey(title: string | null | undefined): string | null {
  const t = normText(title);
  return t || null;
}

export function providerKeyOf(item: EvidenceItemInput): string {
  const src = normText(item.source);
  const domain = normText(item.domain ?? item.url ?? "");
  if (src.includes("yandex") || domain.includes("yandex")) return "yandex";
  if (src.includes("google") || domain.includes("google")) return "google";
  if (src.includes("serper") || domain.includes("serper") || domain.includes("serpapi")) return "serper";
  if (src.includes("wiki") || domain.includes("wikipedia.org")) return "wikipedia";
  if (src.includes("manual")) return "manual";
  if (src.includes("compliance") || src.includes("database")) return "compliance";
  if (src.includes("screenshot")) return "screenshot";
  return src || "unknown";
}

export function surfaceTypeOf(item: EvidenceItemInput): SourceSurfaceType {
  switch (item.surfaceType) {
    case "SEARCH_RESULT":
      return "organic";
    case "SEARCH_SUGGESTION":
      return "suggestion";
    case "RELATED_QUERY":
      return "related";
    case "IMAGE_RESULT":
      return "image";
    case "VIDEO_RESULT":
      return "video";
    case "WIKIPEDIA_RESULT":
      return "wikipedia";
    case "MANUAL_COMPLIANCE":
      return "compliance";
    case "MANUAL_IMPORT":
      return "manual";
    default:
      return "unknown";
  }
}

export function buildSourceFingerprint(item: EvidenceItemInput): SourceFingerprint {
  const urlKey = canonicalUrlKey(item.url);
  const dom = canonicalDomain(item.domain ?? item.url);
  const titleKey = canonicalTitleKey(item.title ?? item.query);
  const providerKey = providerKeyOf(item);
  const surfaceType = surfaceTypeOf(item);
  const region = item.region ?? null;
  const language = region?.toUpperCase() === "RU" ? "ru" : "en";
  const base = [providerKey, surfaceType, dom ?? "no-domain", titleKey ?? "no-title", urlKey ?? "no-url"].join("|");
  return {
    sourceFingerprint: base,
    canonicalUrlKey: urlKey,
    canonicalDomain: dom,
    canonicalTitleKey: titleKey,
    providerKey,
    surfaceType,
    language,
    region,
  };
}

function canCrossMerge(a: GatedEvidenceItem, b: GatedEvidenceItem): boolean {
  // Conservative: if identity is weak/conflicting on either side, avoid fuzzy merges.
  const bad = new Set(["NAMESAKE", "ENTITY_MISMATCH", "INSUFFICIENT_MATCH", "POSSIBLE_SUBJECT"]);
  if (bad.has(String(a.quality.identityDecision ?? ""))) return false;
  if (bad.has(String(b.quality.identityDecision ?? ""))) return false;
  return true;
}

export interface DuplicateAnnotation {
  duplicateGroupId: string;
  duplicateRank: number;
  duplicateReason: string;
}

/**
 * Conservative duplicate grouping:
 * 1) exact canonical URL;
 * 2) same domain + highly similar normalized title;
 * 3) same title + same surface + same provider;
 * 4) media same title + same domain.
 */
export function detectDuplicateGroups(
  items: GatedEvidenceItem[]
): Map<number, DuplicateAnnotation> {
  const result = new Map<number, DuplicateAnnotation>();
  const fps = items.map((i) => buildSourceFingerprint(i));
  let gid = 0;

  function mark(group: number[], reason: string) {
    if (group.length <= 1) return;
    gid += 1;
    group.forEach((idx, rank) => {
      result.set(idx, {
        duplicateGroupId: `dg-${gid}`,
        duplicateRank: rank + 1,
        duplicateReason: reason,
      });
    });
  }

  const byUrl = new Map<string, number[]>();
  fps.forEach((f, i) => {
    if (!f.canonicalUrlKey) return;
    const arr = byUrl.get(f.canonicalUrlKey) ?? [];
    arr.push(i);
    byUrl.set(f.canonicalUrlKey, arr);
  });
  for (const group of byUrl.values()) mark(group, "exact_canonical_url");

  for (let i = 0; i < items.length; i += 1) {
    if (result.has(i)) continue;
    const a = fps[i];
    for (let j = i + 1; j < items.length; j += 1) {
      if (result.has(j)) continue;
      const b = fps[j];
      if (!canCrossMerge(items[i], items[j])) continue;
      const sameDomain = a.canonicalDomain && b.canonicalDomain && a.canonicalDomain === b.canonicalDomain;
      const sameTitle = a.canonicalTitleKey && b.canonicalTitleKey && a.canonicalTitleKey === b.canonicalTitleKey;
      const sameSurface = a.surfaceType === b.surfaceType;
      const sameProvider = a.providerKey === b.providerKey;
      const mediaSurface = a.surfaceType === "image" || a.surfaceType === "video";
      const highTitleSimilarity =
        a.canonicalTitleKey && b.canonicalTitleKey
          ? jaccard(a.canonicalTitleKey, b.canonicalTitleKey) >= 0.86
          : false;

      if (sameDomain && highTitleSimilarity) {
        mark([i, j], "same_domain_similar_title");
      } else if (sameTitle && sameSurface && sameProvider) {
        mark([i, j], "same_title_surface_provider");
      } else if (mediaSurface && sameDomain && sameTitle) {
        mark([i, j], "same_media_title_domain");
      }
    }
  }
  return result;
}
