/**
 * Attach persisted Arsenkin pilot observations onto the classic reportRunId
 * so First36 run-scoped merge can consume them.
 *
 *   npx tsx --env-file=.env scripts/attach-arsenkin-pilot-to-report-run.ts [pilotRunId] [reportRunId]
 */

import { PrismaClient } from "@prisma/client";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";
import type { SerpObservationDraft } from "../src/modules/digital-profile/serp-observation/types";
import { buildSerpQueryId } from "../src/modules/digital-profile/serp-observation/query-id";

const CASE_ID = "cmreamy2t0002o30f29urzcog";
const PILOT_RUN =
  process.argv[2]?.trim() || "arsenkin-pilot-1783974550396";
const REPORT_RUN =
  process.argv[3]?.trim() || "orion-r10-1783721072833";

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.serpObservation.findMany({
      where: { caseId: CASE_ID, auditRunId: PILOT_RUN, provider: "arsenkin" },
    });
    const drafts: SerpObservationDraft[] = rows
      .filter((r) => r.surface === "organic" || (r.surface === "autocomplete" && !/^(nrm|spc|lat|cyr|dig|loc|sho|quo|otzyv)$/i.test(String(r.title ?? ""))))
      .map((r) => {
        const queryId = buildSerpQueryId({
          auditRunId: REPORT_RUN,
          provider: "arsenkin",
          engine: r.engine,
          region: r.region,
          language: r.language,
          queryText: r.queryText,
          surface: r.surface,
        });
        return {
          caseId: r.caseId,
          auditRunId: REPORT_RUN,
          queryId,
          queryText: r.queryText,
          provider: "arsenkin" as const,
          engine: r.engine as "GOOGLE" | "YANDEX",
          surface: r.surface as "organic" | "autocomplete" | "paa",
          region: r.region,
          language: r.language,
          rank: r.rank,
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          domain: r.domain,
          providerStatus: (r.providerStatus as "OK") || "OK",
          rawPayloadJson: (r.rawPayloadJson as Record<string, unknown>) ?? {
            source: "arsenkin",
            attachedFromPilot: PILOT_RUN,
          },
          capturedAt: r.capturedAt,
        };
      });

    // Skip URLs already present for this report run (same provider/engine/surface/query/rank/url)
    const existing = await prisma.serpObservation.findMany({
      where: { auditRunId: REPORT_RUN, provider: "arsenkin" },
      select: { queryId: true, rank: true, url: true, engine: true, surface: true, region: true, language: true },
    });
    const key = (x: {
      engine: string;
      surface: string;
      region: string;
      language: string;
      queryId: string;
      rank: number;
      url: string;
    }) =>
      `${x.engine}|${x.surface}|${x.region}|${x.language}|${x.queryId}|${x.rank}|${x.url}`;
    const have = new Set(existing.map(key));
    const fresh = drafts.filter((d) => !have.has(key(d)));
    const persisted = await persistSerpObservations(fresh);
    console.log(
      JSON.stringify(
        {
          pilotRun: PILOT_RUN,
          reportRun: REPORT_RUN,
          sourceRows: rows.length,
          draftCandidates: drafts.length,
          skippedExisting: drafts.length - fresh.length,
          persisted: persisted.length,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
