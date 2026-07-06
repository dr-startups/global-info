import { NextResponse, type NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { describeOrionV2AiReadiness } from "@/modules/digital-profile/config";
import { ForbiddenError } from "@/modules/digital-profile/http/errors";
import {
  assertOrionClientStoryboardUiFlagForRole,
  enqueueOrionClientStoryboardReport,
  getOrionClientStoryboardSummary,
  isOrionClientStoryboardUiEnabled,
} from "@/modules/digital-profile/services/orion-client-storyboard-report-service";
import { digitalProfileConfig } from "@/modules/digital-profile/config";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.generateInternal");
  await requireCaseAccess(user, id, "VIEWER");
  assertOrionClientStoryboardUiFlagForRole(user.role);
  if (!isOrionClientStoryboardUiEnabled()) {
    throw new ForbiddenError("ORION client storyboard UI is disabled.");
  }

  const readiness = describeOrionV2AiReadiness();
  if (digitalProfileConfig.orionV2RequireAi && !readiness.ready) {
    const message =
      "Клиентский storyboard требует GPT-5.5. Добавьте OPENAI_API_KEY и включите AI analyst.";
    return NextResponse.json(
      {
        ok: false as const,
        code: "ORION_CLIENT_STORYBOARD_AI_REQUIRED",
        message,
        error: { code: "ORION_CLIENT_STORYBOARD_AI_REQUIRED", message },
      },
      { status: 422 }
    );
  }

  enqueueOrionClientStoryboardReport(id);
  return jsonOk(getOrionClientStoryboardSummary(id), 202);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.generateInternal");
  await requireCaseAccess(user, id, "VIEWER");
  assertOrionClientStoryboardUiFlagForRole(user.role);
  return jsonOk(getOrionClientStoryboardSummary(id));
});
