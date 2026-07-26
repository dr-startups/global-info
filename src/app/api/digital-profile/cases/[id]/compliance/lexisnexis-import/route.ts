/**
 * POST /api/digital-profile/cases/[id]/compliance/lexisnexis-import
 * Upload a LexisNexis DOCX report and run hybrid import:
 *  - preserve original DOCX as evidence
 *  - best-effort visual page rendering
 *  - deterministic parsed analytics/signals
 */

import type { NextRequest } from "next/server";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { importLexisNexisHybridReport } from "@/modules/digital-profile/compliance-providers";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_BYTES = 30 * 1024 * 1024;

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");

  const form = await req.formData().catch(() => {
    throw new ValidationError("Expected multipart/form-data with a 'file' field");
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Missing 'file' upload");
  const fileName = String(file.name || "");
  if (!/\.docx$/i.test(fileName)) throw new ValidationError("Only .docx files are allowed");
  if (file.size > MAX_BYTES) throw new ValidationError("File exceeds 30 MB limit");

  const buffer = Buffer.from(await file.arrayBuffer());
  const data = await importLexisNexisHybridReport(
    id,
    {
      fileName,
      mimeType: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer,
    },
    actorOf(user)
  );
  return jsonOk(data, 201);
});

