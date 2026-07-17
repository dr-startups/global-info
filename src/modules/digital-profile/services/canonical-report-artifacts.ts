/**
 * Lineage-safe resolver for downloadable canonical report artifacts.
 *
 * The ONLY artifacts a client may download are the PDF/PPTX recorded on a
 * COMPLETED, accepted (REPORT_READY) unified job for the requested case+job.
 * Everything is validated fail-closed:
 *   - the job must exist and belong to the case;
 *   - the requested jobId must match the job's id (foreign lineage rejected);
 *   - the job must be COMPLETED + REPORT_READY (stale/partial/unaccepted rejected);
 *   - the artifact kind must be pdf|pptx;
 *   - the resolved path must be one recorded in the job AND physically inside the
 *     job's own artifacts directory (arbitrary paths / path traversal rejected);
 *   - the file must exist on disk.
 *
 * There is NO legacy composer path here and no artifact is ever created.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { AppError } from "../http/errors";
import { loadUnifiedCollectionJob, unifiedArtifactsDir } from "./unified-collection-job-store";

export type CanonicalArtifactKind = "pdf" | "pptx";

export type ResolvedCanonicalArtifact = {
  path: string;
  mimeType: string;
  fileName: string;
  jobId: string;
  caseId: string;
};

const MIME: Record<CanonicalArtifactKind, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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
  return x === "pdf" || x === "pptx";
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

export function resolveCanonicalArtifactForDownload(input: {
  caseId: string;
  jobId: string;
  artifact: string;
}): ResolvedCanonicalArtifact {
  const { caseId } = input;
  if (!input.jobId) {
    throw new CanonicalArtifactError(400, "JOB_ID_REQUIRED", "jobId is required");
  }
  if (!isKind(input.artifact)) {
    throw new CanonicalArtifactError(400, "ARTIFACT_KIND_INVALID", "artifact must be pdf or pptx");
  }

  const job = loadUnifiedCollectionJob(caseId);
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

  const recorded = job.reportLinks?.[input.artifact];
  if (!recorded) {
    throw new CanonicalArtifactError(404, "ARTIFACT_NOT_RECORDED", `no ${input.artifact} recorded on job`);
  }

  // Containment: the recorded path must sit inside THIS job's artifacts dir.
  const jobRoot = canonicalizePath(unifiedArtifactsDir(caseId, job.unifiedJobId));
  const resolved = canonicalizePath(recorded);
  const within = resolved === jobRoot || resolved.startsWith(`${jobRoot}${sep}`);
  if (!within) {
    throw new CanonicalArtifactError(404, "ARTIFACT_OUT_OF_LINEAGE", "artifact path is outside the job lineage");
  }
  if (!existsSync(resolved)) {
    throw new CanonicalArtifactError(404, "ARTIFACT_MISSING_ON_DISK", "recorded artifact is missing (stale)");
  }

  return {
    path: resolved,
    mimeType: MIME[input.artifact],
    fileName: basename(resolved) || `report.${input.artifact}`,
    jobId: job.unifiedJobId,
    caseId,
  };
}
