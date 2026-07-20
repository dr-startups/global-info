/**
 * Lineage-safe resolver for downloadable canonical report artifacts.
 *
 * The ONLY artifacts a client may download are PDF/PPTX/contactSheet for a
 * COMPLETED, accepted (REPORT_READY) unified job for the requested case+job.
 * Everything is validated fail-closed:
 *   - the job must exist and belong to the case;
 *   - the requested jobId must match the job's id (foreign lineage rejected);
 *   - the job must be COMPLETED + REPORT_READY (stale/partial/unaccepted rejected);
 *   - the artifact kind must be pdf|pptx|contactSheet;
 *   - the resolved path must be recorded on the job (pdf/pptx) or the well-known
 *     job-scoped contact-sheet path, and physically inside the job's own
 *     artifacts directory (arbitrary paths / path traversal rejected);
 *   - the file must exist on disk.
 *
 * There is NO legacy composer path here and no artifact is ever created.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { AppError } from "../http/errors";
import { loadUnifiedCollectionJob, unifiedArtifactsDir } from "./unified-collection-job-store";

export type CanonicalArtifactKind = "pdf" | "pptx" | "contactSheet";

export type ResolvedCanonicalArtifact = {
  path: string;
  mimeType: string;
  fileName: string;
  jobId: string;
  caseId: string;
};

export type CanonicalDownloadAvailability = Record<CanonicalArtifactKind, boolean>;

const MIME: Record<CanonicalArtifactKind, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  contactSheet: "image/png",
};

const DEFAULT_FILE_NAME: Record<CanonicalArtifactKind, string> = {
  pdf: "rendered-client.pdf",
  pptx: "rendered-client.pptx",
  contactSheet: "contact-sheet.png",
};

export class CanonicalArtifactError extends AppError {
  constructor(status: number, code: string, message: string) {
    super(status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "VALIDATION_ERROR", status, message);
    this.name = "CanonicalArtifactError";
    this.reasonCode = code;
  }
  readonly reasonCode: string;
}

function isKind(x: string): x is CanonicalArtifactKind {
  return x === "pdf" || x === "pptx" || x === "contactSheet";
}

/** Normalize an absolute path for containment comparison (resolves symlinks when present). */
function canonicalizePath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function assertWithinJobRoot(jobRoot: string, candidate: string): string {
  const resolved = canonicalizePath(candidate);
  const within = resolved === jobRoot || resolved.startsWith(`${jobRoot}${sep}`);
  if (!within) {
    throw new CanonicalArtifactError(404, "ARTIFACT_OUT_OF_LINEAGE", "artifact path is outside the job lineage");
  }
  if (!existsSync(resolved)) {
    throw new CanonicalArtifactError(404, "ARTIFACT_MISSING_ON_DISK", "recorded artifact is missing (stale)");
  }
  return resolved;
}

/**
 * Resolve the on-disk path for a downloadable kind.
 * pdf/pptx require an explicit reportLinks entry.
 * contactSheet may use reportLinks.contactSheet or the well-known render/contact-sheet.png.
 */
function resolveArtifactPath(
  kind: CanonicalArtifactKind,
  reportLinks: { pdf?: string; pptx?: string; contactSheet?: string } | undefined,
  jobRoot: string
): string {
  if (kind === "pdf" || kind === "pptx") {
    const recorded = reportLinks?.[kind];
    if (!recorded) {
      throw new CanonicalArtifactError(404, "ARTIFACT_NOT_RECORDED", `no ${kind} recorded on job`);
    }
    return assertWithinJobRoot(jobRoot, recorded);
  }

  const recorded = reportLinks?.contactSheet;
  if (recorded) {
    return assertWithinJobRoot(jobRoot, recorded);
  }
  // Well-known job-scoped location written by the HTTP renderer path.
  return assertWithinJobRoot(jobRoot, join(jobRoot, "render", "contact-sheet.png"));
}

export async function resolveCanonicalArtifactForDownload(input: {
  caseId: string;
  jobId: string;
  artifact: string;
}): Promise<ResolvedCanonicalArtifact> {
  const { caseId } = input;
  if (!input.jobId) {
    throw new CanonicalArtifactError(400, "JOB_ID_REQUIRED", "jobId is required");
  }
  if (!isKind(input.artifact)) {
    throw new CanonicalArtifactError(
      400,
      "ARTIFACT_KIND_INVALID",
      "artifact must be pdf, pptx, or contactSheet"
    );
  }

  const job = await loadUnifiedCollectionJob(caseId);
  if (!job) {
    throw new CanonicalArtifactError(404, "JOB_NOT_FOUND", "no unified job for case");
  }
  // Foreign lineage: the requested jobId must match this case's job.
  if (job.unifiedJobId !== input.jobId && job.jobId !== input.jobId) {
    throw new CanonicalArtifactError(404, "FOREIGN_JOB_LINEAGE", "jobId does not match case job");
  }
  // Only fully accepted reports are downloadable (reject partial/unaccepted/stale).
  if (job.status !== "COMPLETED" || job.stage !== "REPORT_READY") {
    throw new CanonicalArtifactError(
      409,
      job.stage === "COMPLETED_PARTIAL" ? "REPORT_PARTIAL_NOT_ACCEPTED" : "REPORT_NOT_ACCEPTED",
      `report not accepted for download (stage=${job.stage}, status=${job.status})`
    );
  }

  const jobRoot = canonicalizePath(unifiedArtifactsDir(caseId, job.unifiedJobId));
  const resolved = resolveArtifactPath(input.artifact, job.reportLinks, jobRoot);

  return {
    path: resolved,
    mimeType: MIME[input.artifact],
    fileName: basename(resolved) || DEFAULT_FILE_NAME[input.artifact],
    jobId: job.unifiedJobId,
    caseId,
  };
}

/** Fail-closed availability map for UI buttons (never invents artifacts). */
export async function getCanonicalDownloadAvailability(input: {
  caseId: string;
  jobId: string;
}): Promise<CanonicalDownloadAvailability> {
  const kinds: CanonicalArtifactKind[] = ["pdf", "pptx", "contactSheet"];
  const out: CanonicalDownloadAvailability = { pdf: false, pptx: false, contactSheet: false };
  for (const artifact of kinds) {
    try {
      await resolveCanonicalArtifactForDownload({ ...input, artifact });
      out[artifact] = true;
    } catch {
      out[artifact] = false;
    }
  }
  return out;
}
