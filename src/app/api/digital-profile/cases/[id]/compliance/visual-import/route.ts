/**
 * POST /api/digital-profile/cases/[id]/compliance/visual-import
 * Upload approved Dow Jones / World-Check page screenshots (PNG/JPEG/WebP).
 *
 * multipart fields:
 *   - provider: DOW_JONES | WORLD_CHECK
 *   - files: one or more image files (also accepts repeated "file")
 *   - matchedName?: optional label
 */

import type { NextRequest } from "next/server";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { importApprovedComplianceVisuals } from "@/modules/digital-profile/compliance-providers";
import type { ComplianceVisualProvider } from "@/modules/digital-profile/orion-golden/classic/orion-compliance-visual-assets";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 4;

function str(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectFiles(form: FormData): File[] {
  const out: File[] = [];
  for (const key of ["files", "file", "pages"]) {
    for (const entry of form.getAll(key)) {
      if (entry instanceof File && entry.size > 0) out.push(entry);
    }
  }
  return out;
}

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");

  const form = await req.formData().catch(() => {
    throw new ValidationError("Expected multipart/form-data with provider + image files");
  });

  const providerRaw = String(form.get("provider") ?? "").toUpperCase();
  if (
    providerRaw !== "DOW_JONES" &&
    providerRaw !== "WORLD_CHECK" &&
    providerRaw !== "LEXISNEXIS"
  ) {
    throw new ValidationError("provider must be DOW_JONES, WORLD_CHECK or LEXISNEXIS");
  }
  const provider = providerRaw as ComplianceVisualProvider;

  const files = collectFiles(form);
  if (files.length === 0) throw new ValidationError("Missing image file upload(s)");
  if (files.length > MAX_PAGES) throw new ValidationError(`At most ${MAX_PAGES} pages are allowed`);

  const pages = [];
  for (const file of files) {
    const fileName = String(file.name || "page.png");
    if (!/\.(png|jpe?g|webp)$/i.test(fileName) && !/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      throw new ValidationError("Only PNG, JPEG, or WebP screenshots are allowed");
    }
    if (file.size > MAX_BYTES) throw new ValidationError("File exceeds 12 MB limit");
    pages.push({
      fileName,
      mimeType: file.type || "image/png",
      buffer: Buffer.from(await file.arrayBuffer()),
    });
  }

  const matchedName = form.get("matchedName");
  const data = await importApprovedComplianceVisuals(
    id,
    {
      provider,
      pages,
      matchedName: typeof matchedName === "string" ? matchedName : undefined,
      // Дата отчёта базы и описание аналитика: первая печатается под снимком
      // происхождением, второе — тремя полями сайдбара.
      reportDate: str(form.get("reportDate")),
      description: {
        whatItShows: str(form.get("whatItShows")),
        whyItMatters: str(form.get("whyItMatters")),
        whatToDo: str(form.get("whatToDo")),
      },
    },
    actorOf(user)
  );
  return jsonOk(data, 201);
});
