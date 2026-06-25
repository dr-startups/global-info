/**
 * /api/digital-profile/cases/[id]/wikipedia-checks
 *   POST — record a manual Wikipedia presence check (never auto-publishes)
 *   GET  — list Wikipedia checks for the case
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
  addWikipediaCheck,
  listEvidence,
} from "@/modules/digital-profile/services/evidence-service";
import { AddWikipediaCheckSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = AddWikipediaCheckSchema.parse(await readJsonBody(req));
  const data = await addWikipediaCheck(id, input, actorOf(user));
  return jsonOk(data, 201);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const evidence = await listEvidence(id);
  return jsonOk(evidence.wikipediaChecks);
});
