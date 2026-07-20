/**
 * REMEDIATION §8.3 — support diagnostics zip for a unified job directory.
 * JSON/text artifacts only; binaries skipped; secrets redacted.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import JSZip from "jszip";
import { NotFoundError, ValidationError } from "../http/errors";
import { redactDeep, redactSecrets } from "../providers/arsenkin/redact";
import { loadUnifiedCollectionJob, unifiedArtifactsDir } from "./unified-collection-job-store";

const BINARY_EXT = new Set([
  ".pdf",
  ".pptx",
  ".ppt",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp4",
  ".webm",
  ".zip",
  ".docx",
  ".bin",
]);

const TEXT_EXT = new Set([
  ".json",
  ".txt",
  ".md",
  ".csv",
  ".log",
  ".yml",
  ".yaml",
]);

/** Extra key names to redact beyond arsenkin redactDeep. */
const SECRET_KEY_RE =
  /^(authorization|token|api[_-]?key|password|secret|client[_-]?secret|openAiApiKey|openai[_-]?api[_-]?key|bearer|access[_-]?token|refresh[_-]?token|signed[_-]?url|storageKey)$/i;

const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 400;

export type DiagnosticsBundleResult = {
  zipBuffer: Buffer;
  fileName: string;
  includedCount: number;
  skippedBinaryCount: number;
  skippedOversizeCount: number;
};

function isUnderDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

function shouldSkipDir(name: string): boolean {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === "image-preview-cache" ||
    name === "png" ||
    name === "pages"
  );
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES * 2) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (shouldSkipDir(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (st.isFile()) out.push(full);
    }
  }
  return out;
}

export function redactDiagnosticsJson(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDiagnosticsJson(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDiagnosticsJson(v);
      }
    }
    return out;
  }
  return value;
}

function sanitizePlainText(text: string): string {
  return redactSecrets(text)
    .replace(/\b(OPENAI_API_KEY|API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}

function sanitizeFileContent(path: string, raw: Buffer): string {
  const text = raw.toString("utf8");
  if (path.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return `${JSON.stringify(redactDiagnosticsJson(parsed), null, 2)}\n`;
    } catch {
      return sanitizePlainText(text);
    }
  }
  return sanitizePlainText(text);
}

/**
 * Build a zip of JSON/text diagnostics for a unified job (no PDF/PPTX/PNG).
 */
export async function buildUnifiedDiagnosticsBundle(input: {
  caseId: string;
  jobId: string;
}): Promise<DiagnosticsBundleResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const job = loadUnifiedCollectionJob(input.caseId);
  if (!job || (job.unifiedJobId !== jobId && job.jobId !== jobId)) {
    throw new NotFoundError("Unified collection job not found for this case.");
  }

  const root = unifiedArtifactsDir(input.caseId, job.unifiedJobId);
  if (!existsSync(root)) {
    throw new NotFoundError("Unified job artifact directory not found.");
  }

  const zip = new JSZip();
  let includedCount = 0;
  let skippedBinaryCount = 0;
  let skippedOversizeCount = 0;

  // Always include a sanitized job snapshot from the case-level job.json if present.
  const caseJobPath = join(root, "..", "job.json");
  if (existsSync(caseJobPath)) {
    try {
      const raw = readFileSync(caseJobPath);
      const body = sanitizeFileContent(caseJobPath, raw);
      zip.file("job.json", body);
      includedCount += 1;
    } catch {
      /* ignore */
    }
  }

  for (const filePath of walkFiles(root)) {
    if (includedCount >= MAX_FILES) break;
    if (!isUnderDir(filePath, root) && filePath !== root) {
      // walk only under root; defensive
      if (!filePath.startsWith(root)) continue;
    }
    const ext = (() => {
      const base = basename(filePath).toLowerCase();
      const i = base.lastIndexOf(".");
      return i >= 0 ? base.slice(i) : "";
    })();
    if (BINARY_EXT.has(ext)) {
      skippedBinaryCount += 1;
      continue;
    }
    if (ext && !TEXT_EXT.has(ext)) {
      // Unknown extension — skip (fail-closed vs leaking binaries).
      skippedBinaryCount += 1;
      continue;
    }
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      skippedOversizeCount += 1;
      continue;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(filePath);
    } catch {
      continue;
    }
    const rel = relative(root, filePath).split(sep).join("/");
    zip.file(rel, sanitizeFileContent(filePath, raw));
    includedCount += 1;
  }

  zip.file(
    "bundle-manifest.json",
    `${JSON.stringify(
      redactDeep({
        version: "unified-diagnostics-bundle-v1",
        caseId: input.caseId,
        unifiedJobId: job.unifiedJobId,
        stage: job.stage,
        status: job.status,
        warnings: job.warnings ?? [],
        includedCount,
        skippedBinaryCount,
        skippedOversizeCount,
        generatedAt: new Date().toISOString(),
      }),
      null,
      2
    )}\n`
  );

  const zipBuffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const safeId = job.unifiedJobId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return {
    zipBuffer,
    fileName: `diagnostics-${safeId}.zip`,
    includedCount,
    skippedBinaryCount,
    skippedOversizeCount,
  };
}
