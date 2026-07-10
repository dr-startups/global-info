/**
 * POST /api/digital-profile/cases/[id]/report-runs/[reportRunId]/serp-captures/live
 * Manual LIVE SERP capture (Playwright). Never called from PDF/PPTX renderer.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import {
  assertCanRegenerateClientContent,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import { actorOf } from "@/modules/digital-profile/auth/guard";
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
  // Align with Manual Review / classic audit: risk.review staff, not evidence.create-only.
  const user = await requireOrionAdminApiAccess(req, caseId, "review");
  assertCanRegenerateClientContent(user);

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

  console.info("[serp-capture] API live POST", {
    caseId,
    reportRunId,
    engine: body.data.engine,
    region: body.data.region,
    query: body.data.query,
    actorId: actorOf(user).actorId,
  });

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
    console.info("[serp-capture] API live result", {
      captureId: capture.id,
      captureStatus: capture.captureStatus,
      geoStatus: capture.geoStatus,
      storageKey: capture.storageKey,
    });
    const status = capture.captureStatus === "READY" ? 201 : 200;
    return jsonOk({ capture }, status);
  } catch (err) {
    console.error("[serp-capture] API live error", {
      caseId,
      reportRunId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof SerpUrlBuilderError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
});
