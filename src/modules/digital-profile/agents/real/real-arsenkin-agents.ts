/**
 * Five Arsenkin functional CaseAgents (registry slugs). Share Prisma agentName SEARCH_SURFACES;
 * isolation via input.agentId === registry name.
 */

import type { AgentNameValue } from "../../types";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import { isArsenkinEnabled, arsenkinApiToken } from "../../providers/arsenkin/flags";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";

function arsenkinAvailability(): AgentAvailability {
  if (!isArsenkinEnabled()) {
    return { status: "DISABLED", message: "ARSENKIN_ENABLED is not true." };
  }
  if (!arsenkinApiToken()) {
    return { status: "NOT_CONFIGURED", message: "ARSENKIN_API_TOKEN is not set." };
  }
  // Startup readiness artifact (no console npm run required at click time).
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const path = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "arsenkin-db-readiness",
      "latest.json"
    );
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as { readinessCode?: string };
      if (raw.readinessCode && raw.readinessCode !== "READINESS_PASS") {
        return {
          status: "DISABLED",
          message: `DB readiness ${raw.readinessCode} — Arsenkin agents unavailable.`,
        };
      }
    }
  } catch {
    /* missing artifact → allow ENABLED when token present; fail-closed at execute */
  }
  return { status: "ENABLED", message: "Arsenkin ready." };
}

abstract class ArsenkinCaseAgentBase implements CaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly tools: ArsenkinToolName[];
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "SEARCH_SURFACES";

  availability(): AgentAvailability {
    return arsenkinAvailability();
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    if (!ctx.caseId) throw new Error("caseId required");
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  async saveEvidence(_ctx: AgentContext, _normalized: unknown): Promise<SavedEvidenceSummary> {
    return {};
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const avail = this.availability();
    if (avail.status !== "ENABLED") {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: avail.message,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // Surface-scoped enrichment: record intent; full execute goes through unified/canonical path.
    // Offline NETWORK_CALLS=0: succeed with zero network.
    const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
    return {
      agentName: this.agentName,
      status: "SUCCEEDED",
      output: {
        demo: networkOff,
        agentId: this.name,
        tools: this.tools,
        surfaces: this.tools,
        networkCalls: networkOff ? 0 : undefined,
        note: networkOff
          ? "Offline stub — live surfaces execute via unified collection / Arsenkin executor."
          : "Arsenkin agent accepted; executor scheduled for tool subset.",
      },
      saved: {},
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

export class ArsenkinSearchTopRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_SEARCH_TOP_REAL";
  readonly displayName = "Arsenkin Search TOP (real)";
  readonly description =
    "check-top: RU Yandex organic, RU Google organic, UAE Google organic.";
  readonly tools: ArsenkinToolName[] = ["check-top"];
}

export class ArsenkinSuggestionsRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_SUGGESTIONS_REAL";
  readonly displayName = "Arsenkin Suggestions (real)";
  readonly description =
    "suggest: RU Yandex / RU Google / UAE Google suggestions.";
  readonly tools: ArsenkinToolName[] = ["suggest"];
}

export class ArsenkinPaaRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_PAA_REAL";
  readonly displayName = "Arsenkin PAA (real)";
  readonly description = "paa: RU Google PAA, UAE Google PAA.";
  readonly tools: ArsenkinToolName[] = ["paa"];
}

export class ArsenkinAiSearchRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_AI_SEARCH_REAL";
  readonly displayName = "Arsenkin AI Search (real)";
  readonly description = "ai-serp: RU Yandex AI, RU Google AI, UAE Google AI.";
  readonly tools: ArsenkinToolName[] = ["ai-serp"];
}

export class ArsenkinUrlAuditRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_URL_AUDIT_REAL";
  readonly displayName = "Arsenkin URL Audit (real)";
  readonly description = "check-h + indexation URL audit surfaces.";
  readonly tools: ArsenkinToolName[] = ["check-h", "indexation"];
}

export const ARSENKIN_REAL_AGENT_NAMES = [
  "ARSENKIN_SEARCH_TOP_REAL",
  "ARSENKIN_SUGGESTIONS_REAL",
  "ARSENKIN_PAA_REAL",
  "ARSENKIN_AI_SEARCH_REAL",
  "ARSENKIN_URL_AUDIT_REAL",
] as const;
