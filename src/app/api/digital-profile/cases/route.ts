/**
 * /api/digital-profile/cases
 *   GET  — list cases (paginated, filterable)
 *   POST — create a case (+ its subject)
 *
 * Guarded by the DIGITAL_PROFILE_ENABLED feature flag via `withModule`.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  readJsonBody,
} from "@/modules/digital-profile/http/request";
import {
  createCase,
  listCases,
} from "@/modules/digital-profile/services/case-service";
import {
  CreateDigitalProfileCaseSchema,
  ListDigitalProfileCasesQuerySchema,
} from "@/modules/digital-profile/validation/case-schemas";

export const dynamic = "force-dynamic";

export const GET = withModule(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const query = ListDigitalProfileCasesQuerySchema.parse({
    page: sp.get("page") ?? undefined,
    pageSize: sp.get("pageSize") ?? undefined,
    status: sp.get("status") ?? undefined,
    q: sp.get("q") ?? undefined,
    includeDeleted: sp.get("includeDeleted") ?? undefined,
  });

  const result = await listCases(query);
  return jsonOk(result);
});

export const POST = withModule(async (req: NextRequest) => {
  const body = await readJsonBody(req);
  const input = CreateDigitalProfileCaseSchema.parse(body);
  const created = await createCase(input, getActorContext(req));
  return jsonOk(created, 201);
});
