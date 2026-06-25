/**
 * Mock Wikipedia agent. Records (or updates) a single wikipedia_check per case.
 * Never auto-publishes anything. Extra fields without a column (notabilityScore,
 * sourceChecklist, draftStatus, reviewerStatus) live in the `snapshot` JSON.
 *
 * Idempotency: one Wikipedia presence per subject → upsert-by-case (find the
 * existing row and update it, otherwise create).
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import { BaseMockAgent, slugify, type CaseSubjectInfo } from "./mock-utils";

interface Raw {
  exists: boolean;
  url: string | null;
  pageTitle: string | null;
  snapshot: Prisma.InputJsonValue;
}

export class MockWikipediaAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "WIKIPEDIA";
  readonly displayName = "Wikipedia (mock)";
  readonly description =
    "Records a demo Wikipedia presence check (notability, source checklist). Mock data only.";

  protected async collect(
    _ctx: AgentContext,
    subject: CaseSubjectInfo,
    rng: () => number
  ): Promise<Raw> {
    const exists = rng() > 0.5;
    const notabilityScore = Math.round(rng() * 100);
    const slug = slugify(subject.fullName) || "subject";
    return {
      exists,
      url: exists ? `https://en.wikipedia-mock.example/wiki/${slug}` : null,
      pageTitle: exists ? subject.fullName : null,
      snapshot: {
        demo: true,
        notabilityScore,
        draftStatus: exists ? "PUBLISHED" : "NONE",
        reviewerStatus: "PENDING",
        sourceChecklist: {
          independentSources: exists,
          significantCoverage: notabilityScore > 50,
          reliableSources: notabilityScore > 30,
        },
      } satisfies Prisma.InputJsonValue,
    };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    // Scope to this agent's own record so it never clobbers real-connector rows.
    const existing = await prisma.wikipediaCheck.findFirst({
      where: { caseId: ctx.caseId, checkedBy: "mock:WIKIPEDIA" },
      select: { id: true },
    });
    const data = {
      exists: norm.exists,
      url: norm.url,
      language: "en",
      pageTitle: norm.pageTitle,
      snapshot: norm.snapshot,
      checkedBy: "mock:WIKIPEDIA",
      lastChecked: new Date(),
    };
    if (existing) {
      await prisma.wikipediaCheck.update({ where: { id: existing.id }, data });
    } else {
      await prisma.wikipediaCheck.create({ data: { caseId: ctx.caseId, ...data } });
    }
    return { wikipediaChecks: 1 };
  }
}
