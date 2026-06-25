/**
 * Mock compliance database agent. Creates demo database_profiles for the three
 * providers (DOW_JONES, LEXISNEXIS, WORLD_CHECK). No real provider API is used.
 *
 * The enum has no *_MOCK provider and no MOCK import method, so we keep real
 * enum values (importMethod = MANUAL_IMPORT) and mark the demo nature via
 * `importedBy` (owner marker) + `rawPayload.demo = true`.
 *
 * Idempotency: agent-owned rows are deleted by owner marker and recreated.
 */

import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import { BaseMockAgent, type CaseSubjectInfo } from "./mock-utils";

const OWNER = "mock:COMPLIANCE_DATABASE";

const PROVIDERS = [
  { provider: "DOW_JONES" as const, category: "PEP" },
  { provider: "LEXISNEXIS" as const, category: "ADVERSE_MEDIA" },
  { provider: "WORLD_CHECK" as const, category: "SANCTIONS" },
];

interface ProfileDraft {
  provider: "DOW_JONES" | "LEXISNEXIS" | "WORLD_CHECK";
  matchType: string;
  matchScore: number;
  rawPayload: Prisma.InputJsonValue;
  evidenceRefs: Prisma.InputJsonValue;
}
interface Raw {
  profiles: ProfileDraft[];
}

export class MockComplianceDatabaseAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "COMPLIANCE_DATABASE";
  readonly displayName = "Compliance Databases (mock)";
  readonly description =
    "Creates demo screening profiles (Dow Jones / LexisNexis / World-Check). Mock data only — no real API.";

  protected async collect(
    _ctx: AgentContext,
    subject: CaseSubjectInfo,
    rng: () => number
  ): Promise<Raw> {
    const profiles = PROVIDERS.map((p) => {
      const matchScore = Math.round(40 + rng() * 60);
      const matchStatus = matchScore > 75 ? "POTENTIAL_MATCH" : "NO_MATCH";
      return {
        provider: p.provider,
        matchType: p.category,
        matchScore,
        rawPayload: {
          demo: true,
          provider: p.provider,
          matchStatus,
          category: p.category,
          profileSummary: `Demo ${p.provider} screening for ${subject.fullName} (${matchStatus}).`,
          mediaCheckSummary: `Demo adverse-media check: ${matchScore > 60 ? "items found" : "no items"}.`,
        } satisfies Prisma.InputJsonValue,
        evidenceRefs: [
          {
            type: "DATABASE_RECORD",
            label: `${p.provider} demo record`,
          },
        ] as unknown as Prisma.InputJsonValue,
      };
    });
    return { profiles };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    await prisma.databaseProfile.deleteMany({
      where: { caseId: ctx.caseId, importedBy: OWNER },
    });
    await prisma.databaseProfile.createMany({
      data: norm.profiles.map((p) => ({
        caseId: ctx.caseId,
        provider: p.provider,
        importMethod: "MANUAL_IMPORT" as const,
        matchType: p.matchType,
        matchScore: p.matchScore,
        rawPayload: p.rawPayload,
        evidenceRefs: p.evidenceRefs,
        importedBy: OWNER,
      })),
    });
    return { databaseProfiles: norm.profiles.length };
  }
}
