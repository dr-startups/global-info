import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  assertOrionUiFlagForRole,
  getOrionV2Summary,
  isOrionV2UiEnabled,
  resolveGpt55ValidationFlag,
  resolveOrionStoreMode,
  runOrionV2Report,
} from "@/modules/digital-profile/services/orion-v2-report-service";
import { ForbiddenError } from "@/modules/digital-profile/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.generateInternal");
  await requireCaseAccess(user, id, "VIEWER");
  assertOrionUiFlagForRole(user.role);
  if (!isOrionV2UiEnabled()) {
    throw new ForbiddenError("ORION v2 UI is disabled.");
  }

  const body = (await req.json().catch(() => ({}))) as {
    store?: unknown;
    gpt55Validate?: unknown;
  };
  const storeMode = resolveOrionStoreMode(body.store, user.role);
  const gpt55Validate = resolveGpt55ValidationFlag(body.gpt55Validate, user.role);

  const record = await runOrionV2Report({
    caseId: id,
    storeMode,
    gpt55Validate,
    includeInternalArtifacts: user.role === "ADMIN" || user.role === "SUPER_ADMIN",
  });
  return jsonOk(
    getOrionV2Summary(record.caseId, user.role),
    201
  );
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.generateInternal");
  await requireCaseAccess(user, id, "VIEWER");
  assertOrionUiFlagForRole(user.role);
  return jsonOk(getOrionV2Summary(id, user.role));
});

