/**
 * Real Wikipedia agent. Uses the public WikipediaProvider to check whether the
 * subject has a Wikipedia page, then stores the result as evidence-first data in
 * wikipedia_checks. No scraping, no auto-publishing.
 *
 * Idempotency: there is no unique constraint for wikipedia_checks, so we do a
 * soft upsert per (caseId, language) scoped to this agent's marker
 * (checkedBy = "real:WIKIPEDIA"). Re-runs update in place — they never pile up.
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import {
  wikipediaProvider,
  type WikipediaLookupResult,
} from "../../providers/wikipedia-provider";
import { loadCaseSubject } from "../mock/mock-utils";
import type {
  AgentAvailability,
  AgentContext,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

const CHECKED_BY = "real:WIKIPEDIA";

export class RealWikipediaAgent implements CaseAgent {
  readonly name = "REAL_WIKIPEDIA";
  readonly displayName = "Real Wikipedia Check";
  readonly description =
    "Checks public Wikipedia pages via the official public API and stores evidence.";
  readonly kind = "REAL" as const;
  readonly agentName: AgentNameValue = "WIKIPEDIA";

  availability(): AgentAvailability {
    return wikipediaProvider.availability();
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
    const lookup = normalized as WikipediaLookupResult;
    let saved = 0;
    for (const lang of lookup.languages) {
      const data = {
        exists: lang.exists,
        url: lang.url,
        language: lang.language,
        pageTitle: lang.matchedTitle,
        snapshot: {
          demo: false,
          source: "REAL_WIKIPEDIA",
          notabilityScore: lang.notabilityScore,
          extract: lang.extract,
          reviewerStatus: "PENDING",
          sourceChecklist: {
            candidates: lang.candidates.map((c) => c.title),
            matched: lang.matchedTitle,
          },
          raw: lang.rawSnapshot,
        } as unknown as Prisma.InputJsonValue,
        checkedBy: CHECKED_BY,
        lastChecked: new Date(),
      };

      const existing = await prisma.wikipediaCheck.findFirst({
        where: { caseId: ctx.caseId, language: lang.language, checkedBy: CHECKED_BY },
        select: { id: true },
      });
      if (existing) {
        await prisma.wikipediaCheck.update({ where: { id: existing.id }, data });
      } else {
        await prisma.wikipediaCheck.create({ data: { caseId: ctx.caseId, ...data } });
      }
      saved++;
    }
    return { wikipediaChecks: saved };
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    try {
      const subject = await loadCaseSubject(ctx.caseId);

      const lookup = await wikipediaProvider.lookup({
        subjectFullName: subject.fullName,
        aliases: subject.aliases,
      });

      if (lookup.status !== "SUCCESS") {
        return {
          agentName: this.agentName,
          status: "FAILED",
          saved: {},
          error: lookup.error
            ? `${lookup.error.code}: ${lookup.error.message}`
            : "Wikipedia lookup failed",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }

      const normalized = await this.normalizeOutput(lookup);
      const saved = await this.saveEvidence(ctx, normalized);
      const found = lookup.languages.filter((l) => l.exists).map((l) => l.language);
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: {
          demo: false,
          languages: lookup.languages.map((l) => ({
            language: l.language,
            exists: l.exists,
            matchedTitle: l.matchedTitle,
          })),
          warning: lookup.error?.message,
        },
        saved,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Real Wikipedia agent failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
