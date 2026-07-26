/**
 * Admin Arsenkin Tools UI adapter.
 * Calls executeCanonicalArsenkinStage via arsenkin-ui-orchestration-service.
 * Never spawns CLI. Never returns token/DSN/raw secrets.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  assertCanRegenerateClientContent,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  executeArsenkinUiRun,
  getArsenkinUiStatus,
  parseArsenkinUiStage,
  planArsenkinUiRun,
  prepareArsenkinUiRun,
  refreshArsenkinDbReadinessForUi,
  syncArsenkinResultsToOrion,
  toPublicArsenkinUiDto,
  type ArsenkinUiStage,
} from "@/modules/digital-profile/services/arsenkin-ui-orchestration-service";
import {
  recoverConfirmNotCreated,
  recoverContinueStage1,
  recoverLinkExistingTask,
  recoverReconcileDoneZeroObs,
  recoverRetryUnconfirmedSubmit,
} from "@/modules/digital-profile/services/arsenkin-recovery-orchestration";
import {
  cancelArsenkinFullAudit,
  getArsenkinFullAuditStatus,
  startArsenkinFullAudit,
} from "@/modules/digital-profile/providers/arsenkin/full-audit-orchestrator";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
/** Execute may wait for Arsenkin completion; no fire-and-forget jobs. */
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

type Body = {
  action?: string;
  reportRunId?: string;
  stage?: string;
  confirmPlanDigest?: string;
  confirmed?: boolean;
  forceNewRun?: boolean;
  /** Rejected — budget is server-side only. */
  maxNewTasks?: unknown;
  maxEstimatedLimits?: unknown;
  providerTaskId?: string;
  externalTaskId?: string;
  reason?: string;
  evidenceNote?: string;
};

