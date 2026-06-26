/**
 * /api/digital-profile/cases/[id]/serp-snapshot/generate
 *   POST — generate a synthetic ORION-style SERP snapshot from stored results.
 *
 * Synthetic only (Stage S1): no live capture, no scraping, no API keys.
 * Authorization: generate requires the staff "evidence.create" capability
 * (SUPER_ADMIN/ADMIN/ANALYST) + EDITOR access on the case. CLIENT_VIEWER is
 * never allowed to generate.
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
import { generateSerpSnapshot } from "@/modules/digital-profile/serp-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  query: z.string().trim().max(200).optional(),
  language: z.enum(["ru", "en"]).optional(),
  // Stage N1.2 — real-vs-mock selection strategy (defaults to prefer_real).
  sourcePreference: z
    .enum(["prefer_real", "real_only", "mock_only", "mixed"])
    .optional(),
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");

  const raw = await req.json().catch(() => ({}));
  const body = BodySchema.safeParse(raw ?? {});
  if (!body.success) {
    throw new ValidationError("Invalid request payload", body.error.flatten());
  }

  const snapshot = await generateSerpSnapshot(
    {
      caseId: id,
      query: body.data.query,
      language: body.data.language,
      sourcePreference: body.data.sourcePreference,
    },
    actorOf(user)
  );

  return jsonOk({ snapshot }, 201);
});
