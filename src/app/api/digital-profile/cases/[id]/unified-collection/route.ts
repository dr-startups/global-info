/**
 * /api/digital-profile/cases/[id]/unified-collection
 *   POST — start (idempotent) unified ORION + Arsenkin collection job
 *   GET  — job status
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import {
  getUnifiedCollectionStatus,
  startUnifiedOrionCollection,
  unifiedJobHasPreservedStages,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { withUnifiedRecoveryStatusFields } from "@/modules/digital-profile/services/unified-collection-recovery";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { evaluateUnifiedGptCopyRetryEligibility } from "@/modules/digital-profile/services/unified-gpt-copy-retry";
import { withSuggestionsGapStatus } from "@/modules/digital-profile/services/unified-suggestions-gap";
import { getCanonicalDownloadAvailability } from "@/modules/digital-profile/services/canonical-report-artifacts";
import { enabledArsenkinAgentNames } from "@/modules/digital-profile/agents/real/real-arsenkin-agents";
import {
  NO_AUTO_RESUME,
  autoResumeState,
  recoveryNeedsUser,
  type AutoResumeState,
} from "@/modules/digital-profile/workflow/auto-resume";

/**
 * Состояние «конвейер продолжит сам» по строкам шагов.
 *
 * Недоступность таблицы шагов не должна отнимать у оператора кнопку: без
 * ответа считаем, что автоматического продолжения нет.
 */
async function loadAutoResumeState(jobId: string | null): Promise<AutoResumeState> {
  if (!jobId) return NO_AUTO_RESUME;
  try {
    const { listPipelineSteps } = await import("@/modules/digital-profile/workflow/step-store");
    return autoResumeState(await listPipelineSteps(jobId), new Date());
  } catch {
    return NO_AUTO_RESUME;
  }
}

import {
  fullAuditBlockReason,
  paidRecollectionRequired,
} from "@/modules/digital-profile/services/unified-action-policy";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const actor = actorOf(user);
  const data = await startUnifiedOrionCollection({
    caseId: id,
    requestedBy: actor.actorId ?? user.id,
    arsenkinMode: "full-first36",
    confirmPaidRecollection: body?.confirmPaidRecollection === true,
  });
  return jsonOk(data, 202);
});

async function loadSuggestTasksForGap(
  enrichmentRunId: string | null
): Promise<
  Array<{
    state: string;
    toolName: string | null;
    externalTaskId: string | null;
    errorCode: string | null;
  }> | undefined
