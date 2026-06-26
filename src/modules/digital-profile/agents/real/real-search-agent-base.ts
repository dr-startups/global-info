/**
 * Shared base for the real Google/Yandex search agents.
 *
 * Flow: load subject -> build person queries -> call the official provider ->
 * persist search_queries + search_results (evidence-first, real metadata).
 *
 * Idempotency:
 *  - GENERATED queries owned by this agent (scoped by createdBy) are recreated.
 *  - search_results use the unique [caseId, dedupHash] constraint via
 *    createMany({ skipDuplicates }), so re-runs never pile up duplicate URLs.
 *  - Real rows are tagged source="real:<PROVIDER>" + rawMetadata.demo=false, and
 *    never touch mock rows (different source / dedupHash).
 */

import { createHash } from "node:crypto";
import { prisma } from "@/server/prisma/client";
import type { Prisma, SearchEngine } from "@prisma/client";
import { normalizeUrl } from "../../services/evidence-service";
import { buildPersonSearchQueries } from "../../providers/query-builder";
import type { SearchProvider } from "../../providers/search-provider";
import type { SearchProviderResult } from "../../providers/types";
import { recordAudit, type AuditAction } from "../../services/audit-log-service";
import { loadCaseSubject, type CaseSubjectInfo } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Decides whether adverse ("negative") queries are permitted for a case.
 * Conservative by default: requires an explicit lawful basis, and when the basis
 * is CONSENT the consent must be GRANTED.
 */
function allowsNegativeQueries(subject: CaseSubjectInfo): boolean {
  const basis = (subject.lawfulBasis ?? "").toUpperCase();
  if (!basis) return false;
  if (basis === "CONSENT") return (subject.consentStatus ?? "").toUpperCase() === "GRANTED";
  return ["LEGITIMATE_INTEREST", "LEGAL_OBLIGATION", "PUBLIC_INTEREST", "CONTRACT"].includes(basis);
}

export abstract class RealSearchAgentBase implements CaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly agentName: AgentNameValue;
  readonly kind = "REAL" as const;

  /** The official API provider this agent delegates to. */
  protected abstract readonly provider: SearchProvider;
  /** The DB SearchEngine value for stored rows. */
  protected abstract readonly engine: SearchEngine;

  /** Max distinct person queries per audit (subclasses may cap from config). */
  protected maxQueriesPerAudit(): number | undefined {
    return undefined;
  }

  /** Dedicated audit action for this engine's real run, if any. */
  protected auditAction(): AuditAction | undefined {
    return undefined;
  }

  availability(): AgentAvailability {
    const a = this.provider.availability();
    return { status: a.status, message: a.message };
  }

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async normalizeOutput(raw: unknown): Promise<unknown> {
    return raw;
  }

  async saveEvidence(
    ctx: AgentContext,
    normalized: unknown
  ): Promise<SavedEvidenceSummary> {
    const { queries, results } = normalized as {
      queries: { queryText: string }[];
      results: SearchProviderResult[];
    };
    const source = `real:${this.provider.name}`;

    // Recreate this agent's GENERATED queries only (scoped by createdBy).
    await prisma.searchQuery.deleteMany({
      where: { caseId: ctx.caseId, engine: this.engine, source: "GENERATED", createdBy: this.name },
    });
    await prisma.searchQuery.createMany({
      data: queries.map((q) => ({
        caseId: ctx.caseId,
        engine: this.engine,
        queryText: q.queryText,
        source: "GENERATED" as const,
        createdBy: this.name,
      })),
    });

    const rows = results.map((r) => {
      const normUrl = normalizeUrl(r.url);
      return {
        caseId: ctx.caseId,
        engine: this.engine,
        url: r.url,
        normalizedUrl: normUrl,
        dedupHash: sha256(normUrl),
        title: r.title || null,
        snippet: r.snippet || null,
        rank: r.rank,
        source,
        rawMetadata: { demo: false, provider: this.provider.name, ...(r.rawMetadata as object) } as Prisma.InputJsonValue,
      };
    });

    const inserted = await prisma.searchResult.createMany({ data: rows, skipDuplicates: true });
    return { searchResults: inserted.count };
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const audit = async (
      outcome: "SUCCEEDED" | "FAILED",
      meta: { queryCount: number; resultCount: number; errorCode?: string }
    ) => {
      const action = this.auditAction();
      if (!action) return;
      await recordAudit({
        caseId: ctx.caseId,
        action,
        actorId: ctx.actorId,
        metadata: {
          provider: this.provider.name,
          queryCount: meta.queryCount,
          resultCount: meta.resultCount,
          durationMs: Date.now() - startedMs,
          outcome,
          ...(meta.errorCode ? { errorCode: meta.errorCode } : {}),
        },
      });
    };
    try {
      const subject = await loadCaseSubject(ctx.caseId);
      const specs = buildPersonSearchQueries(
        {
          fullName: subject.fullName,
          aliases: subject.aliases,
          targetRegions: subject.targetRegions,
          location: subject.location,
        },
        {
          maxQueries: this.maxQueriesPerAudit(),
          includeNegative: allowsNegativeQueries(subject),
        }
      );

      const allResults: SearchProviderResult[] = [];
      let anySuccess = false;
      let lastError: string | undefined;
      let lastErrorCode: string | undefined;

      for (const spec of specs) {
        const run = await this.provider.search({
          caseId: ctx.caseId,
          subjectFullName: subject.fullName,
          aliases: subject.aliases,
          query: spec.query,
          language: spec.language,
          region: spec.region,
        });
        if (run.status === "SUCCESS") {
          anySuccess = true;
          allResults.push(...run.results);
        } else {
          lastError = run.error ? `${run.error.code}: ${run.error.message}` : run.status;
          lastErrorCode = run.error?.code ?? run.status;
          // DISABLED / NOT_CONFIGURED affect all queries — stop early.
          if (run.status === "DISABLED" || run.status === "NOT_CONFIGURED") break;
        }
      }

      if (!anySuccess) {
        await audit("FAILED", { queryCount: specs.length, resultCount: 0, errorCode: lastErrorCode });
        return {
          agentName: this.agentName,
          status: "FAILED",
          saved: {},
          error: lastError ?? "No results from provider",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }

      const normalized = await this.normalizeOutput({
        queries: specs.map((s) => ({ queryText: s.query })),
        results: allResults,
      });
      const saved = await this.saveEvidence(ctx, normalized);

      await audit("SUCCEEDED", {
        queryCount: specs.length,
        resultCount: saved.searchResults ?? allResults.length,
      });
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: {
          demo: false,
          provider: this.provider.name,
          queries: specs.length,
          fetched: allResults.length,
          warning: lastError,
        },
        saved,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      await audit("FAILED", { queryCount: 0, resultCount: 0, errorCode: "AGENT_ERROR" });
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Real search agent failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
