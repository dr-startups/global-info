/**
 * /api/digital-profile/cases/[id]/serp-snapshot
 *   GET — return the latest synthetic SERP snapshot (metadata + signed URL) or null.
 *
 * Authorization: viewing requires the staff "evidence.viewRaw" capability
 * (SUPER_ADMIN/ADMIN/ANALYST/REVIEWER) + VIEWER access on the case. CLIENT_VIEWER
 * never sees the synthetic snapshot or its internal note.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { getLatestSerpSnapshot } from "@/modules/digital-profile/serp-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");

  const snapshot = await getLatestSerpSnapshot(id);
  return jsonOk({ snapshot });
});
