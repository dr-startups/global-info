/**
 * R10.2 — Classify search surfaces into media availability categories.
 */

export type SearchSurfaceMediaCategory =
  | "IMAGE_RESULT"
  | "VIDEO_RESULT"
  | "KNOWLEDGE_BLOCK"
  | "SERP_SCREENSHOT"
  | "SUGGESTION"
  | "RELATED_QUERY"
  | "ORGANIC_RESULT"
  | "MANUAL_NOTE"
  | "AI_ANSWER"
  | "OTHER";

export type SearchSurfaceRow = {
  type?: string | null;
  title?: string | null;
  snippet?: string | null;
  query?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  rawMetadata?: unknown;
};

function asObj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

const DIRECT_TYPES = new Set<SearchSurfaceMediaCategory>([
  "IMAGE_RESULT",
  "VIDEO_RESULT",
  "KNOWLEDGE_BLOCK",
  "SERP_SCREENSHOT",
  "SUGGESTION",
  "RELATED_QUERY",
  "ORGANIC_RESULT",
  "MANUAL_NOTE",
  "AI_ANSWER",
]);

export function resolveSearchSurfaceMediaCategory(row: SearchSurfaceRow): SearchSurfaceMediaCategory {
  const rawType = String(row.type ?? "").toUpperCase();
  if (DIRECT_TYPES.has(rawType as SearchSurfaceMediaCategory)) {
    return rawType as SearchSurfaceMediaCategory;
  }

  const meta = asObj(row.rawMetadata);
  const metaType = String(meta.surfaceType ?? meta.mediaType ?? meta.kind ?? meta.type ?? "").toUpperCase();
  if (DIRECT_TYPES.has(metaType as SearchSurfaceMediaCategory)) {
    return metaType as SearchSurfaceMediaCategory;
  }

  if (row.videoUrl) return "VIDEO_RESULT";
  if (row.imageUrl || row.thumbnailUrl) return "IMAGE_RESULT";

  const blob = `${row.title ?? ""} ${row.snippet ?? ""} ${row.query ?? ""} ${metaType}`.toLowerCase();
  if (/knowledge|знани|panel|панель/.test(blob)) return "KNOWLEDGE_BLOCK";
  if (/suggest|подсказ|autocomplete|автодополн/.test(blob)) return "SUGGESTION";
  if (/related|похож|also searched|связанн/.test(blob)) return "RELATED_QUERY";
  if (/serp|screenshot|снимок|выдач|snapshot|organic/.test(blob)) return "SERP_SCREENSHOT";

  return "OTHER";
}

export function countSearchSurfaceMediaAvailability(surfaces: SearchSurfaceRow[]): {
  images: number;
  videos: number;
  knowledgePanels: number;
  serpScreenshots: number;
  suggestions: number;
  relatedQueries: number;
  organicResults: number;
  manualNotes: number;
  aiAnswers: number;
} {
  const counts = {
    images: 0,
    videos: 0,
    knowledgePanels: 0,
    serpScreenshots: 0,
    suggestions: 0,
    relatedQueries: 0,
    organicResults: 0,
    manualNotes: 0,
    aiAnswers: 0,
  };

  for (const row of surfaces) {
    switch (resolveSearchSurfaceMediaCategory(row)) {
      case "IMAGE_RESULT":
        counts.images += 1;
        break;
      case "VIDEO_RESULT":
        counts.videos += 1;
        break;
      case "KNOWLEDGE_BLOCK":
        counts.knowledgePanels += 1;
        break;
      case "SERP_SCREENSHOT":
        counts.serpScreenshots += 1;
        break;
      case "SUGGESTION":
        counts.suggestions += 1;
        break;
      case "RELATED_QUERY":
        counts.relatedQueries += 1;
        break;
      case "ORGANIC_RESULT":
        counts.organicResults += 1;
        break;
      case "MANUAL_NOTE":
        counts.manualNotes += 1;
        break;
      case "AI_ANSWER":
        counts.aiAnswers += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

export function isImageSurface(row: SearchSurfaceRow): boolean {
  return resolveSearchSurfaceMediaCategory(row) === "IMAGE_RESULT";
}

export function isVideoSurface(row: SearchSurfaceRow): boolean {
  return resolveSearchSurfaceMediaCategory(row) === "VIDEO_RESULT";
}

export function isKnowledgeSurface(row: SearchSurfaceRow): boolean {
  return resolveSearchSurfaceMediaCategory(row) === "KNOWLEDGE_BLOCK";
}

export function isSerpScreenshotSurface(row: SearchSurfaceRow): boolean {
  return resolveSearchSurfaceMediaCategory(row) === "SERP_SCREENSHOT";
}
