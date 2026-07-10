/**
 * POST /api/digital-profile/cases/[id]/report-runs/[reportRunId]/serp-captures/live
 * Manual LIVE SERP capture (Playwright). Never called from PDF/PPTX renderer.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  captureLiveSerp,
  SerpUrlBuilderError,
} from "@/modules/digital-profile/serp-capture";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string; reportRunId: string }> };

const BodySchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    engine: z.enum(["GOOGLE", "YANDEX"]),
    region: z.enum(["RU", "UAE"]),
    locale: z.string().trim().max(20).optional(),
    device: z.enum(["DESKTOP"]).optional(),
  })
  .strict();

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id: caseId, reportRunId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, caseId, "EDITOR");

  const raw = await req.json().catch(() => ({}));
  if (raw && typeof raw === "object" && "url" in (raw as Record<string, unknown>)) {
    throw new ValidationError("Arbitrary URL is not accepted", {
      url: ["client-supplied-url-forbidden"],
    });
  }

  const body = BodySchema.safeParse(raw ?? {});
  if (!body.success) {
    throw new ValidationError("Invalid request payload", body.error.flatten());
  }

  try {
    const capture = await captureLiveSerp({
      caseId,
      reportRunId,
      query: body.data.query,
      engine: body.data.engine,
      region: body.data.region,
      locale: body.data.locale,
      device: body.data.device,
      capturedBy: actorOf(user).actorId ?? null,
    });
    const status = capture.captureStatus === "READY" ? 201 : 200;
    return jsonOk({ capture }, status);
  } catch (err) {
    if (err instanceof SerpUrlBuilderError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
});
