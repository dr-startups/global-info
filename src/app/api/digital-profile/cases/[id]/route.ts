/**
 * /api/digital-profile/cases/[id]
 *   GET    — fetch one case
 *   PATCH  — update case fields
 *   DELETE — soft delete (sets deletedAt; never hard-deletes)
 *
 * Guarded by the DIGITAL_PROFILE_ENABLED feature flag via `withModule`.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  deleteCaseSoft,
  getCaseById,
  updateCase,
} from "@/modules/digital-profile/services/case-service";
import { UpdateDigitalProfileCaseSchema } from "@/modules/digital-profile/validation/case-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(
  async (req: NextRequest, ctx: RouteContext) => {
    const { id } = await ctx.params;
    const user = await requireDigitalProfileUser(req);
    requireRole(user, "case.view");
    await requireCaseAccess(user, id, "VIEWER");
    const data = await getCaseById(id, actorOf(user));
    return jsonOk(data);
  }
);

export const PATCH = withModule(
  async (req: NextRequest, ctx: RouteContext) => {
    const { id } = await ctx.params;
    const user = await requireDigitalProfileUser(req);
    requireRole(user, "case.update");
    await requireCaseAccess(user, id, "EDITOR");
    const body = await readJsonBody(req);
    const input = UpdateDigitalProfileCaseSchema.parse(body);
    const data = await updateCase(id, input, actorOf(user));
    return jsonOk(data);
  }
);

export const DELETE = withModule(
  async (req: NextRequest, ctx: RouteContext) => {
    const { id } = await ctx.params;
    const user = await requireDigitalProfileUser(req);
    requireRole(user, "case.delete");
    await requireCaseAccess(user, id, "EDITOR");
    const data = await deleteCaseSoft(id, actorOf(user));
    return jsonOk(data);
  }
);
