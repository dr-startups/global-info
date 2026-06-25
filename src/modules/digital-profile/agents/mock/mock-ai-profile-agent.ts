/**
 * Mock AI profile agent. Creates demo ai_profiles for two mock providers
 * (OPENAI_MOCK, GEMINI_MOCK). No LLM is called. Summaries are clearly marked as
 * demo and the schema's disclaimer ("not a source of fact") applies.
 *
 * Idempotency: the agent owns these two mock models — they are deleted and
 * recreated on each run (no duplicate pile-up).
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import { BaseMockAgent, DEMO_TAG, type CaseSubjectInfo } from "./mock-utils";

const MODELS = ["OPENAI_MOCK", "GEMINI_MOCK"] as const;

interface ProfileDraft {
  model: string;
  summary: string;
  classifications: Record<string, unknown>;
}
interface Raw {
  profiles: ProfileDraft[];
}

export class MockAiProfileAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "AI_PROFILE";
  readonly displayName = "AI Profile (mock)";
  readonly description =
    "Creates demo AI summaries for mock providers. No real LLM is called.";

  protected async collect(
    _ctx: AgentContext,
    subject: CaseSubjectInfo
  ): Promise<Raw> {
    const profiles = MODELS.map((model) => ({
      model,
      summary: `${DEMO_TAG} Demo ${model} summary for ${subject.fullName}. Generated without any real LLM call; for demonstration only.`,
      classifications: {
        demo: true,
        prompt: `Summarize the public profile of ${subject.fullName} based strictly on collected evidence.`,
        citedSources: 3,
        themes: ["corporate", "media-presence"],
      },
    }));
    return { profiles };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    await prisma.aiProfile.deleteMany({
      where: { caseId: ctx.caseId, model: { in: [...MODELS] } },
    });
    await prisma.aiProfile.createMany({
      data: norm.profiles.map((p) => ({
        caseId: ctx.caseId,
        model: p.model,
        summary: p.summary,
        classifications: p.classifications as Prisma.InputJsonValue,
        evidenceRefs: [] as unknown as Prisma.InputJsonValue,
        createdBy: "mock:AI_PROFILE",
      })),
    });
    return { aiProfiles: norm.profiles.length };
  }
}
