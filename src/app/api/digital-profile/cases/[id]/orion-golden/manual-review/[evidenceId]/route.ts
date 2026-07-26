/**
 * GET /api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]
 * POST — submit admin review decision (artifact-backed)
 * R10.10a — fail-closed auth; missing evidence → 404; validation → 400.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  assertCanReviewEvidence,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  getManualReviewItem,
  submitAdminReviewDecision,
} from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";
import {
  isHighImpactManualReviewItem,
  validateAdminReviewDecisionInput,
} from "@/modules/digital-profile/orion-golden/evidence/admin-review-decision-validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; evidenceId: string }> };

const SubmitDecisionSchema = z.object({
  status: z.enum([
    "PENDING",
    "APPROVED",
    "APPROVED_WITH_CAVEAT",
    "APPENDIX_ONLY",
    "EXCLUDED",
    "NEEDS_MORE_SOURCES",
    "WRONG_SUBJECT",
  ]),
  reviewerNote: z.string().optional(),
  approvedClientSummary: z.string().optional(),
  caveatText: z.string().optional(),
  requestedSources: z.array(z.string()).optional(),
  highImpactAcknowledged: z.boolean().optional(),
  overwriteConfirmed: z.boolean().optional(),
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, evidenceId } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");
  const data = getManualReviewItem(id, evidenceId);
  return jsonOk(data);
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, evidenceId } = await ctx.params;
  const user = await requireOrionAdminApiAccess(req, id, "review");
  assertCanReviewEvidence(user);
  const input = SubmitDecisionSchema.parse(await readJsonBody(req));
  const current = getManualReviewItem(id, evidenceId);
  const existingStatus =
    current.adminDecision && "status" in current.adminDecision
      ? current.adminDecision.status
      : "PENDING";
  const highImpact = isHighImpactManualReviewItem({
    riskSignal: current.proposedClassification.riskSignal,
    flags: current.flags,
    title: current.title,
    sourceDomain: current.sourceDomain,
  });
  const validation = validateAdminReviewDecisionInput({
    status: input.status,
    reviewerNote: input.reviewerNote,
    caveatText: input.caveatText,
    requestedSources: input.requestedSources,
    highImpactAcknowledged: input.highImpactAcknowledged,
    isHighImpact: highImpact,
    existingStatus,
    overwriteConfirmed: input.overwriteConfirmed,
  });
  if (!validation.ok) {
    throw new ValidationError(validation.errors.join("; "), {
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }
  const actor = actorOf(user);
  const data = await submitAdminReviewDecision(id, evidenceId, {
    status: input.status,
    reviewerNote: input.reviewerNote,
    approvedClientSummary: input.approvedClientSummary,
    caveatText: input.caveatText,
    requestedSources: input.requestedSources,
    reviewedBy: actor.actorId ?? user.id,
    reviewedAt: new Date().toISOString(),
  });
  return jsonOk(data);
});
