import { describe, expect, it } from "vitest";
import {
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "../../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { ARSENKIN_REAL_AGENT_NAMES } from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { UnifiedCollectionJob } from "../../src/modules/digital-profile/services/unified-collection-types";

/**
 * Шаг 08.0-bis плана (docs/rework/08-durable-orchestration.md).
 *
 * Проверяется поведение самого тика: рестарт, пришедшийся между регистрацией
 * агентов и отправкой их задач, не должен оставлять джобу опрашивать пустоту.
 */

const CASE = "case-resume";
const JOB = "job-resume";
const runId = (agent: string) => `unified-${JOB}-${agent}`;
const ALL_RUN_IDS = ARSENKIN_REAL_AGENT_NAMES.map(runId);

function job(over: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  const now = new Date().toISOString();
  return {
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB,
    unifiedJobId: JOB,
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.55,
    versionNum: 1,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    requestedBy: "test",
    arsenkinMode: "full-first36",
    baseReportRunId: "base-run-1",
    arsenkinReportRunId: ALL_RUN_IDS[0]!,
    enrichmentRunIds: [...ALL_RUN_IDS],
    arsenkinEnrichmentState: null,
    compositeDatasetId: null,
    actualProviders: [],
    coverage: null,
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    nextPollAt: now,
    pollAttempt: 0,
    ...over,
  } as UnifiedCollectionJob;
}

/** Задачи есть только у check-top — ровно наблюдавшееся состояние. */
const CHECK_TOP_ONLY: EnrichmentPollTaskSnap[] = [
  {
    id: "pt-1",
    reportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"),
    externalTaskId: "ext-1",
    toolName: "check-top",
    state: "RUNNING",
  },
  {
    id: "pt-2",
    reportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"),
    externalTaskId: "ext-2",
    toolName: "check-top",
    state: "RUNNING",
  },
];

describe("возобновление импорта после рестарта", () => {
  it("отправляет задачи агентов, у которых их нет, вместо опроса пустоты", async () => {
    const submitted: string[][] = [];

    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => CHECK_TOP_ONLY,
      pollTask: async (t) => t,
      scheduleIfMissing: async (agents) => {
        submitted.push([...agents]);
        return {
          enrichmentRunIds: [...ALL_RUN_IDS],
          arsenkinReportRunId: ALL_RUN_IDS[0]!,
          warnings: agents.map((a) => `arsenkin-scheduled:${a}`),
        };
      },
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual([
      "ARSENKIN_SUGGESTIONS_REAL",
      "ARSENKIN_PAA_REAL",
      "ARSENKIN_AI_SEARCH_REAL",
      "ARSENKIN_URL_AUDIT_REAL",
    ]);
    // Уже отправленный агент не отправляется повторно — это платный вызов.
    expect(submitted[0]).not.toContain("ARSENKIN_SEARCH_TOP_REAL");
    expect(result.waiting).toBe(true);
    expect(result.blockPipeline).toBe(false);
    expect(result.warnings).toContain(
      "arsenkin-registered-without-task:ARSENKIN_SUGGESTIONS_REAL,ARSENKIN_PAA_REAL,ARSENKIN_AI_SEARCH_REAL,ARSENKIN_URL_AUDIT_REAL"
    );
  });

  it("когда у всех агентов есть задачи, отправка не вызывается вовсе", async () => {
    let called = 0;
    const tasks: EnrichmentPollTaskSnap[] = ARSENKIN_REAL_AGENT_NAMES.map((a, i) => ({
      id: `pt-${i}`,
      reportRunId: runId(a),
      externalTaskId: `ext-${i}`,
      toolName: null,
      state: "RUNNING",
    }));

    await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
      scheduleIfMissing: async (agents) => {
        called += 1;
        return {
          enrichmentRunIds: [...ALL_RUN_IDS],
          arsenkinReportRunId: null,
          warnings: agents.map(String),
        };
      },
    });

    expect(called).toBe(0);
  });

  it("без возможности отправить и без единой задачи — честный отказ, а не опрос по кругу", async () => {
    // Прежде этот путь возвращал waiting, и джоба жгла бюджет в сорок попыток,
    // после чего падала с ARSENKIN_POLL_ATTEMPTS_EXCEEDED — диагнозом, который
    // называл симптом, а не причину.
    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => [],
      pollTask: async (t) => t,
    });

    expect(result.waiting).toBe(false);
    expect(result.blockPipeline).toBe(true);
    expect(result.blockCode).toBe("ARSENKIN_NO_TASKS_TO_POLL");
    expect(result.blockMessage).toContain("ARSENKIN_SUGGESTIONS_REAL");
  });

  it("незарегистрированные агенты по-прежнему дают ARSENKIN_STAGE_NOT_STARTED", async () => {
    const result = await runDurableArsenkinEnrichmentTick({
      job: job({ enrichmentRunIds: [] }),
      listProviderTasks: async () => [],
      pollTask: async (t) => t,
    });

    expect(result.blockCode).toBe("ARSENKIN_STAGE_NOT_STARTED");
  });

  it("частично отправленный набор без возможности отправки уходит на опрос имеющихся", async () => {
    // Отправить некому, но задачи check-top реальны — их надо опросить,
    // а не отбрасывать всю стадию.
    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => CHECK_TOP_ONLY,
      pollTask: async (t) => t,
    });

    expect(result.blockCode).not.toBe("ARSENKIN_NO_TASKS_TO_POLL");
    expect(result.blockCode).not.toBe("ARSENKIN_STAGE_NOT_STARTED");
  });
});
