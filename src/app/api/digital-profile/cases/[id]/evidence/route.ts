/**
 * /api/digital-profile/cases/[id]/evidence
 *   GET — aggregate of all evidence for a case (queries, results, screenshots,
 *         database profiles, Wikipedia checks, risk findings). Feeds the admin
 *         UI tabs and, later, the report_json builder.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { listEvidence } from "@/modules/digital-profile/services/evidence-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const data = await listEvidence(id);
  return jsonOk(data);
});
