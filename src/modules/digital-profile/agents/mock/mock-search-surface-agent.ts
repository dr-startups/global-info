/**
 * Mock search-surface agent (Stage H3).
 *
 * Populates demo data across all extra search surfaces so the UI/report can be
 * exercised offline: suggestions, related queries, image/video results, a
 * knowledge block and SERP-screenshot placeholders. No external APIs, no
 * scraping, no LLM. Everything is demo=true / source=MOCK / rawMetadata.mock=true.
 *
 * Idempotent: createMany + skipDuplicates on [caseId, dedupHash] means re-runs
 * never grow the row count.
 */

import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import { BaseMockAgent, DEMO_TAG, type CaseSubjectInfo } from "./mock-utils";
import {
  createManySearchSurfaceItems,
} from "../../services/search-surface-service";
import type { SearchSurfaceInput } from "../../search-surfaces/types";

interface Raw {
  items: SearchSurfaceInput[];
}

const COUNTS = { suggestions: 10, related: 8, images: 6, videos: 3, knowledge: 1, screenshots: 2 };

export class MockSearchSurfaceAgent extends BaseMockAgent<Raw, Raw> {
  readonly name = "MOCK_SEARCH_SURFACES";
  readonly displayName = "Mock Search Surfaces";
  readonly description =
    "Creates demo suggestions, related queries, images, videos, a knowledge block and SERP-screenshot placeholders. No external calls.";

  /** Maps to the SEARCH_SURFACES DB enum (overrides the slug-based default). */
  get agentName(): AgentNameValue {
    return "SEARCH_SURFACES";
  }

  protected async collect(_ctx: AgentContext, subject: CaseSubjectInfo): Promise<Raw> {
    const name = subject.fullName;
    const slug = encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
    const items: SearchSurfaceInput[] = [];

    const base = {
      source: "MOCK" as const,
      provider: "MOCK",
      demo: true,
      rawMetadata: { mock: true },
    };

    const suggestionPhrases = [
      "biography",
      "net worth",
      "company",
      "wikipedia",
      "linkedin",
      "news",
      "scandal",
      "wife",
      "age",
      "interview",
    ];
    for (let i = 0; i < COUNTS.suggestions; i++) {
      items.push({
        ...base,
        type: "SUGGESTION",
        query: `${name} ${suggestionPhrases[i % suggestionPhrases.length]}`,
        rank: i + 1,
      });
    }

    const relatedPhrases = [
      "who is",
      "early life of",
      "businesses of",
      "controversies",
      "awards",
      "family of",
      "education of",
      "quotes by",
    ];
    for (let i = 0; i < COUNTS.related; i++) {
      items.push({
        ...base,
        type: "RELATED_QUERY",
        query: `${relatedPhrases[i % relatedPhrases.length]} ${name}`,
        rank: i + 1,
      });
    }

    for (let i = 0; i < COUNTS.images; i++) {
      items.push({
        ...base,
        type: "IMAGE_RESULT",
        title: `${DEMO_TAG} ${name} — image ${i + 1}`,
        url: `https://images.example/${slug}/photo-${i + 1}`,
        imageUrl: `https://images.example/${slug}/photo-${i + 1}.jpg`,
        thumbnailUrl: `https://images.example/${slug}/thumb-${i + 1}.jpg`,
        classification: "UNCLASSIFIED",
        rank: i + 1,
      });
    }

    for (let i = 0; i < COUNTS.videos; i++) {
      items.push({
        ...base,
        type: "VIDEO_RESULT",
        title: `${DEMO_TAG} ${name} — video ${i + 1}`,
        url: `https://video.example/watch?v=${slug}-${i + 1}`,
        videoUrl: `https://video.example/watch?v=${slug}-${i + 1}`,
        thumbnailUrl: `https://video.example/thumb/${slug}-${i + 1}.jpg`,
        classification: "UNCLASSIFIED",
        rank: i + 1,
      });
    }

    for (let i = 0; i < COUNTS.knowledge; i++) {
      items.push({
        ...base,
        type: "KNOWLEDGE_BLOCK",
        title: `${DEMO_TAG} ${name}`,
        snippet: `${DEMO_TAG} Demo knowledge block for ${name}. Structured summary for demonstration only.`,
        url: `https://knowledge.example/${slug}`,
        rawMetadata: {
          mock: true,
          attributes: { occupation: "Executive", nationality: "—", born: "—" },
        },
      });
    }

    for (let i = 0; i < COUNTS.screenshots; i++) {
      items.push({
        ...base,
        type: "SERP_SCREENSHOT",
        title: `${DEMO_TAG} SERP screenshot placeholder ${i + 1}`,
        snippet: "Placeholder reference. Upload a real screenshot or generate a synthetic snapshot.",
        url: `https://serp.example/${slug}/snapshot-${i + 1}`,
        rawMetadata: { mock: true, placeholder: true },
      });
    }

    return { items };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    const { created } = await createManySearchSurfaceItems(ctx.caseId, norm.items, {
      actorId: "mock:SEARCH_SURFACES",
    });
    return { searchSurfaceItems: created };
  }
}
