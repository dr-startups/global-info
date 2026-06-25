/**
 * Real search-surface agent (Stage H3).
 *
 * Capability-based and safe-by-design. It inspects each provider's declared
 * surface capabilities and records a capability NOTE for every non-organic
 * surface (e.g. "GOOGLE imageSearch: NOT_SUPPORTED"). It does NOT scrape, does
 * NOT take live SERP screenshots, and does NOT auto-fill manual sections.
 *
 * Organic search itself is handled by the dedicated REAL_GOOGLE_SEARCH /
 * REAL_YANDEX_SEARCH agents, so it is intentionally not duplicated here.
 */

import { getProviderCapabilities } from "../../providers/capabilities";
import type { ProviderName } from "../../providers/config";
import type {
  ProviderCapabilities,
  SearchSurfaceInput,
  SearchSurfaceSource,
} from "../../search-surfaces/types";
import { createManySearchSurfaceItems } from "../../services/search-surface-service";
import { loadCaseSubject } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

const PROVIDERS: ProviderName[] = ["GOOGLE", "YANDEX", "WIKIPEDIA"];

const SOURCE_BY_PROVIDER: Record<ProviderName, SearchSurfaceSource> = {
  GOOGLE: "REAL_GOOGLE",
  YANDEX: "REAL_YANDEX",
  WIKIPEDIA: "REAL_WIKIPEDIA",
};

// Surfaces we report capability notes for (organic is handled elsewhere).
const SURFACE_CAPS: (keyof ProviderCapabilities)[] = [
  "imageSearch",
  "videoSearch",
  "suggestions",
  "relatedQueries",
  "knowledgeBlock",
  "screenshots",
];

export class RealSearchSurfaceAgent implements CaseAgent {
  readonly name = "REAL_SEARCH_SURFACES";
  readonly displayName = "Real Search Surfaces";
  readonly description =
    "Inspects provider surface capabilities (image/video/suggestions/related/knowledge/screenshots) and records capability notes. No scraping or live screenshots.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "SEARCH_SURFACES";

  /** Always available: it only records capability notes (no keys, no network). */
  availability(): AgentAvailability {
    return { status: "ENABLED" };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  private buildNotes(): SearchSurfaceInput[] {
    const notes: SearchSurfaceInput[] = [];
    for (const provider of PROVIDERS) {
      const caps = getProviderCapabilities(provider);
      for (const cap of SURFACE_CAPS) {
        const c = caps[cap];
        notes.push({
          type: "MANUAL_NOTE",
          source: SOURCE_BY_PROVIDER[provider],
          provider,
          title: `${provider} · ${cap}: ${c.method}`,
          snippet: c.supported
            ? `Supported via ${c.method}.`
            : `Not available through the official API on this stage (${c.method}).`,
          classification: "CAPABILITY_NOTE",
          demo: false,
          rawMetadata: { capabilityNote: true, provider, capability: cap, ...c },
        });
      }
    }
    return notes;
  }

  async saveEvidence(ctx: AgentContext, normalized: unknown): Promise<SavedEvidenceSummary> {
    const notes = normalized as SearchSurfaceInput[];
    const { created } = await createManySearchSurfaceItems(ctx.caseId, notes, {
      actorId: "real:SEARCH_SURFACES",
    });
    return { searchSurfaceItems: created };
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      await loadCaseSubject(ctx.caseId);
      const notes = this.buildNotes();
      const saved = await this.saveEvidence(ctx, await this.normalizeOutput(notes));
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: { demo: false, capabilityNotes: notes.length },
        saved,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Real search surface agent failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
