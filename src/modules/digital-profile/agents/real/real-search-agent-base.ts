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

import { prisma } from "@/server/prisma/client";
import type { OfflinePlanSubject } from "../../search-surfaces/offline-orion-query-plan";
import type { Prisma, SearchEngine } from "@prisma/client";
import { normalizeUrl } from "../../services/evidence-service";
import { searchResultDedupHash } from "../../services/search-result-identity";
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

/** Запрос плана аудита: фраза, регион поисковика, язык, глубина и контур. */
export type AuditSearchSpec = {
  query: string;
  region: string;
  language: string;
  limit: number;
  /** Контур отчёта («RU», «UAE») — не то же, что код региона поисковика. */
  contour: string;
  /** Назначение запроса в плане (`subject_lookup`, `business_lookup`, …). */
  purpose?: string;
  /** Запрос — само имя субъекта; по нему строится таблица ТОП-20 раздела. */
  subjectNameQuery?: boolean;
};

/** То, что строка результата помнит о своём запросе. */
export type SearchRowOrigin = {
  query: string;
  contour?: string;
  purpose?: string;
  subjectNameQuery?: boolean;
};

/**
 * Строка результата помнит, чем и где её нашли (шаг 0138).
 *
 * Склейка берёт запрос и контур из `rawMetadata` строки
 * (`composite-serp-merge`: `rm.query ?? rm.orionQuery`, `rm.orionRegion ??
 * rm.region`, иначе литерал «RU»), а базовый агент туда их не клал. На
 * прогоне Вексельберга 20.09.2026 это дало 81 органическую строку Serper без
 * записанного запроса и всю с регионом «RU», хотя план ходил и по ОАЭ: строки
 * ОАЭ становились российскими и склеивались с ними по адресу.
 *
 * Контур ставится только когда он известен: у личного набора запросов его нет,
 * и выдумывать «RU» здесь значило бы повторить тот же дефект с другой стороны.
 */
export function taggedSearchRows(
  results: readonly SearchProviderResult[],
  spec: SearchRowOrigin
): SearchProviderResult[] {
  return results.map((r) => ({
    ...r,
    rawMetadata: {
      ...((r.rawMetadata ?? {}) as Record<string, unknown>),
      query: spec.query,
      ...(spec.contour ? { orionRegion: spec.contour } : {}),
      // Пометки плана (шаг 0146). Склейка читает ровно эти поля
      // (`composite-serp-merge`: `rm.queryPurpose`, `rm.subjectNameQuery`), а
      // писал их только сборщик ORION-профиля: в бандле Мельниченко пометку
      // «это само имя» несли 20 строк Яндекса и ни одной строки Google, и
      // таблица Google выбрала запрос счётом материалов.
      ...(spec.purpose ? { queryPurpose: spec.purpose } : {}),
      ...(spec.subjectNameQuery ? { subjectNameQuery: true } : {}),
    },
  }));
}

/**
 * Хеш записи строки: адрес, движок и — когда строка их знает — запрос и контур.
 *
 * Идентичность строки (`searchResultDedupHash`) так и устроена: запрос и
 * регион входят в хеш там, где строка их знает. С шага 0138 строка базового
 * сбора их знает, а хеш считался по одному адресу, и `createMany({
 * skipDuplicates })` молча выбрасывал строку следующего запроса или другого
 * контура с уже виденным адресом. На прогоне Мельниченко 22.09.2026 у запроса
 * «Мельниченко Андрей» так не записались позиции 1–7 и 9, а отчёт объявил их
 * невозвращёнными.
 *
 * Строка без запроса и контура сохраняет прежний хеш «движок + адрес»:
 * повторный сбор старого кейса остаётся идемпотентным.
 */
export function searchRowDedupHash(
  engine: string,
  normalizedUrl: string,
  rawMetadata: unknown
): string {
  const rm = (rawMetadata ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v : undefined;
  const query = text(rm.query);
  const region = text(rm.orionRegion);
  return searchResultDedupHash({
    engine,
    normalizedUrl,
    ...(query !== undefined ? { query } : {}),
    ...(region !== undefined ? { region } : {}),
  });
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

  /**
   * Запросы аудита вместо личного набора (шаг 0137).
   *
   * У движка, который собирает позиции органической выдачи, набор запросов —
   * это план аудита: регионы и глубина у него свои, и второго набора для той
   * же выдачи не заводится. `null` — прежний личный набор, и остальные агенты
   * не меняются.
   */
  protected auditSearchSpecs(_subject: OfflinePlanSubject): AuditSearchSpec[] | null {
    return null;
  }

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
        // Движок в хеше: один и тот же адрес, найденный обоими поисковиками,
        // это два факта. Хеш по одному адресу вычёркивал строки того агента,
        // который отработал вторым. Запрос и контур — по той же причине
        // (шаг 0146).
        dedupHash: searchRowDedupHash(this.engine, normUrl, r.rawMetadata),
        title: r.title || null,
        snippet: r.snippet || null,
        rank: r.rank,
        source,
        rawMetadata: {
          demo: false,
          provider: this.provider.name,
          ...(r.rawMetadata as object),
          // Normalised publication date (step 05.2a). Kept in rawMetadata so no
          // migration is needed; downstream reads it via publishedAtOf().
          ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        } as Prisma.InputJsonValue,
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
      const planSubject = {
        fullName: subject.fullName,
        aliases: subject.aliases,
        targetRegions: subject.targetRegions,
        location: subject.location,
      };
      const specs: Array<
        SearchRowOrigin & {
          language: string;
          region?: string;
          limit?: number;
        }
      > =
        this.auditSearchSpecs(planSubject as OfflinePlanSubject) ??
        buildPersonSearchQueries(planSubject, {
          maxQueries: this.maxQueriesPerAudit(),
          includeNegative: allowsNegativeQueries(subject),
        });

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
          // Глубина есть только у плана аудита; личный набор её не называет и
          // остаётся с умолчанием провайдера.
          ...(typeof spec.limit === "number" ? { limit: spec.limit } : {}),
        });
        if (run.status === "SUCCESS") {
          anySuccess = true;
          // Спека целиком: копия по полям однажды уже потеряла назначение и
          // пометку имени (шаги 0137–0138).
          allResults.push(...taggedSearchRows(run.results, spec));
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
