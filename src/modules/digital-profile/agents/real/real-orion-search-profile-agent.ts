/**
 * Stage O1–O3 — ORION full search profile agent.
 *
 * Runs multi-query matrix + Serper surfaces per region. Additive to existing
 * REAL_GOOGLE_SEARCH / REAL_YANDEX_SEARCH agents.
 */

import { runOrionSearchProfile } from "../../services/orion-search-profile-service";
import type { OrionRegionCode } from "../../search-surfaces/orion-query-plan";
import { externalGoogleSerpProvider } from "../../providers/external-google-serp-provider";
import { loadCaseSubject } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

export class RealOrionSearchProfileAgent implements CaseAgent {
  readonly name = "REAL_ORION_SEARCH_PROFILE";
  readonly displayName = "ORION Search Profile (full)";
  readonly description =
    "Multi-query TOP-20 matrix (RU Yandex+Google, UAE/International Google/Serper) plus suggestions, related, images, videos, and knowledge panel.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "SEARCH_SURFACES";

  availability(): AgentAvailability {
    const g = externalGoogleSerpProvider.status();
    if (g.state === "READY") {
      return { status: "ENABLED", message: "Serper ready for Google surfaces." };
    }
    return {
      status: g.state === "NOT_CONFIGURED" || g.state === "NOT_SELECTED" ? "NOT_CONFIGURED" : "DISABLED",
      message: g.message,
    };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  async saveEvidence(_ctx: AgentContext, _normalized: unknown): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      const result = await runOrionSearchProfile(ctx.caseId);
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: {
          demo: false,
          queries: result.plan.length,
          organicInserted: result.organicInserted,
          surfacesInserted: result.surfacesInserted,
          regions: result.regions,
        },
        saved: {
          searchResults: result.organicInserted,
          searchSurfaceItems: result.surfacesInserted,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "ORION search profile failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}

export class RealOrionGoogleSurfacesAgent implements CaseAgent {
  readonly name = "REAL_ORION_GOOGLE_SURFACES";
  readonly displayName = "Google Surfaces (Serper)";
  readonly description =
    "Collects Google suggestions, related queries, images, videos, and knowledge panel via Serper (no organic matrix).";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "SEARCH_SURFACES";

  availability(): AgentAvailability {
    const g = externalGoogleSerpProvider.status();
    return g.state === "READY"
      ? { status: "ENABLED" }
      : { status: "NOT_CONFIGURED", message: g.message };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  async saveEvidence(_ctx: AgentContext, _normalized: unknown): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      const result = await runOrionSearchProfile(ctx.caseId, { surfacesOnlyMode: true });
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: { demo: false, surfacesInserted: result.surfacesInserted },
        saved: { searchSurfaceItems: result.surfacesInserted },
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Google surfaces agent failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}

export class RealOrionUaeInternationalAgent implements CaseAgent {
  readonly name = "REAL_ORION_UAE_INTERNATIONAL";
  readonly displayName = "UAE / International Search";
  readonly description =
    "Runs ORION query plan and Google/Serper collection for UAE and International regions only.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "GOOGLE_SEARCH";

  availability(): AgentAvailability {
    const g = externalGoogleSerpProvider.status();
    return g.state === "READY"
      ? { status: "ENABLED" }
      : { status: "NOT_CONFIGURED", message: g.message };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  async saveEvidence(_ctx: AgentContext, _normalized: unknown): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const regions: OrionRegionCode[] = ["UAE", "INTERNATIONAL"];
    try {
      const result = await runOrionSearchProfile(ctx.caseId, { regions });
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: { demo: false, regions: result.regions },
        saved: {
          searchResults: result.organicInserted,
          searchSurfaceItems: result.surfacesInserted,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "UAE/International search failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
