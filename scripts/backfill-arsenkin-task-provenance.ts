/**
 * Dry-run / apply provenance backfill for Arsenkin observations & coverage.
 *
 *   npx tsx scripts/backfill-arsenkin-task-provenance.ts --reportRunId=... [--dry-run]
 *   npx tsx scripts/backfill-arsenkin-task-provenance.ts --reportRunId=... --apply \
 *     --confirm-plan-digest=<sha256> --expect-observations=N --expect-coverage=N
 *
 * Never calls Arsenkin API. Default remains dry-run.
 * Apply is fail-closed: ambiguous always blocks; unmatched blocks unless --allow-unmatched;
 * digest + expected counts required for --apply.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/server/prisma/client";
import {
  classifyBackfillMatch,
  computeBackfillPlanDigest,
  evaluateBackfillApplyGate,
  sortProposedBackfillLinks,
  type AmbiguousBackfill,
  type BackfillTaskCandidate,
  type ProposedBackfillLink,
  type UnmatchedBackfill,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-provenance-backfill-match";

type TaskRow = {
  id: string;
  toolName: string;
  requestJson: unknown;
  reportRunId: string | null;
  state: string;
  responseJson: unknown;
  externalTaskId: string | null;
  completedAt: Date | null;
  createdAt: Date;
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

function regionFromRequest(tool: string, requestJson: unknown): string | null {
  const body = asRecord(requestJson);
  const data = asRecord(body.data);
  const googleFrom = String(data.google_from ?? "").toUpperCase();
  const domain = String(data.google_domain ?? "").toLowerCase();
  if (googleFrom === "AE" || domain.includes(".ae") || /UAE|AE|INTL/i.test(String(data.region ?? ""))) {
    return "UAE";
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

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function toCandidate(task: TaskRow): BackfillTaskCandidate {
  return {
    id: task.id,
    toolName: task.toolName,
    engine: engineFromRequest(task.toolName, task.requestJson),
    region: regionFromRequest(task.toolName, task.requestJson),
    queries: queriesFromRequest(task.requestJson),
    reportRunId: task.reportRunId,
    state: task.state,
    hasResponseJson: task.responseJson != null,
    hasExternalTaskId: Boolean(task.externalTaskId),
  };
}

function withinTimeWindow(task: TaskRow, capturedAt?: Date | null): boolean {
  if (!capturedAt) return true;
  const anchor = (task.completedAt ?? task.createdAt).getTime();
  return Math.abs(capturedAt.getTime() - anchor) <= WINDOW_MS;
}

function parseArgs(argv: string[]) {
  let reportRunId = "";
  let apply = false;
  let dryRun = true;
  let confirmPlanDigest: string | null = null;
  let expectObservations: number | null = null;
  let expectCoverage: number | null = null;
  let allowUnmatched = false;
  for (const a of argv) {
    if (a.startsWith("--reportRunId=")) reportRunId = a.slice("--reportRunId=".length);
    else if (a === "--apply") {
      apply = true;
      dryRun = false;
    } else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--confirm-plan-digest=")) confirmPlanDigest = a.slice("--confirm-plan-digest=".length);
    else if (a.startsWith("--expect-observations=")) {
      expectObservations = Number(a.slice("--expect-observations=".length));
    } else if (a.startsWith("--expect-coverage=")) {
      expectCoverage = Number(a.slice("--expect-coverage=".length));
    } else if (a === "--allow-unmatched") allowUnmatched = true;
  }
  return {
    reportRunId,
    apply,
    dryRun: apply ? false : dryRun,
    confirmPlanDigest,
    expectObservations: Number.isFinite(expectObservations as number) ? expectObservations : null,
    expectCoverage: Number.isFinite(expectCoverage as number) ? expectCoverage : null,
    allowUnmatched,
  };
}

function toolFromSurface(surface: string): string {
  if (surface === "organic") return "check-top";
  if (surface === "autocomplete") return "suggest";
  if (surface === "paa") return "paa";
  if (surface === "ai_answer") return "ai-serp";
  if (surface === "page_meta") return "check-h";
  if (surface === "indexation") return "indexation";
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reportRunId) {
    throw new Error(
      "required: --reportRunId=... (default --dry-run; --apply needs --confirm-plan-digest + --expect-observations + --expect-coverage)"
    );
  }

  const allTasks = await prisma.providerTask.findMany({
    where: { reportRunId: args.reportRunId, provider: "arsenkin" },
  });
  const tasks = allTasks.filter(
    (t) => /^DONE$/i.test(t.state) && t.responseJson != null && Boolean(t.externalTaskId)
  ) as TaskRow[];
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
    eligibleDoneTasks: tasks.length,
    totalTasks: allTasks.length,
  };

  const proposed: ProposedBackfillLink[] = [];
  const ambiguous: AmbiguousBackfill[] = [];
  const unmatched: UnmatchedBackfill[] = [];

  for (const obs of observations) {
    if (obs.providerTaskId) continue;
    const tip = {
      tool: toolFromSurface(obs.surface),
      engine: obs.engine,
      region: /UAE|AE|INTL/i.test(obs.region) ? "UAE" : "RU",
      queryText: obs.queryText,
    };
    if (!tip.tool) {
      unmatched.push({ kind: "observation", id: obs.id, tip, reason: "unknown-surface" });
      continue;
    }
    const windowed = tasks.filter((t) => withinTimeWindow(t, obs.capturedAt));
    const result = classifyBackfillMatch(tip, windowed.map(toCandidate), {
      reportRunId: args.reportRunId,
    });
    if (result.kind === "unique") {
      proposed.push({ kind: "observation", id: obs.id, providerTaskId: result.ids[0]! });
    } else if (result.kind === "ambiguous") {
      ambiguous.push({
        kind: "observation",
        id: obs.id,
        candidateIds: result.ids,
        reason: result.reason,
      });
    } else {
      unmatched.push({ kind: "observation", id: obs.id, tip, reason: result.reason });
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
    const windowed = tasks.filter((t) => withinTimeWindow(t, row.capturedAt));
    const result = classifyBackfillMatch(tip, windowed.map(toCandidate), {
      reportRunId: args.reportRunId,
    });
    if (result.kind === "unique") {
      proposed.push({ kind: "coverage", id: row.id, providerTaskId: result.ids[0]! });
    } else if (result.kind === "ambiguous") {
      ambiguous.push({
        kind: "coverage",
        id: row.id,
        candidateIds: result.ids,
        reason: result.reason,
      });
    } else {
      unmatched.push({ kind: "coverage", id: row.id, tip, reason: result.reason });
    }
  }

  const proposedSorted = sortProposedBackfillLinks(proposed);
  const planDigest = computeBackfillPlanDigest({
    reportRunId: args.reportRunId,
    proposed: proposedSorted,
    ambiguous,
    unmatched,
    allowUnmatched: args.allowUnmatched,
  });

  const gate = evaluateBackfillApplyGate({
    reportRunId: args.reportRunId,
    mode: args.apply ? "apply" : "dry-run",
    proposed: proposedSorted,
    ambiguous,
    unmatched,
    allowUnmatched: args.allowUnmatched,
    confirmPlanDigest: args.confirmPlanDigest,
    expectObservations: args.expectObservations,
    expectCoverage: args.expectCoverage,
    planDigest,
  });

  let updatedObservations = 0;
  let updatedCoverage = 0;
  let after = before;
  let verdict: "PASS" | "FAIL" = "PASS";

  if (args.apply && !gate.ok) {
    verdict = "FAIL";
    const auditFail = {
      reportRunId: args.reportRunId,
      mode: "apply" as const,
      verdict: "FAIL" as const,
      allowUnmatched: args.allowUnmatched,
      planDigest,
      confirmPlanDigest: args.confirmPlanDigest,
      expected: {
        observations: args.expectObservations,
        coverage: args.expectCoverage,
      },
      actual: {
        observations: gate.proposedObservationCount,
        coverage: gate.proposedCoverageCount,
      },
      before,
      proposed: proposedSorted,
      ambiguous,
      unmatched,
      blockers: gate.blockers,
      updated: { observations: 0, coverage: 0 },
      after: before,
      note: "apply blocked before transaction; ambiguous/unmatched never modified",
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
    const outPath = join(outDir, "apply-audit.json");
    writeFileSync(outPath, `${JSON.stringify(auditFail, null, 2)}\n`, "utf-8");
    console.error(JSON.stringify({ ...auditFail, outPath }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.apply) {
    await prisma.$transaction(async (tx) => {
      for (const p of proposedSorted) {
        const task = await tx.providerTask.findUnique({
          where: { id: p.providerTaskId },
          select: {
            id: true,
            reportRunId: true,
            state: true,
            responseJson: true,
            externalTaskId: true,
          },
        });
        if (
          !task ||
          task.reportRunId !== args.reportRunId ||
          !/^DONE$/i.test(task.state) ||
          task.responseJson == null ||
          !task.externalTaskId
        ) {
          throw new Error(`provider-task-ineligible:${p.providerTaskId}`);
        }

        if (p.kind === "observation") {
          const row = await tx.serpObservation.findUnique({
            where: { id: p.id },
            select: { id: true, auditRunId: true, providerTaskId: true },
          });
          if (!row || row.auditRunId !== args.reportRunId) {
            throw new Error(`observation-missing-or-wrong-run:${p.id}`);
          }
          if (row.providerTaskId && row.providerTaskId !== p.providerTaskId) {
            throw new Error(`observation-already-linked:${p.id}->${row.providerTaskId}`);
          }
          const updated = await tx.serpObservation.updateMany({
            where: {
              id: p.id,
              auditRunId: args.reportRunId,
              OR: [{ providerTaskId: null }, { providerTaskId: p.providerTaskId }],
            },
            data: { providerTaskId: p.providerTaskId },
          });
          if (updated.count !== 1) {
            throw new Error(`observation-conditional-update-failed:${p.id}`);
          }
          updatedObservations += 1;
        } else {
          const row = await tx.surfaceCollectionCoverage.findUnique({
            where: { id: p.id },
            select: { id: true, reportRunId: true, providerTaskId: true },
          });
          if (!row || row.reportRunId !== args.reportRunId) {
            throw new Error(`coverage-missing-or-wrong-run:${p.id}`);
          }
          if (row.providerTaskId && row.providerTaskId !== p.providerTaskId) {
            throw new Error(`coverage-already-linked:${p.id}->${row.providerTaskId}`);
          }
          const updated = await tx.surfaceCollectionCoverage.updateMany({
            where: {
              id: p.id,
              reportRunId: args.reportRunId,
              OR: [{ providerTaskId: null }, { providerTaskId: p.providerTaskId }],
            },
            data: { providerTaskId: p.providerTaskId },
          });
          if (updated.count !== 1) {
            throw new Error(`coverage-conditional-update-failed:${p.id}`);
          }
          updatedCoverage += 1;
        }
      }
    });

    const obs2 = await prisma.serpObservation.findMany({
      where: { auditRunId: args.reportRunId, provider: "arsenkin" },
      select: { providerTaskId: true },
    });
    const cov2 = await prisma.surfaceCollectionCoverage.findMany({
      where: { reportRunId: args.reportRunId, provider: "arsenkin" },
      select: { providerTaskId: true },
    });
    after = {
      ...before,
      observationsLinked: obs2.filter((o) => o.providerTaskId).length,
      observationsTotal: obs2.length,
      coverageLinked: cov2.filter((c) => c.providerTaskId).length,
      coverageTotal: cov2.length,
    };

    if (
      updatedObservations !== gate.proposedObservationCount ||
      updatedCoverage !== gate.proposedCoverageCount
    ) {
      verdict = "FAIL";
      process.exitCode = 1;
    } else {
      verdict = "PASS";
    }
  }

  const audit = {
    reportRunId: args.reportRunId,
    mode: args.apply ? "apply" : "dry-run",
    verdict: args.apply ? verdict : ("PASS" as const),
    allowUnmatched: args.allowUnmatched,
    planDigest,
    confirmPlanDigest: args.confirmPlanDigest,
    expected: {
      observations: args.expectObservations,
      coverage: args.expectCoverage,
    },
    actual: {
      observations: gate.proposedObservationCount,
      coverage: gate.proposedCoverageCount,
    },
    before,
    proposed: proposedSorted,
    ambiguous,
    unmatched,
    blockers: gate.blockers,
    updated: { observations: updatedObservations, coverage: updatedCoverage },
    after,
    note:
      "ambiguous always blocks apply; unmatched blocks unless --allow-unmatched; exact normalized query match only",
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
  console.log(JSON.stringify({ ...audit, outPath }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
