/**
 * /api/digital-profile/cases/[id]/database-profiles
 *   POST — manually import a compliance database profile (LexisNexis / Dow Jones
 *          / World-Check). Only OFFICIAL_API or MANUAL_IMPORT are accepted.
 *   GET  — list database profiles for the case
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
  addDatabaseProfile,
  listEvidence,
} from "@/modules/digital-profile/services/evidence-service";
import { AddDatabaseProfileSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = AddDatabaseProfileSchema.parse(await readJsonBody(req));
  const data = await addDatabaseProfile(id, input, actorOf(user));
  return jsonOk(data, 201);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const evidence = await listEvidence(id);
  return jsonOk(evidence.databaseProfiles);
});
