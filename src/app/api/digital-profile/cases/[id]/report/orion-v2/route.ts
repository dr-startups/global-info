import { NextResponse, type NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  assertOrionUiFlagForRole,
  getOrionV2AiReadiness,
  getOrionV2Summary,
  isOrionV2UiEnabled,
  resolveGpt55ValidationFlag,
  resolveOrionStoreMode,
  runOrionV2Report,
} from "@/modules/digital-profile/services/orion-v2-report-service";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
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

  // R9.5c — user-facing ORION v2 reports must be GPT-5.5-backed. Block early
  // (before any generation) if AI is required but not fully configured.
  const requireAiAnalysis = digitalProfileConfig.orionV2RequireAi;
  const allowDeterministicFallback =
    digitalProfileConfig.orionV2AllowDeterministicFallback;
  const readiness = getOrionV2AiReadiness();
  if (requireAiAnalysis && !readiness.ready) {
    const message =
      "ORION v2 требует включённый GPT-5.5 анализ. Добавьте OPENAI_API_KEY и включите AI analyst.";
    return NextResponse.json(
      {
        ok: false as const,
        code: "ORION_V2_AI_REQUIRED",
        message,
        // Mirror into the standard envelope so the client API parser can read it.
        error: { code: "ORION_V2_AI_REQUIRED", message },
      },
      { status: 422 }
    );
  }

  const record = await runOrionV2Report({
    caseId: id,
    storeMode,
    gpt55Validate,
    includeInternalArtifacts: user.role === "ADMIN" || user.role === "SUPER_ADMIN",
    requireAiAnalysis,
    allowDeterministicFallback,
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

