/**
 * Mock risk classifier. Reads already-collected evidence (search results,
 * database profiles, wikipedia checks) and derives risk_findings, each linked to
 * concrete evidence refs. No LLM is used — this is deterministic rule-of-thumb
 * classification over existing rows.
 *
 * Idempotency + human-review safety: only this agent's own PENDING findings are
 * cleared and rebuilt. REVIEWED/DISMISSED findings (human decisions) are never
 * touched.
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import { BaseMockAgent, DEMO_TAG, type CaseSubjectInfo } from "./mock-utils";

const OWNER = "mock:RISK_CLASSIFIER";

interface FindingDraft {
  category: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  summary: string;
  evidenceRefs: Prisma.InputJsonValue;
}
interface Raw {
  findings: FindingDraft[];
}

export class MockRiskClassifierAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "RISK_CLASSIFIER";
  readonly displayName = "Risk Classifier (mock)";
  readonly description =
    "Derives demo risk findings from collected evidence. Deterministic, evidence-linked, no LLM.";

  protected async collect(ctx: AgentContext, _subject: CaseSubjectInfo): Promise<Raw> {
    const [adverse, dbMatches, wiki] = await Promise.all([
      prisma.searchResult.findMany({
        where: { caseId: ctx.caseId, classification: "ADVERSE_MEDIA" },
        select: { id: true, url: true, title: true },
        take: 5,
      }),
      prisma.databaseProfile.findMany({
        where: { caseId: ctx.caseId },
        select: { id: true, provider: true, matchType: true, matchScore: true },
      }),
      prisma.wikipediaCheck.findFirst({
        where: { caseId: ctx.caseId },
        select: { exists: true, url: true },
      }),
    ]);

    const findings: FindingDraft[] = [];

    if (adverse.length > 0) {
      const severity = adverse.length >= 4 ? "HIGH" : adverse.length >= 2 ? "MEDIUM" : "LOW";
      findings.push({
        category: "Adverse media",
        severity,
        title: `Adverse media presence (${adverse.length} item(s))`,
        summary: `${DEMO_TAG} Demo finding derived from ${adverse.length} adverse-media search result(s).`,
        evidenceRefs: adverse.map((r) => ({
          type: "URL",
          refId: r.id,
          url: r.url,
          label: r.title ?? r.url,
        })) as unknown as Prisma.InputJsonValue,
      });
    }

    for (const m of dbMatches) {
      const score = m.matchScore ?? 0;
      if (score <= 60) continue; // only material matches become findings
      const severity = m.provider === "WORLD_CHECK" ? "CRITICAL" : "HIGH";
      findings.push({
        category: "Compliance database",
        severity,
        title: `Potential ${m.matchType ?? "match"} — ${m.provider}`,
        summary: `${DEMO_TAG} Demo finding from ${m.provider} screening (score ${score}).`,
        evidenceRefs: [
          { type: "DATABASE_RECORD", refId: m.id, label: `${m.provider} record` },
        ] as unknown as Prisma.InputJsonValue,
      });
    }

    if (wiki?.exists) {
      findings.push({
        category: "Public notability",
        severity: "INFO",
        title: "Subject has a Wikipedia presence",
        summary: `${DEMO_TAG} Demo informational finding: a Wikipedia page exists.`,
        evidenceRefs: [
          { type: "URL", url: wiki.url ?? undefined, label: "Wikipedia page" },
        ] as unknown as Prisma.InputJsonValue,
      });
    }

    return { findings };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    // Only clear this agent's PENDING findings; never remove human decisions.
    await prisma.riskFinding.deleteMany({
      where: { caseId: ctx.caseId, createdBy: OWNER, reviewStatus: "PENDING" },
    });
    if (norm.findings.length > 0) {
      await prisma.riskFinding.createMany({
        data: norm.findings.map((f) => ({
          caseId: ctx.caseId,
          category: f.category,
          severity: f.severity,
          title: f.title,
          summary: f.summary,
          evidenceRefs: f.evidenceRefs,
          reviewStatus: "PENDING" as const,
          createdBy: OWNER,
        })),
      });
    }
    return { riskFindings: norm.findings.length };
  }
}