function assertNoClientBudget(body: Body): void {
  if (body.maxNewTasks !== undefined || body.maxEstimatedLimits !== undefined) {
    throw new ValidationError("Budget задаётся только сервером; клиент не может передать лимиты");
  }
}

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id: caseId } = await ctx.params;
  await requireOrionAdminApiAccess(req, caseId, "view");
  const url = new URL(req.url);
  const reportRunId = url.searchParams.get("reportRunId");
  const stageRaw = url.searchParams.get("stage");
  const stage = stageRaw ? parseArsenkinUiStage(stageRaw) : null;
  const status = await getArsenkinUiStatus(caseId, reportRunId, stage);
  return new NextResponse(JSON.stringify({ ok: true, data: toPublicArsenkinUiDto(status) }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id: caseId } = await ctx.params;
  const user = await requireOrionAdminApiAccess(req, caseId, "review");
  assertCanRegenerateClientContent(user);

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
  assertNoClientBudget(body);

  const action = String(body.action ?? "").trim().toLowerCase();
  if (!action) throw new ValidationError("action required");

  const stage: ArsenkinUiStage = parseArsenkinUiStage(body.stage);
  const reportRunId = String(body.reportRunId ?? "").trim();
  if (!reportRunId && action !== "status" && action !== "refresh-readiness") {
    throw new ValidationError("reportRunId required");
  }

  if (action === "refresh-readiness") {
    const readiness = await refreshArsenkinDbReadinessForUi();
    const stage: ArsenkinUiStage | null = body.stage
      ? parseArsenkinUiStage(body.stage)
      : null;
    const status = await getArsenkinUiStatus(caseId, reportRunId || null, stage);
    return jsonOk({
      ...toPublicArsenkinUiDto(status),
      readinessRefresh: {
        readinessCode: readiness.readinessCode,
        verdict: readiness.verdict,
        blockers: readiness.blockers,
        networkCalls: readiness.networkCalls,
      },
    });
  }

  if (action === "prepare") {
    const status = await prepareArsenkinUiRun({ caseId, reportRunId, stage });
    return jsonOk(toPublicArsenkinUiDto(status));
  }
  if (action === "plan") {
    const plan = await planArsenkinUiRun({ caseId, reportRunId, stage });
    return jsonOk(toPublicArsenkinUiDto(plan));
  }
  if (action === "execute") {
    const out = await executeArsenkinUiRun({
      caseId,
      reportRunId,
      stage,
      confirmPlanDigest: String(body.confirmPlanDigest ?? ""),
      confirmed: body.confirmed === true,
    });
    const { result: _result, ...publicStatus } = out;
    return jsonOk(toPublicArsenkinUiDto(publicStatus));
  }
  if (action === "sync") {
    const out = await syncArsenkinResultsToOrion({ caseId, reportRunId, stage });
    const { orphanedEvidenceIds, ...publicStatus } = out;
    return jsonOk({
      ...toPublicArsenkinUiDto(publicStatus),
      orphanedEvidenceIds,
    });
  }

  if (action === "start-full-audit" || action === "full-audit") {
    if (body.confirmed !== true) {
      throw new ValidationError("confirmed=true required");
    }
    // One-click Full is ALWAYS FIRST36_FULL — never derive from UI stage/canary tab/binding.
    const workflow = "first36-full" as const;
    const started = await startArsenkinFullAudit({
      caseId,
      reportRunId,
      workflow,
      requestedWorkflowType: "FIRST36_FULL",
      actorId: user.id,
      confirmed: true,
      forceNewRun: body.forceNewRun === true,
    });
    const status = await getArsenkinUiStatus(caseId, started.jobReportRunId, "FIRST36_STAGE1");
    return new NextResponse(
      JSON.stringify({
        ok: true,
        data: {
          ...toPublicArsenkinUiDto(status),
          ...started,
          orchestration: getArsenkinFullAuditStatus(caseId, workflow),
        },
      }),
      {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  }

  if (action === "cancel-full-audit") {
    // Cancel the Full First36 job (not canary).
    const workflow = "first36-full" as const;
    const job = await cancelArsenkinFullAudit({
      caseId,
      workflow,
      actorId: user.id,
    });
    const status = await getArsenkinUiStatus(caseId, reportRunId || null, "FIRST36_STAGE1");
    return jsonOk({
      ...toPublicArsenkinUiDto(status),
      cancelled: true,
      orchestration: job,
    });
  }

  if (action === "recover-link-existing") {
    const providerTaskId = String(body.providerTaskId ?? "").trim();
    const externalTaskId = String(body.externalTaskId ?? "").trim();
    if (!providerTaskId || !externalTaskId) {
      throw new ValidationError("providerTaskId and externalTaskId required");
    }
    const out = await recoverLinkExistingTask({
      caseId,
      reportRunId,
      stage,
      providerTaskId,
      externalTaskId,
      actorId: user.id,
      evidenceNote: body.evidenceNote ? String(body.evidenceNote) : undefined,
    });
    return jsonOk(out);
  }

  if (action === "recover-confirm-not-created") {
    const providerTaskId = String(body.providerTaskId ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!providerTaskId || !reason) {
      throw new ValidationError("providerTaskId and reason required");
    }
    const out = await recoverConfirmNotCreated({
      caseId,
      reportRunId,
      stage,
      providerTaskId,
      actorId: user.id,
      reason,
      evidenceNote: body.evidenceNote ? String(body.evidenceNote) : undefined,
    });
    return jsonOk(out);
  }

  if (action === "recover-retry-unconfirmed") {
    const providerTaskId = String(body.providerTaskId ?? "").trim();
    if (!providerTaskId) throw new ValidationError("providerTaskId required");
    const out = await recoverRetryUnconfirmedSubmit({
      caseId,
      reportRunId,
      stage,
      providerTaskId,
      actorId: user.id,
    });
    return jsonOk(out);
  }

  if (action === "recover-reconcile-done") {
    const out = await recoverReconcileDoneZeroObs({
      caseId,
      reportRunId,
      stage,
      actorId: user.id,
    });
    return jsonOk(out);
  }

  if (action === "recover-continue-stage1") {
    const confirmPlanDigest = String(body.confirmPlanDigest ?? "").trim();
    if (!confirmPlanDigest) throw new ValidationError("confirmPlanDigest required");
    if (body.confirmed !== true) throw new ValidationError("confirmed=true required");
    const out = await recoverContinueStage1({
      caseId,
      reportRunId,
      stage,
      actorId: user.id,
      confirmPlanDigest,
    });
    return jsonOk(out);
  }

  throw new ValidationError(`Unknown action: ${action}`);
});
