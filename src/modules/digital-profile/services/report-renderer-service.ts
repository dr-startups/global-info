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
import { loadFile, saveFile } from "../storage/private-store";
import { fetchImageThumbnail } from "../evidence-quality/image-thumbnail-service";
import { buildStorageKey } from "../storage/keys";
import { buildAuditSummary } from "../audit-summary/builder";
import { buildComplianceSummaryBlock } from "../compliance-providers";
import { buildOfferConfig } from "../report/offer-config";
import {
  sanitizeReportJsonForAudience,
  normalizeProductionReportMode,
  assertClientReportPolicy,
} from "../report/report-data-policy";
import {
  buildSelectedEvidenceReportVm,
  patchAuditSummaryWithSelectedEvidence,
} from "../report/selected-evidence-report-vm";
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
  /** Base64-encoded file bytes returned over HTTP (renderer is stateless). */
  contentBase64?: string;
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
  const storedSelected = reportJson.selectedEvidence;
  const storedSearchSurfaces = reportJson.searchSurfaces;
  const storedRiskSummary = reportJson.riskSummary;
  const storedEvidenceQuality = reportJson.evidenceQuality;

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
  try {
    localized.complianceSummary = await buildComplianceSummaryBlock(caseId, reportLanguage, {
      includeDemoData: reportJson.meta?.demo === true,
    });
  } catch {
    // Keep stored compliance block; mapper still localizes labels at render time.
  }

  // O5.4 — always rebuild selected evidence at render (stored VM may be stale).
  const searchSurfaces = localized.searchSurfaces ?? storedSearchSurfaces;
  if (searchSurfaces && localized.auditSummary) {
    const selectedEvidence = buildSelectedEvidenceReportVm({
      searchSurfaces,
      reportAudience: "INTERNAL",
      riskSummary: storedRiskSummary ?? localized.riskSummary,
      complianceSummary: localized.complianceSummary ?? reportJson.complianceSummary,
      evidenceQuality: storedEvidenceQuality ?? localized.evidenceQuality,
    });
    localized.selectedEvidence = selectedEvidence;
    localized.auditSummary = patchAuditSummaryWithSelectedEvidence(
      localized.auditSummary,
      selectedEvidence
    );
  } else if (storedSelected && localized.auditSummary) {
    localized.selectedEvidence = storedSelected;
    localized.auditSummary = patchAuditSummaryWithSelectedEvidence(
      localized.auditSummary,
      storedSelected
    );
  }

  return localized;
}

type ThumbnailWirePayload = { base64: string; mimeType: string };

const MIN_RENDER_THUMB_B64_LEN = 6000;

function isLikelyTinyThumbnail(payload: ThumbnailWirePayload): boolean {
  return payload.base64.length < MIN_RENDER_THUMB_B64_LEN;
}

