/**
 * /api/digital-profile/cases
 *   GET  — list cases (paginated, filterable)
 *   POST — create a case (+ its subject)
 *
 * Guarded by the DIGITAL_PROFILE_ENABLED feature flag via `withModule`.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { accessibleCaseIds } from "@/modules/digital-profile/auth/access-service";
import { canSeeDeletedCases } from "@/modules/digital-profile/auth/roles";
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
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.list");

  const sp = req.nextUrl.searchParams;
  const query = ListDigitalProfileCasesQuerySchema.parse({
    page: sp.get("page") ?? undefined,
    pageSize: sp.get("pageSize") ?? undefined,
    status: sp.get("status") ?? undefined,
    q: sp.get("q") ?? undefined,
    // Only privileged roles may list soft-deleted cases.
    includeDeleted: canSeeDeletedCases(user.role)
      ? sp.get("includeDeleted") ?? undefined
      : undefined,
  });

  const restrictToCaseIds = await accessibleCaseIds(user);
  const result = await listCases(query, { restrictToCaseIds });
  return jsonOk(result);
});

export const POST = withModule(async (req: NextRequest) => {
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.create");
  const body = await readJsonBody(req);
  const input = CreateDigitalProfileCaseSchema.parse(body);
  const created = await createCase(input, actorOf(user));
  return jsonOk(created, 201);
});
