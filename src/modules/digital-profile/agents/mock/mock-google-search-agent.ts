/**
 * Mock Google search agent. Like the Yandex one but engine = GOOGLE and it also
 * covers UAE when the case targetRegions include "UAE". Mock data only.
 */

import { prisma } from "@/server/prisma/client";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { AgentNameValue } from "../../types";
import {
  BaseMockAgent,
  buildSearchResultRow,
  pick,
  slugify,
  type CaseSubjectInfo,
} from "./mock-utils";

type ResultRow = ReturnType<typeof buildSearchResultRow>;
interface Raw {
  queries: string[];
  results: ResultRow[];
}

const REGION_DOMAINS: Record<string, string[]> = {
  RU: ["news-ru.example", "directory-ru.example", "press-ru.example"],
  UAE: ["gulf-news.example", "uae-business.example", "khaleej.example"],
  GLOBAL: ["global-news.example", "linkedin-mock.example", "company-registry.example"],
};

export class MockGoogleSearchAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "GOOGLE_SEARCH";
  readonly displayName = "Google Search (mock)";
  readonly description =
    "Generates demo Google search queries and results across target regions. Mock data only.";

  protected async collect(
    ctx: AgentContext,
    subject: CaseSubjectInfo,
    rng: () => number
  ): Promise<Raw> {
    const hasUae = subject.targetRegions.some((r) => /uae|emirat/i.test(r));
    const regions = ["RU", ...(hasUae ? ["UAE"] : []), "GLOBAL"];

    const queries = [
      `${subject.fullName}`,
      `${subject.fullName} sanctions`,
      `${subject.fullName} company owner`,
      `${subject.fullName} ${hasUae ? "UAE" : "profile"}`,
      `${subject.aliases[0] ?? subject.fullName} news`,
    ];

    const slug = slugify(subject.fullName) || "subject";
    const total = 10 + Math.floor(rng() * 8);
    const results: ResultRow[] = [];
    for (let i = 0; i < total; i++) {
      const region = pick(rng, regions);
      const roll = rng();
      const classification =
        roll < 0.25 ? "ADVERSE_MEDIA" : roll < 0.6 ? "RELEVANT" : roll < 0.8 ? "SOCIAL_PROFILE" : "CORPORATE";
      const domain = pick(rng, REGION_DOMAINS[region] ?? REGION_DOMAINS.GLOBAL);
      const page = Math.floor(i / 5) + 1;
      results.push(
        buildSearchResultRow({
          caseId: ctx.caseId,
          engine: "GOOGLE",
          url: `https://${domain}/${slug}/p${page}-${i + 1}`,
          title: `${subject.fullName} — ${region} result ${i + 1}`,
          snippet: `${region} mention (page ${page})`,
          rank: i + 1,
          classification,
          source: "mock:GOOGLE_SEARCH",
        })
      );
    }
    return { queries, results };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    await prisma.searchQuery.deleteMany({
      where: { caseId: ctx.caseId, engine: "GOOGLE", source: "GENERATED" },
    });
    await prisma.searchQuery.createMany({
      data: norm.queries.map((queryText) => ({
        caseId: ctx.caseId,
        engine: "GOOGLE" as const,
        queryText,
        source: "GENERATED" as const,
        createdBy: "mock:GOOGLE_SEARCH",
      })),
    });
    const inserted = await prisma.searchResult.createMany({
      data: norm.results,
      skipDuplicates: true,
    });
    return { searchResults: inserted.count };
  }
}