function mimeTypeForThumbnailKey(storageKey: string): string {
  const lower = storageKey.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function applyThumbnailWireFields(
  target: Record<string, unknown>,
  payload: ThumbnailWirePayload
): void {
  target.thumbnailBytesBase64 = payload.base64;
  target.thumbnailMimeType = payload.mimeType;
  // Backward compat for mapper/theme that read thumbnailBase64.
  target.thumbnailBase64 = payload.base64;
  target.hasThumbnail = true;
}

/**
 * O5.4.1 — loads selected image thumbnail bytes from app private storage and
 * attaches wire-only base64 fields for the stateless renderer. Never persisted
 * in stored report_json or exposed on client GET /report.
 */
async function attachSelectedImageThumbnailBytes(
  reportJson: ReportJson,
  caseId: string
): Promise<{ json: ReportJson; warnings: string[] }> {
  const warnings: string[] = [];
  const next = JSON.parse(JSON.stringify(reportJson)) as ReportJson & {
    auditSummary?: { regions?: Array<Record<string, unknown>> };
    selectedEvidence?: {
      images?: { selectedSubjectMatched?: Array<Record<string, unknown>> };
      regions?: Record<
        string,
        { images?: Array<Record<string, unknown>> } | undefined
      >;
    };
  };

  const keyCache = new Map<string, ThumbnailWirePayload | null>();

  async function resolveThumbnail(
    storageKey: string,
    label: string
  ): Promise<ThumbnailWirePayload | null> {
    const cached = keyCache.get(storageKey);
    if (cached !== undefined) return cached;
    try {
      const bytes = await loadFile(storageKey);
      const payload = {
        base64: bytes.toString("base64"),
        mimeType: mimeTypeForThumbnailKey(storageKey),
      };
      keyCache.set(storageKey, payload);
      return payload;
    } catch {
      keyCache.set(storageKey, null);
      warnings.push(`Thumbnail unavailable for ${label}`);
      return null;
    }
  }

  async function attachToImageRecord(
    item: Record<string, unknown> | undefined,
    label: string
  ): Promise<void> {
    if (!item) return;
    const key = item.thumbnailStorageKey;
    let payload: ThumbnailWirePayload | null = null;
    if (typeof key === "string" && key.trim()) {
      payload = await resolveThumbnail(key, label);
    }
    if (payload && !isLikelyTinyThumbnail(payload)) {
      applyThumbnailWireFields(item, payload);
      return;
    }
    const imageUrl = String(
      item.imageUrl ?? item.thumbnailUrl ?? item.url ?? ""
    ).trim();
    if (caseId && imageUrl.startsWith("http")) {
      const fetched = await fetchImageThumbnail({ caseId, imageUrl });
      if (fetched.storageKey) {
        const alt = await resolveThumbnail(fetched.storageKey, label);
        if (alt && !isLikelyTinyThumbnail(alt)) {
          applyThumbnailWireFields(item, alt);
          return;
        }
      }
    }
    if (payload) applyThumbnailWireFields(item, payload);
  }

  for (const img of next.selectedEvidence?.images?.selectedSubjectMatched ?? []) {
    await attachToImageRecord(
      img as unknown as Record<string, unknown>,
      String(img.title ?? img.thumbnailStorageKey ?? "selected image")
    );
  }

  for (const regionKey of ["ru", "uae", "international"] as const) {
    for (const img of next.selectedEvidence?.regions?.[regionKey]?.images ?? []) {
      await attachToImageRecord(
        img as unknown as Record<string, unknown>,
        String(img.title ?? img.thumbnailStorageKey ?? `${regionKey} image`)
      );
    }
  }

  for (const region of next.auditSummary?.regions ?? []) {
    const topImages = region.topImages;
    if (!Array.isArray(topImages)) continue;
    for (const item of topImages) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      await attachToImageRecord(rec, String(rec.title ?? rec.thumbnailStorageKey ?? "image"));
    }
  }

  return { json: next as ReportJson, warnings };
}

async function attachLexisNexisPageImages(
  reportJson: ReportJson
): Promise<{ json: ReportJson; warnings: string[] }> {
  const warnings: string[] = [];
  const next = JSON.parse(JSON.stringify(reportJson)) as ReportJson & {
    lexisNexisHybrid?: {
      documents?: Array<{
        renderedPages?: Array<Record<string, unknown>>;
      }>;
    };
  };
  const docs = next.lexisNexisHybrid?.documents ?? [];
  for (const doc of docs) {
    const pages = doc.renderedPages ?? [];
    for (const page of pages) {
      const key = String(page.storageKey ?? "");
      if (!key) continue;
      try {
        const bytes = await loadFile(key);
        page.imageBase64 = bytes.toString("base64");
      } catch {
        warnings.push(`LexisNexis rendered page unavailable: ${key}`);
      }
    }
  }
  return { json: next, warnings };
}

/**
 * O5.4.1 — defensive check: when selectedEvidence exists, renderer payload must
 * use patched audit regions (not raw collected topImages/topVideos).
 */
