/**
 * Прогон, доехавший до подготовки и упавший на ней, — целиком офлайн.
 *
 * Настоящий тик оркестратора на файловом хранилище: подготовка подставлена
 * через `deps.runPrepare`, входы взяты общим сидом пересборки, обогащение
 * подведено. Пересказывать это в каждом тесте нельзя — состояние живого
 * прогона держится на согласии четырёх артефактов и трёх полей джобы, и
 * фикстура «почти правильной» формы красит зелёным ветку, которой на живом
 * пути не бывает.
 */

import {
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { runUnifiedCollectionTick } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { ARSENKIN_REAL_AGENT_NAMES } from "@/modules/digital-profile/agents/real/real-arsenkin-agents";
import { applyStepOutcome } from "@/modules/digital-profile/workflow/step-plan";
import { outcomeFromJob } from "@/modules/digital-profile/workflow/unified-step-handlers";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import { seedUnifiedRebuildInputs } from "./unified-rebuild-inputs";

/**
 * Обогащение прогона, доехавшего до подготовки.
 *
 * Одна запись на джобе и в артефакте: на живом пути это один и тот же объект,
 * а ворота готовности данных читают джобу и лишь при её молчании — артефакт.
 */
export function enrichmentState(complete: boolean): NonNullable<UnifiedCollectionJob["arsenkinEnrichmentState"]> {
  return {
    scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
    completedAgents: [...ARSENKIN_REAL_AGENT_NAMES],
    pendingAgents: [],
    failedAgents: [],
    ingestedAgents: complete ? [...ARSENKIN_REAL_AGENT_NAMES] : [],
    enrichmentComplete: complete,
  } as unknown as NonNullable<UnifiedCollectionJob["arsenkinEnrichmentState"]>;
}

export const ENRICHMENT_DONE = enrichmentState(true);

/** Кейс с прогоном и всеми входами подготовки на диске. */
export async function seedPreparedRun(caseId: string): Promise<{
  unifiedJobId: string;
  compositeDatasetId: string;
}> {
  const { job } = await findOrCreateUnifiedCollectionJob({ caseId, requestedBy: "unit-0039" });
  const seed = await seedUnifiedRebuildInputs({ caseId, unifiedJobId: job.unifiedJobId });
  await writeUnifiedArtifact(caseId, job.unifiedJobId, "arsenkin-enrichment-state.json", ENRICHMENT_DONE);
  return {
    unifiedJobId: job.unifiedJobId,
    compositeDatasetId: String(seed.compositeDatasetId),
  };
}

/** Один тик подготовки, который падает названным отказом. */
export async function failPrepareWith(input: {
  caseId: string;
  compositeDatasetId: string;
  error: unknown;
  now: Date;
  /** Чем прогон отличается от здорового: чекпоинт, подводка, предупреждения. */
  job?: Partial<UnifiedCollectionJob>;
  /**
   * Отказ прошлой попытки шага: на живом пути его приносит обработчик из строки
   * конвейера, а не джоба — с неё вердикт снимается перед каждым повтором.
   */
  previousStepFailure?: { code?: string | null; message?: string | null } | null;
}): Promise<UnifiedCollectionJob> {
  await patchUnifiedCollectionJob(input.caseId, {
    stage: "ORION_PREPARE",
    status: "RUNNING",
    compositeDatasetId: input.compositeDatasetId,
    baseReportRunId: "base-run",
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    arsenkinEnrichmentState: ENRICHMENT_DONE,
    startedAt: input.now.toISOString(),
    lastError: null,
    lastErrorCode: null,
    ...input.job,
  });
  await runUnifiedCollectionTick(input.caseId, {
    autoSchedule: false,
    now: () => input.now,
    previousStepFailure: input.previousStepFailure ?? null,
    runPrepare: async () => {
      throw input.error;
    },
  });
  const job = await loadUnifiedCollectionJob(input.caseId);
  if (!job) throw new Error("джоба исчезла");
  return job;
}

/**
 * Строки конвейера так, как их оставляет упавший шаг подготовки.
 *
 * Вердикт снимает та же функция, что и воркер (`outcomeFromJob`): пересказ её
 * правил был бы вторым ответом на вопрос «чем отказ обернулся для шага».
 */
export function stepsAfterPrepare(job: UnifiedCollectionJob, now: Date): WorkflowStepRow[] {
  const row = (name: string, position: number): WorkflowStepRow =>
    ({
      id: `s-${name}`,
      caseId: job.caseId,
      jobId: job.jobId,
      name,
      position,
      state: "DONE",
      attempts: 1,
      maxAttempts: 10,
      nextRunAt: null,
      leaseOwner: null,
      leaseUntil: null,
      inputHash: null,
      outputRef: null,
      lastError: null,
      lastErrorCode: null,
      startedAt: null,
    }) as WorkflowStepRow;
  const prepare = row("REPORT_PREPARE", 4);
  const transition = applyStepOutcome(
    { attempts: 0, maxAttempts: 10, name: "REPORT_PREPARE", startedAt: now },
    outcomeFromJob(prepare, null, job, now),
    now
  );
  return [
    row("BASE_COLLECTION", 1),
    row("ARSENKIN_ENRICHMENT", 2),
    row("COMPOSITE_MERGE", 3),
    {
      ...prepare,
      state: transition.state,
      attempts: transition.attempts,
      nextRunAt: transition.nextRunAt,
      lastError: transition.lastError,
      lastErrorCode: transition.lastErrorCode,
    } as WorkflowStepRow,
  ];
}
