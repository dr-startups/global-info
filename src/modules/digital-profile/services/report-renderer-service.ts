/**
 * Report renderer integration (Stage E).
 *
 * Calls the isolated Python renderer microservice (python-pptx + headless
 * LibreOffice) to turn a stored report version's `report_json` into a PPTX + PDF
 * written to shared PRIVATE storage. Persists the resulting storage keys on the
 * report version and serves the files only via signed-URL download routes.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import {
  NotFoundError,
  RendererUnavailableError,
  ValidationError,
} from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { digitalProfileConfig } from "../config";
import {
  buildReportDownloadUrl,
  verifySignedToken,
} from "../storage/signed-url";
import { loadFile } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { buildAuditSummary } from "../audit-summary/builder";
import { buildOfferConfig } from "../report/offer-config";
import {
  normalizeReportLanguage,
  type ReportLanguage,
} from "../report/i18n/report-dictionary";
import type { ActorContext } from "./case-service";
import type { ReportJson, ReportStatus } from "../types";

export interface RenderedReportDTO {
  id: string;
  caseId: string;
  version: number;
  status: ReportStatus;
  watermark: string | null;
  renderedAt: Date | null;
  pptxDownloadUrl: string | null;
  pdfDownloadUrl: string | null;
  templateVersion: string | null;
  slideCount: number;
  audience: string;
  watermarkMode: string;
  reportLanguage: string;
  warnings: string[];
}

interface RendererFileInfo {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}
interface RendererResponse {
  pptx: RendererFileInfo;
  pdf: RendererFileInfo;
  templateVersion?: string;
  slideCount?: number;
  audience?: string;
  watermarkMode?: string;
  reportLanguage?: string;
  warnings?: string[];
}

async function callRenderer(body: {
  reportJson: ReportJson;
  pptxKey: string;
  pdfKey: string;
  templateVersion?: string;
  audience?: string;
  watermarkMode?: string;
  reportLanguage?: string;
}): Promise<RendererResponse> {
  const url = `${digitalProfileConfig.rendererUrl}/render`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Renderer + LibreOffice can take a while on first call.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new RendererUnavailableError(
      "Could not reach the report renderer",
      err instanceof Error ? err.message : String(err)
    );
  }

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new RendererUnavailableError("Renderer returned an error", detail);
  }

  return (await res.json()) as RendererResponse;
}

/**
 * Renders a report version (defaults to the latest) into PPTX + PDF and stores
 * the artifact keys. Returns signed download URLs.
 */
export interface RenderOptions {
  templateVersion?: string;
  audience?: "internal" | "client";
  watermarkMode?: "draft" | "none";
  reportLanguage?: ReportLanguage;
}

/**
 * Re-localizes a stored report_json into the requested report language so the
 * renderer produces a RU or EN deck. Raw evidence (URLs, titles, snippets,
 * dynamicPages) is never translated — only the system-generated audit summary,
 * offer block and language metadata are rebuilt. Best-effort: failures keep the
 * stored summary so a deck is always produced.
 */
async function localizeReportJson(
  caseId: string,
  reportJson: ReportJson,
  reportLanguage: ReportLanguage
): Promise<ReportJson> {
  const localized: ReportJson = {
    ...reportJson,
    reportLanguage,
    meta: { ...reportJson.meta, language: reportLanguage },
    offer: buildOfferConfig(reportLanguage),
  };
  try {
    localized.auditSummary = await buildAuditSummary(caseId, {
      locale: reportLanguage,
    });
  } catch {
    // Keep the stored summary; labels still localize in the renderer.
  }
  return localized;
}

export async function renderReportVersion(
  caseId: string,
  version: number | undefined,
  ctx: ActorContext = {},
  options: RenderOptions = {}
): Promise<RenderedReportDTO> {
  const templateVersion = options.templateVersion;
  const audience = options.audience ?? "internal";
  const watermarkMode = options.watermarkMode ?? "draft";
  const reportLanguage = normalizeReportLanguage(
    options.reportLanguage,
    digitalProfileConfig.defaultLocale
  );
  const reportVersion = await prisma.reportVersion.findFirst({
    where: { caseId, ...(version != null ? { version } : {}) },
    orderBy: { version: "desc" },
    select: { id: true, version: true, reportJson: true, status: true },
  });
  if (!reportVersion) {
    throw new NotFoundError("No report version to render");
  }

  const resolvedTemplate =
    templateVersion ?? digitalProfileConfig.reportTemplateVersion;

  // Stage M2 key convention: cases/{caseId}/reports/{reportVersionId}/report.{ext}
  const pptxKey = buildStorageKey.reportArtifact(caseId, reportVersion.id, "pptx");
  const pdfKey = buildStorageKey.reportArtifact(caseId, reportVersion.id, "pdf");

  const localizedReportJson = await localizeReportJson(
    caseId,
    reportVersion.reportJson as unknown as ReportJson,
    reportLanguage
  );

  const result = await callRenderer({
    reportJson: localizedReportJson,
    pptxKey,
    pdfKey,
    templateVersion: resolvedTemplate,
    audience,
    watermarkMode,
    reportLanguage,
  });

  const warnings = result.warnings ?? [];
  const usedTemplate = result.templateVersion ?? resolvedTemplate;
  const slideCount = result.slideCount ?? 0;
  const usedAudience = result.audience ?? audience;
  const usedWatermarkMode = result.watermarkMode ?? watermarkMode;
  const usedReportLanguage = normalizeReportLanguage(
    result.reportLanguage,
    reportLanguage
  );

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.reportVersion.update({
      where: { id: reportVersion.id },
      data: {
        pptxStorageKey: result.pptx.storageKey,
        pdfStorageKey: result.pdf.storageKey,
        renderedAt: new Date(),
        templateVersion: usedTemplate,
        renderWarnings: warnings as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        caseId: true,
        version: true,
        status: true,
        watermark: true,
        renderedAt: true,
        pptxStorageKey: true,
        pdfStorageKey: true,
        templateVersion: true,
        renderWarnings: true,
      },
    });
    await recordAudit(
      {
        caseId,
        action: "REPORT_RENDERED",
        actorId: ctx.actorId,
        metadata: {
          version: row.version,
          pptxSha256: result.pptx.sha256,
          pdfSha256: result.pdf.sha256,
          templateVersion: usedTemplate,
          slideCount,
          audience: usedAudience,
          watermarkMode: usedWatermarkMode,
          reportLanguage: usedReportLanguage,
          warnings,
        },
      },
      tx
    );
    return row;
  });

  return {
    id: updated.id,
    caseId: updated.caseId,
    version: updated.version,
    status: updated.status as ReportStatus,
    watermark: updated.watermark,
    renderedAt: updated.renderedAt,
    pptxDownloadUrl: updated.pptxStorageKey
      ? buildReportDownloadUrl(updated.id, updated.pptxStorageKey, "pptx")
      : null,
    pdfDownloadUrl: updated.pdfStorageKey
      ? buildReportDownloadUrl(updated.id, updated.pdfStorageKey, "pdf")
      : null,
    templateVersion: updated.templateVersion,
    slideCount,
    audience: usedAudience,
    watermarkMode: usedWatermarkMode,
    reportLanguage: usedReportLanguage,
    warnings: Array.isArray(updated.renderWarnings)
      ? (updated.renderWarnings as unknown as string[])
      : [],
  };
}

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

/** Validates a signed token and returns the rendered file bytes for download. */
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

  // Auth/access control runs only after the signed token is validated, so a
  // valid token can never bypass authorization when auth is enabled.
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