function assertRenderPayloadUsesSelectedEvidence(
  reportJson: ReportJson,
  warnings: string[]
): void {
  const selected = reportJson.selectedEvidence;
  if (!selected) return;

  const selectedImages =
    selected.images?.metrics?.imagesSelected ??
    selected.images?.selectedSubjectMatched?.length ??
    0;
  const selectedVideos =
    selected.videos?.metrics?.videosSelected ??
    selected.videos?.selectedSubjectMatched?.length ??
    0;

  const regions = reportJson.auditSummary?.regions ?? [];
  const ru = regions.find((r) => r.region === "RU") as
    | (Record<string, unknown> & { region: string })
    | undefined;
  const intl = regions.find((r) => r.region === "INTERNATIONAL") as
    | (Record<string, unknown> & { region: string })
    | undefined;

  if (selectedImages > 0 && ru) {
    const topImages = Array.isArray(ru.topImages) ? ru.topImages : [];
    const imagesTotal = typeof ru.imagesTotal === "number" ? ru.imagesTotal : null;
    const imagesSelected =
      typeof ru.imagesSelected === "number" ? ru.imagesSelected : topImages.length;

    if (topImages.length === 0) {
      warnings.push(
        "RENDER_INTEGRITY: selectedEvidence has images but audit RU topImages is empty"
      );
    } else if (
      imagesTotal != null &&
      topImages.length === imagesTotal &&
      imagesSelected < imagesTotal
    ) {
      warnings.push(
        "RENDER_INTEGRITY: RU topImages appears to use raw collected set, not selected evidence"
      );
    }
  }

  if (selectedVideos > 0 && ru) {
    const topVideos = Array.isArray(ru.topVideos) ? ru.topVideos : [];
    const videosTotal = typeof ru.videosTotal === "number" ? ru.videosTotal : null;
    const videosSelected =
      typeof ru.videosSelected === "number" ? ru.videosSelected : topVideos.length;

    if (topVideos.length === 0) {
      warnings.push(
        "RENDER_INTEGRITY: selectedEvidence has videos but audit RU topVideos is empty"
      );
    } else if (
      videosTotal != null &&
      topVideos.length === videosTotal &&
      videosSelected < videosTotal
    ) {
      warnings.push(
        "RENDER_INTEGRITY: RU topVideos appears to use raw collected set, not selected evidence"
      );
    }
  }

  if (selected.regions?.international?.noIntlSubjectResults && intl) {
    const intlImages = Array.isArray(intl.topImages) ? intl.topImages.length : 0;
    const intlVideos = Array.isArray(intl.topVideos) ? intl.topVideos.length : 0;
    const intlOrganic = Array.isArray(intl.topResults) ? intl.topResults.length : 0;
    if (intlImages + intlVideos + intlOrganic > 0) {
      warnings.push(
        "RENDER_INTEGRITY: international region has rendered rows despite noIntlSubjectResults"
      );
    }
  }
}

async function attachSerpSnapshotImage(
  reportJson: ReportJson
): Promise<ReportJson> {
  const ss = reportJson.serpSnapshot;
  if (!ss?.storageKey) return reportJson;
  try {
    const bytes = await loadFile(ss.storageKey);
    return {
      ...reportJson,
      serpSnapshot: { ...ss, imageBase64: bytes.toString("base64") },
    };
  } catch {
    return reportJson;
  }
}

