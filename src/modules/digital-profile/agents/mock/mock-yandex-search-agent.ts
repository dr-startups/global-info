/**
 * Mock Yandex search agent. Generates deterministic demo search queries and
 * results (engine = YANDEX, RU-focused). No network access.
 *
 * Idempotency: it owns the GENERATED queries for its engine (re-created each
 * run) and inserts results with createMany({ skipDuplicates }) against the
 * unique [caseId, dedupHash] constraint, so re-runs never pile up duplicates.
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

const NEG_DOMAINS = ["compromat-ru.example", "news-watch-ru.example"];
const NEU_DOMAINS = ["ru-directory.example", "people-ru.example"];
const POS_DOMAINS = ["company-ru.example", "press-ru.example"];

export class MockYandexSearchAgent extends BaseMockAgent<Raw, Raw> {
  readonly name: AgentNameValue = "YANDEX_SEARCH";
  readonly displayName = "Yandex Search (mock)";
  readonly description =
    "Generates demo Yandex search queries and results (RU). Mock data only.";

  protected async collect(
    ctx: AgentContext,
    subject: CaseSubjectInfo,
    rng: () => number
  ): Promise<Raw> {
    const terms = [subject.fullName, ...subject.aliases].filter(Boolean);
    const queries = [
      `${subject.fullName}`,
      `${subject.fullName} компания`,
      `${subject.fullName} расследование`,
      `${subject.fullName} биография`,
      `${pick(rng, terms)} новости`,
    ];

    const slug = slugify(subject.fullName) || "subject";
    const total = 10 + Math.floor(rng() * 8); // 10–17
    const results: ResultRow[] = [];
    for (let i = 0; i < total; i++) {
      const roll = rng();
      const [classification, domains, snippet] =
        roll < 0.3
          ? (["ADVERSE_MEDIA", NEG_DOMAINS, "Adverse media mention (negative)"] as const)
          : roll < 0.65
            ? (["RELEVANT", NEU_DOMAINS, "Directory / neutral mention"] as const)
            : (["CORPORATE", POS_DOMAINS, "Corporate / positive mention"] as const);
      const domain = pick(rng, domains);
      results.push(
        buildSearchResultRow({
          caseId: ctx.caseId,
          engine: "YANDEX",
          url: `https://${domain}/${slug}-${i + 1}`,
          title: `${subject.fullName} — result ${i + 1} (yandex)`,
          snippet,
          rank: i + 1,
          classification,
        })
      );
    }
    return { queries, results };
  }

  async normalizeOutput(raw: Raw): Promise<Raw> {
    return raw;
  }

  async saveEvidence(ctx: AgentContext, norm: Raw): Promise<SavedEvidenceSummary> {
    // Agent owns its engine's GENERATED queries — recreate them on each run.
    await prisma.searchQuery.deleteMany({
      where: { caseId: ctx.caseId, engine: "YANDEX", source: "GENERATED" },
    });
    await prisma.searchQuery.createMany({
      data: norm.queries.map((queryText) => ({
        caseId: ctx.caseId,
        engine: "YANDEX" as const,
        queryText,
        source: "GENERATED" as const,
        createdBy: "mock:YANDEX_SEARCH",
      })),
    });
    const inserted = await prisma.searchResult.createMany({
      data: norm.results,
      skipDuplicates: true,
    });
    return { searchResults: inserted.count };
  }
}
