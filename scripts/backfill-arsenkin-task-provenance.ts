/**
 * Dry-run / apply provenance backfill for Arsenkin observations & coverage.
 *
 *   npx tsx scripts/backfill-arsenkin-task-provenance.ts --reportRunId=... [--dry-run]
 *   npx tsx scripts/backfill-arsenkin-task-provenance.ts --reportRunId=... --apply
 *
 * Never calls Arsenkin API. Ambiguous/unmatched rows are left untouched.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/server/prisma/client";

type TaskRow = {
  id: string;
  toolName: string;
  requestJson: unknown;
  reportRunId: string | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function engineFromRequest(tool: string, requestJson: unknown): string | null {
  const body = asRecord(requestJson);
  const data = asRecord(body.data);
  const se = Number(data.se ?? body.se);
  if (tool === "suggest" || tool === "check-top" || tool === "ai-serp") {
    if (se === 1) return "YANDEX";
    if (se === 2) return "GOOGLE";
  }
  if (tool === "paa") return "GOOGLE";
  return null;
}

function regionFromRequest(tool: string, requestJson: unknown, language?: string): string | null {
  const body = asRecord(requestJson);
  const data = asRecord(body.data);
  const googleFrom = String(data.google_from ?? "").toUpperCase();
  const domain = String(data.google_domain ?? "").toLowerCase();
  if (googleFrom === "AE" || domain.includes(".ae") || /UAE|AE|INTL/i.test(String(data.region ?? ""))) {
    return "UAE";
  }
  if (language === "en" && (tool === "suggest" || tool === "paa") && googleFrom) {
    return googleFrom === "AE" ? "UAE" : "RU";
  }
  return "RU";
}

function queriesFromRequest(requestJson: unknown): string[] {
  const body = asRecord(requestJson);
  const data = asRecord(body.data);
  const q = data.queries ?? body.queries;
  if (Array.isArray(q)) return q.map((x) => String(x));
  return [];
}

function parseArgs(argv: string[]) {
  let reportRunId = "";
  let apply = false;
  let dryRun = true;
  for (const a of argv) {
    if (a.startsWith("--reportRunId=")) reportRunId = a.slice("--reportRunId=".length);
    else if (a === "--apply") {
      apply = true;
      dryRun = false;
    } else if (a === "--dry-run") dryRun = true;
  }
  return { reportRunId, apply, dryRun: apply ? false : dryRun };
}

function matchCandidates(
  tasks: TaskRow[],
  tip: { tool: string; engine: string; region: string; queryText?: string }
): TaskRow[] {
  return tasks.filter((task) => {
    if (task.toolName !== tip.tool) return false;
    const engine = engineFromRequest(task.toolName, task.requestJson);
    const region = regionFromRequest(task.toolName, task.requestJson);
    if (engine && engine !== tip.engine.toUpperCase()) return false;
    if (region && region !== tip.region.toUpperCase() && !(tip.region === "UAE" && region === "UAE")) {
      // allow loose RU default
      if (!(tip.region.toUpperCase() === "RU" && region === "RU")) return false;
    }
    if (tip.queryText) {
      const queries = queriesFromRequest(task.requestJson);
      if (queries.length && !queries.some((q) => q === tip.queryText || q.includes(tip.queryText!))) {
        return false;
      }
    }
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reportRunId) {
    throw new Error("required: --reportRunId=... (default --dry-run; use --apply to write)");
  }

  const tasks = await prisma.providerTask.findMany({
    where: { reportRunId: args.reportRunId, provider: "arsenkin" },
  });
  const observations = await prisma.serpObservation.findMany({
    where: { auditRunId: args.reportRunId, provider: "arsenkin" },
  });
  const coverage = await prisma.surfaceCollectionCoverage.findMany({
    where: { reportRunId: args.reportRunId, provider: "arsenkin" },
  });

  const before = {
    observationsLinked: observations.filter((o) => o.providerTaskId).length,
    observationsTotal: observations.length,
    coverageLinked: coverage.filter((c) => c.providerTaskId).length,
    coverageTotal: coverage.length,
  };

  const proposed: Array<{ kind: "observation" | "coverage"; id: string; providerTaskId: string }> = [];
  const ambiguous: Array<{ kind: string; id: string; candidateIds: string[] }> = [];
  const unmatched: Array<{ kind: string; id: string; tip: unknown }> = [];

  for (const obs of observations) {
    if (obs.providerTaskId) continue;
    const tip = {
      tool:
        obs.surface === "organic"
          ? "check-top"
          : obs.surface === "autocomplete"
            ? "suggest"
            : obs.surface === "paa"
              ? "paa"
              : obs.surface === "ai_answer"
                ? "ai-serp"
                : obs.surface === "page_meta"
                  ? "check-h"
                  : obs.surface === "indexation"
                    ? "indexation"
                    : "",
      engine: obs.engine,
      region: /UAE|AE|INTL/i.test(obs.region) ? "UAE" : "RU",
      queryText: obs.queryText,
    };
    if (!tip.tool) {
      unmatched.push({ kind: "observation", id: obs.id, tip });
      continue;
    }
    const cands = matchCandidates(tasks, tip);
    if (cands.length === 1) {
      proposed.push({ kind: "observation", id: obs.id, providerTaskId: cands[0]!.id });
    } else if (cands.length > 1) {
      ambiguous.push({ kind: "observation", id: obs.id, candidateIds: cands.map((c) => c.id) });
    } else {
      unmatched.push({ kind: "observation", id: obs.id, tip });
    }
  }

  for (const row of coverage) {
    if (row.providerTaskId) continue;
    const tip = {
      tool: row.tool,
      engine: row.engine,
      region: /UAE|AE|INTL/i.test(row.region) ? "UAE" : "RU",
      queryText: row.queryText,
    };
    const cands = matchCandidates(tasks, tip);
    if (cands.length === 1) {
      proposed.push({ kind: "coverage", id: row.id, providerTaskId: cands[0]!.id });
    } else if (cands.length > 1) {
      ambiguous.push({ kind: "coverage", id: row.id, candidateIds: cands.map((c) => c.id) });
    } else {
      unmatched.push({ kind: "coverage", id: row.id, tip });
    }
  }

  let after = before;
  if (args.apply) {
    for (const p of proposed) {
      if (p.kind === "observation") {
        await prisma.serpObservation.update({
          where: { id: p.id },
          data: { providerTaskId: p.providerTaskId },
        });
      } else {
        await prisma.surfaceCollectionCoverage.update({
          where: { id: p.id },
          data: { providerTaskId: p.providerTaskId },
        });
      }
    }
    const obs2 = await prisma.serpObservation.findMany({
      where: { auditRunId: args.reportRunId, provider: "arsenkin" },
      select: { providerTaskId: true },
    });
    const cov2 = await prisma.surfaceCollectionCoverage.findMany({
      where: { reportRunId: args.reportRunId, provider: "arsenkin" },
      select: { providerTaskId: true },
    });
    after = {
      observationsLinked: obs2.filter((o) => o.providerTaskId).length,
      observationsTotal: obs2.length,
      coverageLinked: cov2.filter((c) => c.providerTaskId).length,
      coverageTotal: cov2.length,
    };
  }

  const audit = {
    reportRunId: args.reportRunId,
    mode: args.apply ? "apply" : "dry-run",
    before,
    proposed,
    ambiguous,
    unmatched,
    after,
  };
  const outDir = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    "provenance-backfill",
    args.reportRunId
  );
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, args.apply ? "apply-audit.json" : "dry-run-audit.json");
  writeFileSync(outPath, `${JSON.stringify(audit, null, 2)}\n`, "utf-8");
  console.log(JSON.stringify({ ...audit, outPath, proposedCount: proposed.length }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
