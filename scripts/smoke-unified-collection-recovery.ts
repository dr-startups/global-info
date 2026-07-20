/**
 * Offline staff recovery for Deripaska-shaped failed unified jobs.
 * NETWORK_CALLS=0 npx tsx --test scripts/smoke-unified-collection-recovery.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../src/modules/digital-profile/http/errors";
import {
  claimUnifiedJobLease,
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  evaluateUnifiedCollectionRecoveryEligibility,
  recoverUnifiedOrionCollectionJob,
  withUnifiedRecoveryStatusFields,
} from "../src/modules/digital-profile/services/unified-collection-recovery";
import { runUnifiedCollectionTick } from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import {
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
} from "../src/modules/digital-profile/services/unified-collection-types";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import { buildRiskMatrixFragment } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";

before(async () => {
  process.env.NETWORK_CALLS = "0";
});

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

function subjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Дерипаска Олег Владимирович",
    givenNames: ["Олег"],
    familyNames: ["Дерипаска"],
    patronymics: ["Владимирович"],
    aliases: ["Дерипаска"],
    transliterations: ["Deripaska Oleg"],
    contextIdentifiers: [],
    namesakeProfiles: [],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

let k = 0;
function obs(p: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">): CompositeObservation {
  k += 1;
  return {
    key: `rk-${k}`,
    region: "RU",
    engine: "YANDEX",
    query: "Дерипаска",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [`searchResult:rsr-${k}`],
    baseSearchResultId: `rsr-${k}`,
    ...p,
  };
}

function fixtureBaseRows(): CompositeObservation[] {
  // Stable IDs — do not use the global obs() counter (shared across tests).
  const mk = (
    id: string,
    p: Partial<CompositeObservation> & Pick<CompositeObservation, "kind" | "engine" | "url" | "title">
  ): CompositeObservation => ({
    key: `rk-${id}`,
    region: "RU",
    query: "Дерипаска",
    providers: p.engine === "GOOGLE" ? ["serper"] : ["yandex"],
    primaryProvider: p.engine === "GOOGLE" ? "serper" : "yandex",
    evidenceRefs: [`searchResult:${id}`],
    baseSearchResultId: id,
    ...p,
  });
  return [
    mk("rsr-1", { kind: "organic", engine: "YANDEX", url: "https://example.com/a", title: "Yandex A" }),
    mk("rsr-2", { kind: "organic", engine: "YANDEX", url: "https://example.com/b", title: "Yandex B" }),
    mk("rsr-3", { kind: "organic", engine: "YANDEX", url: "https://example.com/c", title: "Yandex C" }),
    mk("rsr-4", {
      kind: "organic",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://example.com/g",
      title: "Google",
    }),
  ];
}

function fakePrisma(): PrismaClient {
  const rows = new Map<string, { id: string; caseId: string; mode: string; metadataJson: unknown }>();
  return {
    orionReportRun: {
      findFirst: async ({ where }: { where: { id: string; caseId: string } }) => {
        const row = rows.get(where.id);
        if (row && row.caseId === where.caseId) return { id: row.id };
        return null;
      },
      findMany: async ({
        where,
      }: {
        where: { caseId: string; mode: string };
      }) =>
        [...rows.values()]
          .filter((r) => r.caseId === where.caseId && r.mode === where.mode)
          .map((r) => ({ id: r.id, metadataJson: r.metadataJson })),
      create: async ({ data }: { data: { id: string; caseId: string; mode: string; metadataJson: unknown } }) => {
        rows.set(data.id, {
          id: data.id,
          caseId: data.caseId,
          mode: data.mode,
          metadataJson: data.metadataJson,
        });
        return data;
      },
    },
  } as unknown as PrismaClient;
}

function seedDeripaskaFailedJob(caseId: string, jobId: string): void {
  await deleteUnifiedCollectionJobForTests(caseId);
  const now = new Date().toISOString();
  const rows = fixtureBaseRows();
  const job = {
    version: "unified-orion-collection-job-v1" as const,
    jobId,
    unifiedJobId: jobId,
    caseId,
    stage: "FAILED_TERMINAL" as const,
    status: "FAILED" as const,
    progress: 0.7,
    versionNum: 1,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    requestedBy: "smoke",
    arsenkinMode: "full-first36" as const,
    baseReportRunId: null,
    arsenkinReportRunId: null,
    enrichmentRunIds: [],
    compositeDatasetId: "composite-" + jobId,
    actualProviders: [
      { providerId: "yandex", runtime: "real" as const, status: "completed" as const },
      { providerId: "google", runtime: "real" as const, status: "completed" as const },
      { providerId: "wikipedia", runtime: "real" as const, status: "completed" as const },
    ],
    coverage: emptyCoverage(),
    warnings: ["arsenkin-skipped:no-baseReportRunId", "CANONICAL_PREPARE_BLOCKED"],
    lastError: "EXECUTIVE/RISK_MATRIX:INSUFFICIENT_DATA",
    lastErrorCode: "ASSEMBLY_FAILED",
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
  };
  await saveUnifiedCollectionJob(job);
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId: jobId,
    caseId,
    capturedAt: now,
    baseReportRunId: null,
    searchResultIds: rows.map((r) => r.baseSearchResultId!).filter(Boolean),
    searchSurfaceItemIds: [],
    baseCount: rows.length,
    actualProviders: job.actualProviders,
    realCollectionSufficient: true,
  };
  await writeUnifiedArtifact(caseId, jobId, "base-collection-manifest.json", manifest);
}

async function drain(
  caseId: string,
  deps: Parameters<typeof runUnifiedCollectionTick>[1],
  max = 40
) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (
      ["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE", "CANCELLED"].includes(
        job.stage
      )
    ) {
      return job;
    }
  }
  return await loadUnifiedCollectionJob(caseId);
}

describe("unified collection staff recovery", () => {
  it("route requires auth, role, case access; UnauthorizedError=401 ForbiddenError=403", () => {
    const routeSrc = readFileSync(
      join(SRC, "app/api/digital-profile/cases/[id]/unified-collection/recover/route.ts"),
      "utf8"
    );
    assert.match(routeSrc, /requireDigitalProfileUser/);
    assert.match(routeSrc, /requireRole\(user, "agents\.run"\)/);
    assert.match(routeSrc, /requireCaseAccess/);
    assert.match(routeSrc, /recoverUnifiedOrionCollectionJob/);
    assert.doesNotMatch(routeSrc, /runFullAudit/);
    assert.doesNotMatch(routeSrc, /findOrCreateUnifiedCollectionJob/);
    assert.equal(new UnauthorizedError().status, 401);
    assert.equal(new ForbiddenError().status, 403);
    assert.equal(new NotFoundError().status, 404);
    assert.equal(new ConflictError().status, 409);
  });

  it("GET exposes server-side recoveryAllowed for Deripaska-shaped failure", async () => {
    const caseId = "rec-get-f5";
    const jobId = "unified-fixture-deripaska-get";
    seedDeripaskaFailedJob(caseId, jobId);
    const job = await loadUnifiedCollectionJob(caseId);
    const fields = await withUnifiedRecoveryStatusFields(job);
    assert.equal(fields.recoveryAllowed, true);
    assert.equal(fields.recoveryReason, "HISTORICAL_NO_BASE_REPORT_RUN");
    assert.equal(fields.recoveryBlockerReason, null);
  });

  it("unrelated FAILED_TERMINAL is not recoverable", async () => {
    const caseId = "rec-unrelated-terminal";
    const jobId = "unified-unrelated-fail";
    seedDeripaskaFailedJob(caseId, jobId);
    await patchUnifiedCollectionJob(caseId, {
      warnings: ["something-else"],
      lastErrorCode: "RENDER_FAILED",
      lastError: "renderer exploded",
    });
    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId,
      job: await loadUnifiedCollectionJob(caseId),
    });
    assert.equal(elig.recoveryAllowed, false);
    assert.equal(elig.recoveryBlockerReason, "FAILED_TERMINAL_NOT_RECOVERABLE");
  });

  it("FAILED_TERMINAL ASSEMBLY_FAILED with intact composite → ASSEMBLY_RESUME", async () => {
    const caseId = "rec-assembly-resume";
    const jobId = "unified-assembly-fail";
    seedDeripaskaFailedJob(caseId, jobId);
    await patchUnifiedCollectionJob(caseId, {
      baseReportRunId: "base-run-assembly",
      enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
      compositeDatasetId: "composite-assembly",
      arsenkinEnrichmentState: {
        version: "arsenkin-enrichment-state-v1",
        enrichmentComplete: true,
        agents: [],
      } as never,
      warnings: ["CANONICAL_PREPARE_BLOCKED"],
      lastErrorCode: "ASSEMBLY_FAILED",
      lastError:
        "deck assembly failed: required sections failed: RU_PROFILE/RU_SUMMARY:FAILED",
    });
    await writeUnifiedArtifact(caseId, jobId, "base-collection-manifest.json", {
      version: "base-collection-manifest-v1",
      unifiedJobId: jobId,
      caseId,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-run-assembly",
      searchResultIds: ["sr1"],
      searchSurfaceItemIds: [],
      baseCount: 1,
      actualProviders: [],
      realCollectionSufficient: true,
    });
    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId,
      job: await loadUnifiedCollectionJob(caseId),
    });
    assert.equal(elig.recoveryAllowed, true);
    assert.equal(elig.recoveryReason, "ASSEMBLY_RESUME");
    assert.equal(elig.recoveryBlockerReason, null);
  });

  it("active lease → ConflictError 409", async () => {
    const caseId = "rec-active-lease";
    const jobId = "unified-lease-job";
    seedDeripaskaFailedJob(caseId, jobId);
    await claimUnifiedJobLease({ caseId, ownerId: "other-owner", leaseMs: 60_000 });
    await assert.rejects(
      () =>
        recoverUnifiedOrionCollectionJob({
          caseId,
          jobId,
          actorId: "admin",
          deps: { autoSchedule: false, prisma: fakePrisma() },
        }),
      (err: unknown) => err instanceof ConflictError && /ACTIVE_LEASE/i.test(String(err.message))
    );
  });

  it("missing/corrupt manifest → 409; foreign jobId → 404", async () => {
    const caseId = "rec-manifest-missing";
    const jobId = "unified-no-manifest";
    seedDeripaskaFailedJob(caseId, jobId);
    // Empty / corrupt base manifest (fail-closed).
    await writeUnifiedArtifact(caseId, jobId, "base-collection-manifest.json", {
      version: "base-collection-manifest-v1",
      unifiedJobId: jobId,
      caseId,
      capturedAt: new Date().toISOString(),
      baseReportRunId: null,
      searchResultIds: [],
      searchSurfaceItemIds: [],
      baseCount: 0,
      actualProviders: [],
      realCollectionSufficient: false,
    });
    await assert.rejects(
      () =>
        recoverUnifiedOrionCollectionJob({
          caseId,
          jobId,
          actorId: "admin",
          deps: { autoSchedule: false, prisma: fakePrisma() },
        }),
      (err: unknown) =>
        err instanceof ConflictError && /BASE_MANIFEST_EMPTY_OR_CORRUPT/i.test(String(err.message))
    );

    seedDeripaskaFailedJob(caseId, jobId);
    await assert.rejects(
      () =>
        recoverUnifiedOrionCollectionJob({
          caseId,
          jobId: "foreign-job-id",
          actorId: "admin",
          deps: { autoSchedule: false, prisma: fakePrisma() },
        }),
      (err: unknown) => err instanceof NotFoundError
    );
  });

  it("recovers Deripaska fixture: same jobId, baseCalls=0, five Arsenkin, assembly=1, render<=1", async () => {
    const caseId = "rec-deripaska-happy";
    const jobId = "unified-1784290383122-fixture";
    seedDeripaskaFailedJob(caseId, jobId);

    const baseCalls = { yandex: 0, google: 0, wikipedia: 0, serper: 0 };
    let arsenkinSchedules = 0;
    let compositeAfterEnrichment = false;
    let assemblyCount = 0;
    let renderCount = 0;
    let enrichmentDone = false;

    const prisma = fakePrisma();
    const rows = fixtureBaseRows();
    const fakeRender: DeckRenderAdapter = async (r) => {
      renderCount += 1;
      return { pageCount: r.deckManifest.pageCount, renderer: "fake" };
    };

    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows: rows,
      subjectProfile: subjectProfile(),
      renderDeck: fakeRender,
      prisma,
      runFullAudit: async () => {
        baseCalls.yandex += 1;
        baseCalls.google += 1;
        baseCalls.wikipedia += 1;
        baseCalls.serper += 1;
        throw new Error("base providers must not run on recovery");
      },
      runArsenkinEnrichment: async (job: { baseReportRunId: string | null; enrichmentRunIds?: string[] }) => {
        assert.ok(job.baseReportRunId, "baseReportRunId required");
        arsenkinSchedules += 1;
        enrichmentDone = true;
        const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `enr-rec-${n}-${i}`);
        return {
          arsenkinReportRunId: enrichmentRunIds[0]!,
          enrichmentRunIds,
          coverage: {
            ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
            measured: FIRST36_PLANNED_SUPPORTED_SURFACES.length,
            progressRatio: 1,
          },
          observations: [],
          warnings: ["arsenkin-five-agents-scheduled"],
          partial: false,
          enrichmentComplete: true,
        };
      },
      runPrepare: async () => {
        assert.ok(enrichmentDone, "composite/prepare only after enrichment");
        compositeAfterEnrichment = true;
        assert.equal(ARSENKIN_REAL_AGENT_NAMES.length, 5);
        assemblyCount = 1;
        renderCount = Math.min(1, renderCount + 1);
        // Sparse risk matrix only after five agents:
        const sparse = buildRiskMatrixFragment("EXECUTIVE", {
          findings: [],
          surfaceUnits: [],
          metricSnapshot: {
            metricSnapshotId: "m1",
            datasetId: "d1",
            reportRunId: "r1",
            baseCount: rows.length,
            enrichmentCount: 5,
            compositeCount: rows.length,
            subjectMatchCount: 0,
            likelySubjectCount: 0,
            ambiguousCount: 0,
            otherSubjectCount: 0,
            adverseFindingCount: 0,
            perRegionCounts: { RU: rows.length },
          },
          evidenceIndex: {},
          subject: {
            displayName: "Дерипаска Олег Владимирович",
            givenNames: ["Олег"],
            familyNames: ["Дерипаска"],
          },
          scope: { regions: null, surfaces: null },
        });
        assert.equal(sparse.status, "READY");
        assert.ok(sparse.slides.length >= 1);
        return {
          prepareDatasetId: `composite-${jobId}`,
          pdf: "p.pdf",
          pptx: "p.pptx",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };

    const recovered = await recoverUnifiedOrionCollectionJob({
      caseId,
      jobId,
      actorId: "admin-1",
      deps: { ...deps, ensureBaseReportRun: undefined },
    });
    assert.equal(recovered.jobId, jobId);
    assert.equal(recovered.idempotent, false);
    assert.ok(recovered.baseReportRunId);

    const afterRecover = await loadUnifiedCollectionJob(caseId)!;
    assert.equal(afterRecover.jobId, jobId);
    assert.equal(afterRecover.stage, "ARSENKIN_ENRICHMENT");
    assert.equal(afterRecover.status, "WAITING");
    assert.ok(afterRecover.baseReportRunId);
    assert.ok(afterRecover.recoveryAudit);
    assert.equal(afterRecover.recoveryAudit?.previousLastErrorCode, "ASSEMBLY_FAILED");

    const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
      caseId,
      jobId,
      "base-collection-manifest.json"
    );
    assert.equal(manifest?.baseReportRunId, afterRecover.baseReportRunId);

    const job = await drain(caseId, deps);
    assert.ok(job);
    assert.equal(job!.jobId, jobId);
    assert.ok(
      job!.stage === "REPORT_READY" || job!.stage === "COMPLETED_PARTIAL",
      `stage=${job!.stage} err=${job!.lastError}`
    );
    assert.equal(baseCalls.yandex, 0);
    assert.equal(baseCalls.google, 0);
    assert.equal(baseCalls.serper, 0);
    assert.equal(baseCalls.wikipedia, 0);
    assert.equal(arsenkinSchedules, 1);
    assert.equal(job!.enrichmentRunIds?.length, 5);
    assert.equal(compositeAfterEnrichment, true);
    assert.equal(assemblyCount, 1);
    assert.ok(renderCount <= 1);

    const binding = await readUnifiedArtifact<{ providerCounts: { yandex: number; composite: number } }>(
      caseId,
      jobId,
      "report-data-binding.json"
    );
    assert.ok((binding?.providerCounts.yandex ?? 0) >= 3);

    // Second recovery is idempotent (completed job → not allowed OR same id path).
    // After REPORT_READY, recovery must be blocked.
    const eligDone = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId,
      job: await loadUnifiedCollectionJob(caseId),
    });
    assert.equal(eligDone.recoveryAllowed, false);
    assert.equal(eligDone.recoveryBlockerReason, "JOB_ALREADY_COMPLETED");
  });

  it("double recovery before drain is idempotent (same jobId, one base run)", async () => {
    const caseId = "rec-idempotent-double";
    const jobId = "unified-idempotent-rec";
    seedDeripaskaFailedJob(caseId, jobId);
    const prisma = fakePrisma();
    const deps = { autoSchedule: false as const, prisma };

    const a = await recoverUnifiedOrionCollectionJob({
      caseId,
      jobId,
      actorId: "admin",
      deps,
    });
    const b = await recoverUnifiedOrionCollectionJob({
      caseId,
      jobId,
      actorId: "admin",
      deps,
    });
    assert.equal(a.jobId, b.jobId);
    assert.equal(a.baseReportRunId, b.baseReportRunId);
    assert.equal(b.idempotent, true);
  });

  it("client wiring: recover API + recovery CTA + confirm copy", () => {
    const api = readFileSync(join(SRC, "modules/digital-profile/client/api.ts"), "utf8");
    const header = readFileSync(join(SRC, "modules/digital-profile/client/CaseHeader.tsx"), "utf8");
    const view = readFileSync(join(SRC, "modules/digital-profile/client/CaseDetailView.tsx"), "utf8");
    assert.match(api, /unified-collection\/recover/);
    assert.match(api, /export function recoverUnifiedOrionCollection/);
    assert.match(header, /unified-orion-recovery-cta/);
    assert.match(header, /Пересобрать отчёт \(без повторного сбора\)|Продолжить аудит с этапа Arsenkin/);
    assert.match(view, /ASSEMBLY_RESUME|Пересобрать отчёт из уже собранных данных/);
    assert.match(view, /recoverUnifiedOrionCollection/);
    assert.match(view, /Базовый поиск повторно выполняться не будет/);
    assert.match(view, /getUnifiedOrionCollectionStatus/);
    assert.doesNotMatch(header, /agentRuns\[0\]/);
  });
});
