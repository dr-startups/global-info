/**
 * POST /api/digital-profile/cases/[id]/unified-collection/retry-enrichment-task
 * Targeted paid retry for a single missing Arsenkin enrichment CaseAgent
 * (SUGGESTIONS). Requires confirmPaidEnrichmentRetry=true.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { retryUnifiedEnrichmentSuggestionsTask } from "@/modules/digital-profile/services/unified-enrichment-targeted-retry";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId ?? "").trim();
  const enrichmentRunId = String(body.enrichmentRunId ?? "").trim();
  const agentName = String(body.agentName ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");
  if (!enrichmentRunId) throw new ValidationError("enrichmentRunId is required");
  if (!agentName) throw new ValidationError("agentName is required");

  const actor = actorOf(user);
  const data = await retryUnifiedEnrichmentSuggestionsTask({
    caseId: id,
    jobId,
    enrichmentRunId,
    agentName,
    expectedTaskFingerprint:
      body.expectedTaskFingerprint != null ? String(body.expectedTaskFingerprint) : null,
    confirmPaidEnrichmentRetry: body.confirmPaidEnrichmentRetry === true,
    actorId: actor.actorId ?? user.id,
  });
  return jsonOk(data, 202);
});
