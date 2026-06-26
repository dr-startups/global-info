/**
 * /api/digital-profile/search-results/[id]/classification
 *   PATCH  — set an analyst manual classification (authoritative over auto)
 *   DELETE — clear the manual classification (revert to automatic)
 *
 * Stage N1.3. Manual override is stored in rawMetadata.riskClassification.manual
 * and always wins for ORION snapshot highlighting.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { ManualResultClassificationSchema } from "@/modules/digital-profile/validation/evidence-schemas";
import {
  clearManualResultClassification,
  setManualResultClassification,
} from "@/modules/digital-profile/services/result-classification-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  const input = ManualResultClassificationSchema.parse(await readJsonBody(req));
  const data = await setManualResultClassification(id, input, actorOf(user));
  return jsonOk(data);
});

export const DELETE = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  const data = await clearManualResultClassification(id, actorOf(user));
  return jsonOk(data);
});
