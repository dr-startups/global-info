/**
 * Лёгкий прогон проверки с сайта: запуск, ход и запись вердикта.
 *
 * Прогон ведёт конвейер дела, и своего ответа на «где прогон» здесь нет: ход
 * читается из джобы и шагов. Запись проверки хранит то, что увидит посетитель, —
 * статус и результат. Результат живёт в записи, а не в джобе: полный прогон из
 * админки заменяет строку джобы дела, и результат пропал бы вместе с ней.
 */

import type { Prisma, PrismaClient, SelfCheck } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { ConflictError } from "@/modules/digital-profile/http/errors";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import type {
  BaseCollectionManifest,
  UnifiedCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-types";
import { failedStepWillRetry, stepMaxWaitMs } from "@/modules/digital-profile/workflow/step-plan";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import { selfCheckActor } from "./actor";
import { selfCheckPollMs } from "./public-dto";
import { lightVerdict, type LightVerdictInput } from "./verdict";

export type LightRunDb = Pick<PrismaClient, "selfCheck" | "auditLog">;

export type LightRunJob = Pick<
  UnifiedCollectionJob,
  "unifiedJobId" | "stage" | "status" | "progress" | "mode" | "cancelRequested"
>;

export type LightRunStep = Pick<WorkflowStepRow, "state" | "nextRunAt" | "attempts" | "maxAttempts">;

export type LightRunView =
  | { kind: "running"; stage: "collecting" | "verdict"; progress: number }
  | { kind: "failed"; reason: "RUN_FAILED" | "RUN_TIMEOUT" };

export interface LightRunDeps {
  db?: LightRunDb;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  startRun?: (input: {
    caseId: string;
    requestedBy: string;
    mode: "light";
  }) => Promise<{ unifiedJobId: string }>;
  loadJob?: (caseId: string) => Promise<LightRunJob | null>;
  listSteps?: (jobId: string) => Promise<LightRunStep[]>;
  loadVerdictInput?: (job: UnifiedCollectionJob) => Promise<LightVerdictInput>;
}

/**
 * Сколько посетитель ждёт результата, прежде чем прочтёт «не удалось».
 *
 * Число — из реестра шагов: столько базовому сбору разрешено ждать, и второго
 * предела рядом нет. Вердикт, пришедший позже, всё равно записывается.
 */
export const LIGHT_RUN_VISITOR_WAIT_MS = stepMaxWaitMs("BASE_COLLECTION");

function resolve(deps: LightRunDeps) {
  return {
    db: deps.db ?? (prisma as unknown as LightRunDb),
    now: deps.now ?? (() => new Date()),
    env: deps.env ?? process.env,
  };
}

const auditClient = (db: LightRunDb) => db as unknown as Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

async function startLightCollection(input: {
  caseId: string;
  requestedBy: string;
  mode: "light";
}): Promise<{ unifiedJobId: string }> {
  // Лениво: оркестратор сам грузит этот модуль для шага вердикта.
  const { startUnifiedOrionCollection } = await import(
    "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
  );
  const started = await startUnifiedOrionCollection(input);
  return { unifiedJobId: started.unifiedJobId };
}

export async function startSelfCheckRun(
  check: SelfCheck,
  ctx: { ip: string },
  deps: LightRunDeps = {}
): Promise<{ status: "RUNNING"; nextPollMs: number }> {
  const d = resolve(deps);
  if (check.honeypotTripped || check.status === "BLOCKED" || !check.caseId) {
    throw new ConflictError("self-check is blocked", { reason: "SELF_CHECK_BLOCKED" });
  }
  if (check.status === "CREATED" || check.status === "PERSONA_PENDING") {
    throw new ConflictError("persona is not confirmed yet", { reason: "PERSONA_NOT_CONFIRMED" });
  }
  const alreadyStarted = () =>
    new ConflictError("light run is already started", { reason: "RUN_ALREADY_STARTED" });
  if (check.status !== "PERSONA_DECIDED") throw alreadyStarted();

  // Захват — условное обновление, а не проверка статуса: второе нажатие
  // «Проверить» между проверкой и стартом оплатило бы второй прогон.
  const startedAt = d.now();
  const claimed = await d.db.selfCheck.updateMany({
    where: { id: check.id, status: "PERSONA_DECIDED" },
    data: { status: "RUNNING", runStartedAt: startedAt, blockedReason: null },
  });
  if (claimed.count !== 1) throw alreadyStarted();

  let unifiedJobId: string;
  try {
    ({ unifiedJobId } = await (deps.startRun ?? startLightCollection)({
      caseId: check.caseId,
      requestedBy: selfCheckActor(check.id),
      mode: "light",
    }));
  } catch (err) {
    // Прогона нет — запись возвращается к решению. Иначе посетитель ждал бы
    // прогон, которого не существует, до предела ожидания.
    await d.db.selfCheck.updateMany({
      where: { id: check.id, status: "RUNNING" },
      data: { status: "PERSONA_DECIDED", runStartedAt: null },
    });
    throw err;
  }

  await d.db.selfCheck.updateMany({ where: { id: check.id }, data: { jobId: unifiedJobId } });
  await recordAudit(
    {
      caseId: check.caseId,
      action: "SELF_CHECK_RUN_STARTED",
      actorId: selfCheckActor(check.id),
      ipAddress: ctx.ip,
      metadata: { jobId: unifiedJobId },
    },
    auditClient(d.db)
  );
  return { status: "RUNNING", nextPollMs: selfCheckPollMs(d.env) };
}

// ---------------------------------------------------------------------------
// Ход прогона
// ---------------------------------------------------------------------------

/**
 * Где прогон посетителя — по джобе, шагам и времени.
 *
 * Стадий две (решение владельца 15.09.2026): третьей данные джобы не различают,
 * базовый сбор идёт одним тиком.
 */
export function lightRunState(input: {
  runStartedAt: Date | null;
  jobId: string | null;
  job: LightRunJob | null;
  steps: readonly LightRunStep[];
  now: Date;
}): LightRunView {
  const { job } = input;
  // Строку джобы дела заменил другой прогон — полный из админки: этот не закончится.
  if (job && input.jobId && job.unifiedJobId !== input.jobId) return { kind: "failed", reason: "RUN_FAILED" };
  if (job && (job.stage === "FAILED_TERMINAL" || job.stage === "CANCELLED")) {
    return { kind: "failed", reason: "RUN_FAILED" };
  }
  // Шаг, который больше не проснётся, — тот же конец, что терминальная стадия.
  if (input.steps.some((s) => s.state === "FAILED" && !failedStepWillRetry(s))) {
    return { kind: "failed", reason: "RUN_FAILED" };
  }
  if (
    input.runStartedAt &&
    input.now.getTime() - input.runStartedAt.getTime() > LIGHT_RUN_VISITOR_WAIT_MS
  ) {
    return { kind: "failed", reason: "RUN_TIMEOUT" };
  }
  const verdict = job?.stage === "LIGHT_VERDICT" || job?.stage === "LIGHT_READY";
  return { kind: "running", stage: verdict ? "verdict" : "collecting", progress: job?.progress ?? 0 };
}

async function loadJobOfCase(caseId: string): Promise<LightRunJob | null> {
  const { loadUnifiedCollectionJob } = await import(
    "@/modules/digital-profile/services/unified-collection-job-store"
  );
  return loadUnifiedCollectionJob(caseId);
}

async function listStepsOfJob(jobId: string): Promise<LightRunStep[]> {
  const { listPipelineSteps } = await import("@/modules/digital-profile/workflow/step-store");
  return listPipelineSteps(jobId);
}

/**
 * Ход прогона для чтения статуса. Упавший прогон становится записью `FAILED`
 * здесь — условно, из `RUNNING`: вердикт, успевший прийти, не затирается.
 */
export async function reconcileSelfCheckRun(
  check: SelfCheck,
  deps: LightRunDeps = {}
): Promise<{ check: SelfCheck; run: LightRunView | null }> {
  if (check.status !== "RUNNING" || !check.caseId) return { check, run: null };
  const d = resolve(deps);
  const job = await (deps.loadJob ?? loadJobOfCase)(check.caseId);
  const steps = job ? await (deps.listSteps ?? listStepsOfJob)(job.unifiedJobId) : [];
  const now = d.now();
  const view = lightRunState({ runStartedAt: check.runStartedAt, jobId: check.jobId, job, steps, now });
  if (view.kind === "running") return { check, run: view };
  await d.db.selfCheck.updateMany({
    where: { id: check.id, status: "RUNNING" },
    data: { status: "FAILED", blockedReason: view.reason, runFinishedAt: now },
  });
  const fresh = await d.db.selfCheck.findUnique({ where: { id: check.id } });
  return { check: fresh ?? check, run: null };
}

// ---------------------------------------------------------------------------
// Вердикт
// ---------------------------------------------------------------------------

/**
 * Материалы вердикта — живым путём подготовки отчёта: наблюдения слияния по
 * манифесту базового сбора (без обогащения), совпадения комплаенса, проверки
 * Википедии. Демо-строки туда не попадают, как и в отчёт.
 *
 * Субъект — тем же порядком, что у шага слияния полного конвейера: профиль дела
 * (у проверки с сайта его пишет создание проверки), иначе сборка из дела и
 * собранных наблюдений. Без субъекта вердикт не выносится: судить, о ком
 * материал, было бы не по чему, а «всё чужое» дало бы ложное «чисто».
 */
export async function loadLightVerdictInput(job: UnifiedCollectionJob): Promise<LightVerdictInput> {
  const [store, merge, prepare, compliance, supplement, profiles, bootstrap, classifier] = await Promise.all([
    import("@/modules/digital-profile/services/unified-collection-job-store"),
    import("@/modules/digital-profile/services/composite-serp-merge"),
    import("@/modules/digital-profile/services/canonical-report-prepare"),
    import("@/modules/digital-profile/services/compliance-inventory-adapter"),
    import("@/modules/digital-profile/services/evidence-supplement-adapter"),
    import("@/modules/digital-profile/services/job-subject-profile"),
    import("@/modules/digital-profile/services/job-subject-profile-bootstrap"),
    import("@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier"),
  ]);
  const manifest = await store.readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  if (!manifest) throw new Error("base-collection-manifest is missing for the light verdict");
  const reportRunId = job.baseReportRunId ?? `${job.caseId}-base`;
  const merged = await merge.mergeCompositeSerp({
    prisma,
    manifest,
    enrichmentRunIds: [],
    arsenkinObservations: [],
  });
  const serpItems = prepare.compositeObservationsToInventory({
    caseId: job.caseId,
    baseReportRunId: reportRunId,
    enrichmentRunId: null,
    observations: merged.observations,
  });
  const complianceItems = await compliance.resolveComplianceInventoryItems({
    caseId: job.caseId,
    reportRunId,
    prisma: { databaseProfile: prisma.databaseProfile } as never,
  });
  const wikipediaRows = await supplement.loadWikipediaChecksFromPrisma({
    prisma: { wikipediaCheck: prisma.wikipediaCheck } as never,
    caseId: job.caseId,
  });
  const wikipediaItems = supplement.adaptWikipediaChecksToInventory({
    rows: wikipediaRows,
    caseId: job.caseId,
    reportRunId,
  });
  const screenings = await compliance.resolveComplianceScreenings({
    caseId: job.caseId,
    prisma: { complianceScreeningRun: prisma.complianceScreeningRun } as never,
  });
  const profile =
    (await profiles.resolveJobSubjectProfile({ caseId: job.caseId })) ??
    (
      await bootstrap.bootstrapSubjectProfileFromCollection({
        caseId: job.caseId,
        baseReportRunId: reportRunId,
        enrichmentRunId: null,
        observations: merged.observations,
        prisma,
      })
    )?.profile;
  if (!profile) throw new Error("SUBJECT_PROFILE_MISSING: no subject profile for the light verdict");
  return {
    items: [...serpItems, ...complianceItems, ...wikipediaItems],
    providers: job.actualProviders,
    screenings,
    subject: classifier.subjectIdentityFromProfile(profile),
  };
}

/**
 * Поздний вердикт после превышения ожидания записывается: результат лучше
 * отказа. Прогон, признанный упавшим по другой причине, не переписывается.
 */
function acceptsVerdict(check: Pick<SelfCheck, "status" | "blockedReason">): boolean {
  return check.status === "RUNNING" || (check.status === "FAILED" && check.blockedReason === "RUN_TIMEOUT");
}

export async function recordLightVerdict(job: UnifiedCollectionJob, deps: LightRunDeps = {}): Promise<void> {
  const d = resolve(deps);
  const verdict = lightVerdict(await (deps.loadVerdictInput ?? loadLightVerdictInput)(job));
  const now = d.now();
  const check = await d.db.selfCheck.findUnique({ where: { caseId: job.caseId } });
  if (check && acceptsVerdict(check)) {
    await d.db.selfCheck.updateMany({
      where: { id: check.id, status: check.status, blockedReason: check.blockedReason },
      data: {
        status: "DONE",
        blockedReason: null,
        verdict: verdict.verdict,
        riskLevel: verdict.riskLevel,
        materialsFound: verdict.materialsFound,
        findingsTotal: verdict.findingsTotal,
        themesJson: verdict.themes as unknown as Prisma.InputJsonValue,
        sourcesJson: verdict.sourcesChecked as unknown as Prisma.InputJsonValue,
        partial: verdict.partial,
        verdictAt: now,
        verdictSource: verdict.source,
        runFinishedAt: now,
      },
    });
  }
  // Аудит — всегда и без материалов: журнал обезличиванием не чистится.
  await recordAudit(
    {
      caseId: job.caseId,
      action: "SELF_CHECK_VERDICT",
      actorId: job.requestedBy,
      metadata: {
        verdict: verdict.verdict,
        riskLevel: verdict.riskLevel,
        materialsFound: verdict.materialsFound,
        findingsTotal: verdict.findingsTotal,
        partial: verdict.partial,
        jobId: job.unifiedJobId,
      },
    },
    auditClient(d.db)
  );
}
