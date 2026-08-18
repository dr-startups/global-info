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

/**
 * Пропущенное называется поимённо, а не только считается.
 *
 * Молчаливый счётчик уже стоил неверного диагноза: по `skippedOversizeCount`
 * разбор живого прогона решил, что лимит 2 МБ «срезал» телеметрию рендерера, —
 * хотя на живом пути её тогда не было вовсе. Счётчик не отвечает на вопрос
 * «чего в бандле нет», а имя отвечает.
 */
type SkippedFiles = {
  oversize: Array<{ path: string; sizeBytes: number }>;
  binary: string[];
  /** Файлы, до которых дошёл обход, но не хватило места под потолком. */
  fileCap: string[];
  /** Увиденные обходом, но не прочитанные: исчезли, права, сбой диска. */
  unreadable: string[];
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

/**
 * Обход отдаёт размер вместе с путём: он уже измерен здесь, и второй `statSync`
 * в цикле сборки был вторым ответом на тот же вопрос — плюс ещё одним молчаливым
 * пропуском, если ответы расходились.
 */
function walkFiles(root: string): {
  files: Array<{ path: string; sizeBytes: number }>;
  truncated: boolean;
} {
  const out: Array<{ path: string; sizeBytes: number }> = [];
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
      if (st.isFile()) out.push({ path: full, sizeBytes: st.size });
    }
  }
  return { files: out, truncated: stack.length > 0 };
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

  const job = await loadUnifiedCollectionJob(input.caseId);
  if (!job || (job.unifiedJobId !== jobId && job.jobId !== jobId)) {
    throw new NotFoundError("Unified collection job not found for this case.");
  }

  const root = unifiedArtifactsDir(input.caseId, job.unifiedJobId);
  if (!existsSync(root)) {
    throw new NotFoundError("Unified job artifact directory not found.");
  }

  const zip = new JSZip();
  let includedCount = 0;
  const skipped: SkippedFiles = { oversize: [], binary: [], fileCap: [], unreadable: [] };

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

  const walked = walkFiles(root);
  // Потолок считается по обходу каталога: `job.json` лежит вне корня и входит
  // всегда, поэтому места в бюджете не занимает.
  let includedFromWalk = 0;
  for (const { path: filePath, sizeBytes } of walked.files) {
    if (!isUnderDir(filePath, root) && filePath !== root) {
      // walk only under root; defensive
      if (!filePath.startsWith(root)) continue;
    }
    const ext = (() => {
      const base = basename(filePath).toLowerCase();
      const i = base.lastIndexOf(".");
      return i >= 0 ? base.slice(i) : "";
    })();
    const rel = relative(root, filePath).split(sep).join("/");
    if (BINARY_EXT.has(ext)) {
      skipped.binary.push(rel);
      continue;
    }
    if (ext && !TEXT_EXT.has(ext)) {
      // Unknown extension — skip (fail-closed vs leaking binaries).
      skipped.binary.push(rel);
      continue;
    }
    if (sizeBytes > MAX_FILE_BYTES) {
      // Лимит защищает поддержку от base64-вложений в JSON (render-payload.json
      // и report-assets.json — около 3 МБ, почти целиком картинки), поэтому он
      // остаётся; молчать о пропуске нельзя.
      skipped.oversize.push({ path: rel, sizeBytes });
      continue;
    }
    // Учёт пропуска идёт до потолка, а не после: иначе остаток обхода не
    // попадал ни в зип, ни в списки, и счётчики отвечали неправду ровно на
    // вопрос, ради которого манифест и заводился.
    if (includedFromWalk >= MAX_FILES) {
      skipped.fileCap.push(rel);
      continue;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(filePath);
    } catch {
      // Файл виден обходом, но не прочитан (исчез между обходом и чтением,
      // права, сбой диска). Молчаливый пропуск сделал бы неполный бандл
      // неотличимым от полного — ровно так счётчик без имён однажды увёл разбор
      // блокера H3 не туда.
      skipped.unreadable.push(rel);
      continue;
    }
    zip.file(rel, sanitizeFileContent(filePath, raw));
    includedCount += 1;
    includedFromWalk += 1;
  }

  skipped.oversize.sort((a, b) => a.path.localeCompare(b.path));
  skipped.binary.sort((a, b) => a.localeCompare(b));
  skipped.fileCap.sort((a, b) => a.localeCompare(b));
  skipped.unreadable.sort((a, b) => a.localeCompare(b));
  // Достигнутый потолок перестаёт быть неотличимым от «всё вошло»: полный
  // бандл ровно на 400 файлов переполнением не является.
  const fileCapReached = skipped.fileCap.length > 0 || walked.truncated;

  zip.file(
    "bundle-manifest.json",
    `${JSON.stringify(
      redactDeep({
        version: "unified-diagnostics-bundle-v2",
        caseId: input.caseId,
        unifiedJobId: job.unifiedJobId,
        stage: job.stage,
        status: job.status,
        warnings: job.warnings ?? [],
        includedCount,
        skippedBinaryCount: skipped.binary.length,
        skippedOversizeCount: skipped.oversize.length,
        skippedBinary: skipped.binary,
        skippedOversize: skipped.oversize,
        skippedFileCap: skipped.fileCap,
        skippedUnreadableCount: skipped.unreadable.length,
        skippedUnreadable: skipped.unreadable,
        fileCapReached,
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
    skippedBinaryCount: skipped.binary.length,
    skippedOversizeCount: skipped.oversize.length,
  };
}
