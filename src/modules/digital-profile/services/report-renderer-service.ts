/**
 * Legacy ReportVersion download helper (REMEDIATION 9.3).
 *
 * Template generation (report_template_v1/v2/v3 + /render) is retired.
 * This module only streams already-stored PPTX/PDF artifacts for historical
 * ReportVersion rows. New decks use unified-collection + ORION Golden render.
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError, ValidationError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { verifySignedToken } from "../storage/signed-url";
import { loadFile } from "../storage/private-store";
import type { ActorContext } from "./case-service";

export interface ReportFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

const MIME: Record<"pptx" | "pdf", string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

/** Metadata passed to the optional download authorization hook (Stage M1). */
export interface ReportDownloadMeta {
  caseId: string;
  status: string;
  watermark: string | null;
}

/** Validates a signed token and returns stored file bytes (no template render). */
export async function getReportFileForDownload(
  reportVersionId: string,
  type: string,
  token: string,
  ctx: ActorContext = {},
  authorize?: (meta: ReportDownloadMeta) => Promise<void> | void
): Promise<ReportFile> {
  if (type !== "pptx" && type !== "pdf") {
    throw new ValidationError("type must be 'pptx' or 'pdf'");
  }

  const row = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId },
    select: {
      caseId: true,
      version: true,
      status: true,
      watermark: true,
      pptxStorageKey: true,
      pdfStorageKey: true,
    },
  });
  const storageKey = type === "pptx" ? row?.pptxStorageKey : row?.pdfStorageKey;
  if (!row || !storageKey) throw new NotFoundError("Report file not found");

  if (!verifySignedToken(storageKey, token)) {
    throw new NotFoundError("Report file not found");
  }

  if (authorize) {
    await authorize({
      caseId: row.caseId,
      status: String(row.status),
      watermark: row.watermark ?? null,
    });
  }

  const buffer = await loadFile(storageKey).catch(() => {
    throw new NotFoundError("Report file not found");
  });

  await recordAudit({
    caseId: row.caseId,
    action: "REPORT_DOWNLOADED",
    actorId: ctx.actorId,
    metadata: { reportVersionId, type },
  });

  return {
    buffer,
    mimeType: MIME[type],
    filename: `report-v${row.version}.${type}`,
  };
}
