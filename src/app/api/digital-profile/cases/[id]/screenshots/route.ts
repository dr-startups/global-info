/**
 * /api/digital-profile/cases/[id]/screenshots
 *   POST — upload a screenshot (multipart/form-data: file, [sourceUrl], [resultId])
 *   GET  — list screenshots (with signed download URLs)
 */

import type { NextRequest } from "next/server";
import {
  jsonOk,
  ValidationError,
  withModule,
} from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { listEvidence } from "@/modules/digital-profile/services/evidence-service";
import { addScreenshot } from "@/modules/digital-profile/services/screenshot-service";
import { ScreenshotUploadMetaSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;

  const form = await req.formData().catch(() => {
    throw new ValidationError("Expected multipart/form-data with a 'file' field");
  });

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("Missing 'file' upload");
  }
  const mimeType = file.type || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new ValidationError("Only image uploads are allowed");
  }
  if (file.size > MAX_BYTES) {
    throw new ValidationError("File exceeds 15 MB limit");
  }

  const meta = ScreenshotUploadMetaSchema.parse({
    sourceUrl: (form.get("sourceUrl") as string | null) || undefined,
    resultId: (form.get("resultId") as string | null) || undefined,
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  const data = await addScreenshot(
    id,
    { buffer, mimeType, ...meta },
    getActorContext(req)
  );
  return jsonOk(data, 201);
});

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const evidence = await listEvidence(id);
  return jsonOk(evidence.screenshots);
});
