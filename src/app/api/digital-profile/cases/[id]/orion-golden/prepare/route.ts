/**
 * POST/GET /api/digital-profile/cases/[id]/orion-golden/prepare
 * Runs Golden content-brain (no PDF) so Manual Review can load the queue.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { ForbiddenError } from "@/modules/digital-profile/http/errors";
import {
  assertCanRegenerateClientContent,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  enqueueOrionGoldenPrepare,
  getOrionGoldenPrepareSummary,
} from "@/modules/digital-profile/services/orion-golden-prepare-service";

export const dynamic = "force-dynamic";
/** Content-brain can take several minutes (section GPT). */
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireOrionAdminApiAccess(req, id, "review");
  assertCanRegenerateClientContent(user);

  if (!digitalProfileConfig.orionGoldenEnabled) {
    throw new ForbiddenError("ORION Golden is disabled.");
  }

  const summary = enqueueOrionGoldenPrepare(id);
  return jsonOk(summary, 202);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");
  return jsonOk(getOrionGoldenPrepareSummary(id));
});
