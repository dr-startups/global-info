/**
 * Five Arsenkin functional CaseAgents (registry slugs).
 * executionMode=DURABLE_ASYNC — run() only starts durable execution; never SUCCEEDED on enqueue.
 */

import type { AgentNameValue } from "../../types";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import { isArsenkinEnabled, arsenkinApiToken, arsenkinTools } from "../../providers/arsenkin/flags";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";

function arsenkinAvailability(): AgentAvailability {
  if (!isArsenkinEnabled()) {
    return { status: "DISABLED", message: "ARSENKIN_ENABLED is not true." };
  }
  if (!arsenkinApiToken()) {
    return { status: "NOT_CONFIGURED", message: "ARSENKIN_API_TOKEN is not set." };
  }
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
    /* missing artifact → allow ENABLED when token present */
  }
  return { status: "ENABLED", message: "Arsenkin ready." };
}

abstract class ArsenkinCaseAgentBase implements CaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly tools: ArsenkinToolName[];
  readonly kind = "REAL" as const;
  readonly executionMode = "DURABLE_ASYNC" as const;
  readonly agentName: AgentNameValue = "SEARCH_SURFACES";

  availability(): AgentAvailability {
    /*
     * Агент считается доступным, только если хотя бы один его инструмент
     * включён составом `ARSENKIN_TOOLS`.
     *
     * Раньше состав инструментов проверялся лишь в `enrich-report-run-with-
     * arsenkin`, а агенты запускались всегда. Из-за этого отключение второй
     * стадии (ADR-0005) на прогон не влияло: `ARSENKIN_URL_AUDIT_REAL`
     * (check-h, indexation) уходил в работу и падал, а время прогона не
     * менялось. Состав — это один ответ на вопрос «какие инструменты
     * работают», и агенты обязаны спрашивать его же.
     */
    const base = arsenkinAvailability();
    if (base.status !== "ENABLED") return base;
    const enabled = arsenkinTools();
    if (!this.tools.some((t) => enabled.includes(t))) {
      return {
        status: "DISABLED",
        message: `Инструменты агента (${this.tools.join(", ")}) не входят в ARSENKIN_TOOLS.`,
      };
    }
    return base;
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

  /**
   * Durable start only. Must return RUNNING — never SUCCEEDED.
   * Actual enqueue/finalize is owned by agent-run-service + arsenkin-case-agent-execution.
   */
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
    return {
      agentName: this.agentName,
      status: "RUNNING",
      output: {
        agentId: this.name,
        tools: this.tools,
        executionMode: "DURABLE_ASYNC",
        note: "Durable Arsenkin execution started — awaiting ProviderTask/coverage finalize.",
      },
      saved: {},
      startedAt,
      finishedAt: startedAt,
    };
  }
}

/**
 * Инструменты каждого агента — в одном месте.
 *
 * Раньше состав был записан только в полях классов, и всякий, кому нужно было
 * узнать «чем работает этот агент», либо создавал экземпляр, либо повторял
 * список у себя. Ответ на вопрос должен быть один и доступен без экземпляра:
 * по нему решается, участвует ли агент в прогоне вообще.
 */
export const ARSENKIN_AGENT_TOOLS = {
  ARSENKIN_SEARCH_TOP_REAL: ["check-top"],
  ARSENKIN_SUGGESTIONS_REAL: ["suggest"],
  ARSENKIN_PAA_REAL: ["paa"],
  ARSENKIN_AI_SEARCH_REAL: ["ai-serp"],
  ARSENKIN_URL_AUDIT_REAL: ["check-h", "indexation"],
} as const satisfies Record<string, readonly ArsenkinToolName[]>;

export class ArsenkinSearchTopRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_SEARCH_TOP_REAL";
  readonly displayName = "Arsenkin Search TOP (real)";
  readonly description =
    "check-top: RU Yandex organic, RU Google organic, UAE Google organic.";
  readonly tools: ArsenkinToolName[] = [...ARSENKIN_AGENT_TOOLS.ARSENKIN_SEARCH_TOP_REAL];
}

export class ArsenkinSuggestionsRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_SUGGESTIONS_REAL";
  readonly displayName = "Arsenkin Suggestions (real)";
  readonly description =
    "suggest: RU Yandex / RU Google / UAE Google suggestions.";
  readonly tools: ArsenkinToolName[] = [...ARSENKIN_AGENT_TOOLS.ARSENKIN_SUGGESTIONS_REAL];
}

export class ArsenkinPaaRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_PAA_REAL";
  readonly displayName = "Arsenkin PAA (real)";
  readonly description = "paa: RU Google PAA, UAE Google PAA.";
  readonly tools: ArsenkinToolName[] = [...ARSENKIN_AGENT_TOOLS.ARSENKIN_PAA_REAL];
}

export class ArsenkinAiSearchRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_AI_SEARCH_REAL";
  readonly displayName = "Arsenkin AI Search (real)";
  readonly description = "ai-serp: RU Yandex AI, RU Google AI, UAE Google AI.";
  readonly tools: ArsenkinToolName[] = [...ARSENKIN_AGENT_TOOLS.ARSENKIN_AI_SEARCH_REAL];
}

export class ArsenkinUrlAuditRealAgent extends ArsenkinCaseAgentBase {
  readonly name = "ARSENKIN_URL_AUDIT_REAL";
  readonly displayName = "Arsenkin URL Audit (real)";
  readonly description = "check-h + indexation URL audit surfaces.";
  readonly tools: ArsenkinToolName[] = [...ARSENKIN_AGENT_TOOLS.ARSENKIN_URL_AUDIT_REAL];
}

export const ARSENKIN_REAL_AGENT_NAMES = [
  "ARSENKIN_SEARCH_TOP_REAL",
  "ARSENKIN_SUGGESTIONS_REAL",
  "ARSENKIN_PAA_REAL",
  "ARSENKIN_AI_SEARCH_REAL",
  "ARSENKIN_URL_AUDIT_REAL",
] as const;

export function isArsenkinRealAgentName(name: string): boolean {
  return (ARSENKIN_REAL_AGENT_NAMES as readonly string[]).includes(name);
}

/**
 * Участвует ли агент в прогоне при текущем составе инструментов.
 *
 * Тот же вопрос решает `availability()`, но там он смешан с токеном и
 * готовностью базы, а здесь нужен именно состав: отключённый составом агент не
 * должен ни отправляться, ни считаться незавершённым. Проверка ставится там,
 * где **выбирают работу** — в определении разрыва отправок и в тике
 * обогащения, — а не внутри того, кто эту работу описывает.
 */
export function isArsenkinAgentEnabled(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const tools = (ARSENKIN_AGENT_TOOLS as Record<string, readonly ArsenkinToolName[]>)[agentName];
  if (!tools) return false;
  const enabled = arsenkinTools(env);
  return tools.some((t) => enabled.includes(t));
}
