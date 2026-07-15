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
  /** Rejected — budget is server-side only. */
  maxNewTasks?: unknown;
  maxEstimatedLimits?: unknown;
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
  return jsonOk(toPublicArsenkinUiDto(status));
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

  throw new ValidationError(`Unknown action: ${action}`);
});