export async function renderReportVersion(
  caseId: string,
  version: number | undefined,
  ctx: ActorContext = {},
  options: RenderOptions = {}
): Promise<RenderedReportDTO> {
  const templateVersion = options.templateVersion;
  // Stage R3.6 — normalize production mode: only "internal" stays internal; every
  // other requested mode ("client"/"production"/unknown) resolves to client-safe.
  const audience: "internal" | "client" = options.audience
    ? normalizeProductionReportMode(options.audience)
    : "internal";
  const watermarkMode = options.watermarkMode ?? "draft";
  const productionPolicyWarnings: string[] = [];
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
  const { json: withLexisPages, warnings: lexisWarnings } = await attachLexisNexisPageImages(
    localizedReportJson
  );
  const audienceReportJson =
    audience === "client"
      ? (sanitizeReportJsonForAudience(
          withLexisPages as unknown as Record<string, unknown>,
          "client"
        ) as unknown as ReportJson)
      : withLexisPages;

  // Re-patch client audience selection onto audit regions after sanitization.
  if (
    audience === "client" &&
    localizedReportJson.searchSurfaces &&
    audienceReportJson.auditSummary
  ) {
    const clientVm = buildSelectedEvidenceReportVm({
      searchSurfaces: localizedReportJson.searchSurfaces,
      reportAudience: "CLIENT",
      riskSummary: localizedReportJson.riskSummary,
      complianceSummary: localizedReportJson.complianceSummary,
      evidenceQuality: localizedReportJson.evidenceQuality,
    });
    audienceReportJson.selectedEvidence = clientVm;
    audienceReportJson.auditSummary = patchAuditSummaryWithSelectedEvidence(
      audienceReportJson.auditSummary,
      clientVm
    );
  }

  // Stage R3.6 — production release gate: loudly flag any internal-only markers
  // that survived sanitization for a client/production render.
  if (audience === "client") {
    const violations = assertClientReportPolicy(
      JSON.stringify(audienceReportJson ?? {})
    );
    if (violations.length > 0) {
      productionPolicyWarnings.push(
        `Client report policy: internal-only markers detected and suppressed at render (${violations
          .slice(0, 8)
          .join(", ")})`
      );
    }
  }
  // Stage S1.5: the renderer is stateless and has no access to private storage,
  // so the SERP snapshot PNG travels inside report_json as base64. This is added
  // only on the wire (not persisted in the stored report_json, which stays
  // lightweight). If the image is unreadable the renderer falls back + warns.
  const { json: withThumbnails, warnings: thumbnailWarnings } =
    await attachSelectedImageThumbnailBytes(audienceReportJson, caseId);
  const renderPayloadWarnings: string[] = [
    ...productionPolicyWarnings,
    ...thumbnailWarnings,
    ...lexisWarnings,
  ];
  assertRenderPayloadUsesSelectedEvidence(withThumbnails, renderPayloadWarnings);
  const renderReportJson = await attachSerpSnapshotImage(withThumbnails);

  const result = await callRenderer({
    reportJson: renderReportJson,
    pptxKey,
    pdfKey,
    templateVersion: resolvedTemplate,
    audience,
    watermarkMode,
    reportLanguage,
  });

  // Stateless renderer: it returns the file bytes; the app persists them via its
  // own storage provider (no shared volume between app and renderer).
  if (!result.pptx.contentBase64 || !result.pdf.contentBase64) {
    throw new RendererUnavailableError(
      "Renderer did not return file content",
      "Expected base64 pptx/pdf bytes from the renderer"
    );
  }
  await saveFile(pptxKey, Buffer.from(result.pptx.contentBase64, "base64"));
  await saveFile(pdfKey, Buffer.from(result.pdf.contentBase64, "base64"));

  const warnings = [...renderPayloadWarnings, ...(result.warnings ?? [])];
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
        pptxStorageKey: pptxKey,
        pdfStorageKey: pdfKey,
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

/** QA-only: wire-time enrichment for legacy /render without DB persistence. */
export async function prepareLegacyClientRenderPayload(
  caseId: string,
  reportJson: ReportJson
): Promise<{ json: ReportJson; warnings: string[] }> {
  const { json: withLexisPages, warnings: lexisWarnings } = await attachLexisNexisPageImages(reportJson);
  const audienceReportJson = sanitizeReportJsonForAudience(
    withLexisPages as unknown as Record<string, unknown>,
    "client"
  ) as unknown as ReportJson;

  if (audienceReportJson.searchSurfaces && audienceReportJson.auditSummary) {
    const clientVm = buildSelectedEvidenceReportVm({
      searchSurfaces: audienceReportJson.searchSurfaces,
      reportAudience: "CLIENT",
      riskSummary: audienceReportJson.riskSummary,
      complianceSummary: audienceReportJson.complianceSummary,
      evidenceQuality: audienceReportJson.evidenceQuality,
    });
    audienceReportJson.selectedEvidence = clientVm;
    audienceReportJson.auditSummary = patchAuditSummaryWithSelectedEvidence(
      audienceReportJson.auditSummary,
      clientVm
    );
  }

  const { json: withThumbnails, warnings: thumbnailWarnings } =
    await attachSelectedImageThumbnailBytes(audienceReportJson, caseId);
  const renderReportJson = await attachSerpSnapshotImage(withThumbnails);
  return {
    json: renderReportJson,
    warnings: [...lexisWarnings, ...thumbnailWarnings],
  };
}

export interface LegacyQaRenderResult {
  pptxBase64: string;
  pdfBase64: string;
  slideCount: number;
  warnings: string[];
  pdfExportMode: "libreoffice" | "unknown";
}

/** QA-only: render legacy report_json through production /render (LibreOffice PDF). */
export async function renderLegacyReportJsonForQa(input: {
  caseId: string;
  reportJson: ReportJson;
}): Promise<LegacyQaRenderResult> {
  const { json, warnings: prepWarnings } = await prepareLegacyClientRenderPayload(
    input.caseId,
    input.reportJson
  );
  const result = await callRenderer({
    reportJson: json,
    pptxKey: `qa/${input.caseId}/r98a-client.pptx`,
    pdfKey: `qa/${input.caseId}/r98a-client.pdf`,
    templateVersion: digitalProfileConfig.reportTemplateVersion,
    audience: "client",
    watermarkMode: "none",
    reportLanguage: normalizeReportLanguage("ru", digitalProfileConfig.defaultLocale),
  });
  if (!result.pptx.contentBase64 || !result.pdf.contentBase64) {
    throw new RendererUnavailableError(
      "Renderer did not return file content",
      "Expected base64 pptx/pdf bytes from the renderer"
    );
  }
  const rendererWarnings = result.warnings ?? [];
  const pdfExportMode = [...prepWarnings, ...rendererWarnings].some((w) =>
    /fitz|text-only pdf|pdf fallback|_write_pdf_fallback/i.test(w)
  )
    ? "unknown"
    : "libreoffice";
  return {
    pptxBase64: result.pptx.contentBase64,
    pdfBase64: result.pdf.contentBase64,
    slideCount: result.slideCount ?? 0,
    warnings: [...prepWarnings, ...rendererWarnings],
    pdfExportMode,
  };
}