> {
  if (!enrichmentRunId) return undefined;
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.providerTask.findMany({
      where: { reportRunId: enrichmentRunId },
      select: {
        state: true,
        toolName: true,
        externalTaskId: true,
        errorCode: true,
      },
      take: 50,
    });
    return rows.map((r) => ({
      state: String(r.state),
      toolName: r.toolName,
      externalTaskId: r.externalTaskId,
      errorCode: r.errorCode,
    }));
  } catch {
    return undefined;
  }
}

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");
  const job = await getUnifiedCollectionStatus(id);
  const recovery = await withUnifiedRecoveryStatusFields(job);
  const suggestionsRunId =
    (job?.enrichmentRunIds ?? []).find((rid) => /suggestions/i.test(rid)) ?? null;
  const suggestTasks = await loadSuggestTasksForGap(suggestionsRunId);
  const suggestionsGap = withSuggestionsGapStatus(job, suggestTasks);
  const preserved = unifiedJobHasPreservedStages(job);
  // Пока конвейер собирается вернуться к шагу сам, звать пользователя нельзя:
  // он не ускорит провайдера, а его нажатие стоит денег (шаг 14).
  const autoResume = await loadAutoResumeState(job?.jobId ?? null);
  const needsUser = recoveryNeedsUser({
    recoveryAllowed: Boolean(recovery.recoveryAllowed),
    autoResume,
  });
  const rebuild = await evaluateUnifiedReportRebuildEligibility({ caseId: id, job });
  const actionState = {
    preserved,
    recoveryAllowed: needsUser,
    recoveryBlockerReason: recovery.recoveryBlockerReason ?? null,
    suggestionsMissingResult: Boolean(suggestionsGap.suggestionsMissingResult),
    // Пересборка на уже собранных данных — бесплатная альтернатива новому
    // сбору, и о ней надо знать до того, как предлагать заплатить.
    rebuildAllowed: Boolean(rebuild.rebuildAllowed),
  };
  const fullAuditBlocked =
    Boolean(job) &&
    (autoResume.pending ||
      Boolean(recovery.recoveryAllowed) ||
      suggestionsGap.suggestionsMissingResult ||
      preserved ||
      job?.status === "RUNNING" ||
      job?.status === "WAITING");
  const downloadArtifacts =
    job &&
    job.status === "COMPLETED" &&
    (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL")
      ? await getCanonicalDownloadAvailability({ caseId: id, jobId: job.unifiedJobId })
      : { pdf: false, pptx: false, contactSheet: false };
  const gptCopyRetry = await evaluateUnifiedGptCopyRetryEligibility({ caseId: id, job });
  return jsonOk({
    job: job
      ? {
          jobId: job.jobId,
          unifiedJobId: job.unifiedJobId,
          stage: job.stage,
          status: job.status,
          progress: job.progress,
          actualProviders: job.actualProviders,
          coverage: job.coverage,
          warnings: job.warnings,
          reportQuality: job.reportQuality ?? null,
          lastError: job.lastError,
          lastErrorCode: job.lastErrorCode,
          baseReportRunId: job.baseReportRunId,
          arsenkinReportRunId: job.arsenkinReportRunId,
          enrichmentRunIds: job.enrichmentRunIds ?? [],
          compositeDatasetId: job.compositeDatasetId,
          reportLinks: job.reportLinks,
          downloadArtifacts,
          artifactPaths: job.artifactPaths,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
          // Состав прогона называет сервер: в кабинете он был записан числом,
          // и при трёх работающих агентах панель показывала «3/5».
          arsenkinPlannedAgents: enabledArsenkinAgentNames(),
          arsenkinEnrichmentState: job.arsenkinEnrichmentState
            ? {
                scheduledAgents: job.arsenkinEnrichmentState.scheduledAgents,
                completedAgents: job.arsenkinEnrichmentState.completedAgents,
                failedAgents: job.arsenkinEnrichmentState.failedAgents,
                pendingAgents: job.arsenkinEnrichmentState.pendingAgents,
                ingestedAgents: job.arsenkinEnrichmentState.ingestedAgents,
                enrichmentObservationCount:
                  job.arsenkinEnrichmentState.enrichmentObservationCount,
                enrichmentComplete: job.arsenkinEnrichmentState.enrichmentComplete,
              }
            : null,
          recoveryAllowed: needsUser,
          recoveryBlockerReason: recovery.recoveryBlockerReason,
          recoveryReason: recovery.recoveryReason,
          // «Продолжится само» — отдельное состояние, а не отказ: пользователю
          // показывается ожидание, а не приглашение вмешаться (шаг 14).
          autoResumePending: autoResume.pending,
          autoResumeAt: autoResume.resumeAt,
          autoResumeStep: autoResume.stepName,
          rebuildAllowed: rebuild.rebuildAllowed,
          rebuildBlockerReason: rebuild.rebuildBlockerReason,
          gptCopyRetryAllowed: gptCopyRetry.gptCopyRetryAllowed,
          gptCopyRetryBlockerReason: gptCopyRetry.gptCopyRetryBlockerReason,
          gptCopyFallbackFragmentCount: gptCopyRetry.fallbackFragmentCount,
          recoveryAudit: job.recoveryAudit ?? null,
          resumeCheckpoint: job.resumeCheckpoint ?? null,
          nextPollAt: job.nextPollAt ?? null,
          pollAttempt: job.pollAttempt ?? 0,
          ...suggestionsGap,
          fullAuditBlocked,
          fullAuditBlockReason: fullAuditBlocked ? fullAuditBlockReason(actionState) : null,
          // Пока прогон работает, вмешиваться не предлагают: кнопка повторного
          // платного сбора выбрасывает уже оплаченную работу (шаг 13, B4).
          paidRecollectionRequired: paidRecollectionRequired(actionState),
        }
      : null,
  });
});
