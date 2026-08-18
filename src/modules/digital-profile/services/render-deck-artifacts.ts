/**
 * Deck render adapter for the canonical prepare stage.
 *
 * Production/staging: HTTP to the existing Railway renderer `/orion/render-golden`
 * (same payload shape as local python / toRendererPayload). No silent fallback
 * to local spawn when an explicit renderer URL is configured.
 *
 * Local python spawn is opt-in only (ORION_CANONICAL_ALLOW_LOCAL_RENDER=1 or
 * ORION_GOLDEN_FORCE_LOCAL_RENDER=1) and is refused when HTTP URL is set.
 *
 * REMEDIATION §6.3 — GET /health with retries before POST; one POST retry on
 * network timeout. HTTP configured → never fall back to local python.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  toRendererPayload,
  type RendererAssetEntry,
} from "../orion-golden/deck-sections/run-deck-build";
import type { ReportDeckManifest } from "../orion-golden/deck-sections/contracts";
import type { RendererSlide } from "../orion-golden/deck-sections/deck-assembler";
import { digitalProfileConfig } from "../config";

/**
 * Имя файла телеметрии одно на оба пути рендера: локальный python пишет его
 * сам (`scripts/render-orion-golden-artifacts.py`), HTTP — здесь.
 */
export const LAYOUT_TELEMETRY_FILE = "layout-telemetry.json";

/**
 * Конечные имена клиентских документов — их знает и отдаёт на скачивание
 * `canonical-report-artifacts.ts`.
 */
const CLIENT_PPTX_FILE = "rendered-client.pptx";
const CLIENT_PDF_FILE = "rendered-client.pdf";

/**
 * Рендер пишет черновики, а конечные имена занимает только после суда.
 *
 * Иначе забракованный воротами документ уже лежит там, куда смотрят
 * `reportLinks`: пересборка ловит исключение, возвращает джобу в
 * `REPORT_READY` с прежними ссылками — и по кнопке скачивания уезжает дека с
 * потерянными карточками. Происхождение байтов проверка скачивания не знает и
 * знать не может, поэтому байты и не должны там оказываться.
 */
const PENDING_CLIENT_PPTX_FILE = "rendered-client.pending.pptx";
const PENDING_CLIENT_PDF_FILE = "rendered-client.pending.pdf";

export type DeckRenderInput = {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  subjectName: string;
  assets?: RendererAssetEntry[];
  /** Where PPTX/PDF/PNG/contact-sheet are written (job-scoped). */
  outputRoot: string;
};

export type DeckRenderResult = {
  pdf?: string;
  pptx?: string;
  pngDir?: string;
  contactSheet?: string;
  pageCount: number;
  renderer: string;
};

export type DeckRenderAdapter = (input: DeckRenderInput) => Promise<DeckRenderResult>;

type GoldenHttpResult = {
  slideCount: number;
  pptxBase64: string;
  pdfBase64: string;
  pages?: Array<{ pageNumber: number; contentBase64: string }>;
  pdfExportMode?: string;
  warnings?: string[];
  /** Renderer layout telemetry — the evidence the loss gate judges. */
  layoutTelemetry?: unknown;
};

export type HttpRenderDeps = {
  fetchImpl?: typeof fetch;
  rendererBaseUrl?: string;
  /** Injected sleep for offline §6.3 tests (default: real setTimeout). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Health attempt count (default 3). */
  healthAttempts?: number;
  /**
   * Backoff delays *between* failed health attempts (default [15_000, 45_000] —
   * sum 60s). Length should be healthAttempts - 1.
   */
  healthBackoffMs?: number[];
};

/** True when RENDERER_URL / DIGITAL_PROFILE_RENDERER_URL is explicitly set. */
export function isExplicitHttpRendererConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    String(env.RENDERER_URL ?? "").trim() ||
      String(env.DIGITAL_PROFILE_RENDERER_URL ?? "").trim()
  );
}

/** Opt-in local python only — never used when HTTP renderer URL is configured. */
export function isLocalPythonRenderAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isExplicitHttpRendererConfigured(env)) return false;
  const force =
    env.ORION_CANONICAL_ALLOW_LOCAL_RENDER === "1" ||
    env.ORION_GOLDEN_FORCE_LOCAL_RENDER === "1";
  return force;
}

/** Strip URLs, storage keys, and absolute paths from client-facing errors. */
export function sanitizeRendererClientError(message: string): string {
  let out = String(message ?? "");
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, "[renderer]");
  out = out.replace(/\bstorageKey[=:]\s*[^\s,;]+/gi, "storageKey=[redacted]");
  out = out.replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]");
  out = out.replace(/\/(?:app|var|tmp|home|Users)\/[^\s"'<>]+/g, "[path]");
  if (/ENOENT|spawnSync|spawn\s+python|python.*not found/i.test(out)) {
    return "Renderer service unavailable";
  }
  return out.slice(0, 240);
}

function writePayload(input: DeckRenderInput): {
  payload: Record<string, unknown>;
  payloadPath: string;
  pptxPath: string;
  pdfPath: string;
  pagesDir: string;
} {
  mkdirSync(input.outputRoot, { recursive: true });
  const payload = toRendererPayload({
    deckManifest: input.deckManifest,
    rendererSlides: input.rendererSlides,
    subjectName: input.subjectName,
    assets: input.assets,
  });
  const payloadPath = join(input.outputRoot, "render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
  const pptxPath = join(input.outputRoot, PENDING_CLIENT_PPTX_FILE);
  const pdfPath = join(input.outputRoot, PENDING_CLIENT_PDF_FILE);
  const pagesDir = join(input.outputRoot, "pages-png");
  if (existsSync(pagesDir)) rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });
  // Телеметрия и черновики прошлого рендера пережили бы неудачный или
  // неполный новый — и ворота осудили бы не тот документ, а публикация вынесла
  // бы под конечным именем прошлые байты.
  rmSync(join(input.outputRoot, LAYOUT_TELEMETRY_FILE), { force: true });
  rmSync(pptxPath, { force: true });
  rmSync(pdfPath, { force: true });
  return { payload, payloadPath, pptxPath, pdfPath, pagesDir };
}

function finishFromFiles(
  pptxPath: string,
  pdfPath: string,
  pagesDir: string,
  renderer: string
): DeckRenderResult {
  const contactSheet = join(pagesDir, "..", "contact-sheet.png");
  const pngPages = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length
    : 0;
  if (!existsSync(pptxPath) && !existsSync(pdfPath)) {
    throw new Error("renderer returned no PPTX/PDF artifacts");
  }
  return {
    pdf: existsSync(pdfPath) ? pdfPath : undefined,
    pptx: existsSync(pptxPath) ? pptxPath : undefined,
    pngDir: existsSync(pagesDir) ? pagesDir : undefined,
    contactSheet: existsSync(contactSheet) ? contactSheet : undefined,
    pageCount: pngPages,
    renderer,
  };
}

/**
 * Переносит клиентские документы под конечные имена. Зовётся подготовкой
 * отчёта после суда телеметрии — до него забракованный рендер не должен быть
 * скачиваемым (см. комментарий у `PENDING_CLIENT_PPTX_FILE`).
 */
export function publishRenderedClientArtifacts(
  outputRoot: string,
  rendered: DeckRenderResult
): DeckRenderResult {
  const move = (from: string | undefined, finalName: string): string | undefined => {
    if (!from) return undefined;
    const to = join(outputRoot, finalName);
    if (resolve(from) !== resolve(to)) renameSync(from, to);
    return to;
  };
  return {
    ...rendered,
    pptx: move(rendered.pptx, CLIENT_PPTX_FILE),
    pdf: move(rendered.pdf, CLIENT_PDF_FILE),
  };
}

const DEFAULT_HEALTH_BACKOFF_MS = [15_000, 45_000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /timeout|timed out|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|aborted/i.test(
    msg
  );
}

/**
 * REMEDIATION §6.3 — wait until GET /health returns 2xx (up to 3 attempts,
 * backoff totaling ≤60s by default).
 */
export async function waitForRendererHealth(
  baseUrl: string,
  deps: {
    fetchImpl?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    healthAttempts?: number;
    healthBackoffMs?: number[];
  } = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const attempts = Math.max(1, deps.healthAttempts ?? 3);
  const backoff = deps.healthBackoffMs ?? DEFAULT_HEALTH_BACKOFF_MS;
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/health`;
  let lastDetail = "unreachable";

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) {
      const delay = backoff[Math.min(i - 1, backoff.length - 1)] ?? 15_000;
      await sleepMs(delay);
    }
    try {
      const res = await fetchImpl(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      lastDetail = `HTTP ${res.status}`;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    sanitizeRendererClientError(
      `HTTP renderer health check failed after ${attempts} attempts: ${lastDetail}`
    )
  );
}

async function postGoldenRender(input: {
  url: string;
  payload: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  return input.fetchImpl(input.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.payload),
    signal: AbortSignal.timeout(300_000),
  });
}

/**
 * HTTP render via existing `/orion/render-golden`. Injectible fetch for offline tests.
 */
export async function renderDeckViaHttp(
  input: DeckRenderInput,
  deps?: HttpRenderDeps
): Promise<DeckRenderResult> {
  const { payload, pptxPath, pdfPath, pagesDir } = writePayload(input);
  const base = String(deps?.rendererBaseUrl ?? digitalProfileConfig.rendererUrl)
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    throw new Error("HTTP renderer URL is not configured");
  }
  const url = `${base}/orion/render-golden`;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  await waitForRendererHealth(base, {
    fetchImpl,
    sleepMs: deps?.sleepMs,
    healthAttempts: deps?.healthAttempts,
    healthBackoffMs: deps?.healthBackoffMs,
  });

  let res: Response;
  try {
    res = await postGoldenRender({ url, payload, fetchImpl });
  } catch (err) {
    if (!isNetworkTimeoutError(err)) {
      throw new Error(
        sanitizeRendererClientError(
          `HTTP renderer unreachable: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    // One retry — render is idempotent by payload (§6.3).
    try {
      res = await postGoldenRender({ url, payload, fetchImpl });
    } catch (err2) {
      throw new Error(
        sanitizeRendererClientError(
          `HTTP renderer unreachable: ${err2 instanceof Error ? err2.message : String(err2)}`
        )
      );
    }
  }
  if (!res.ok) {
    const body = sanitizeRendererClientError((await res.text().catch(() => "")).slice(0, 200));
    throw new Error(`HTTP renderer failed (${res.status})${body ? `: ${body}` : ""}`);
  }
  const json = (await res.json()) as GoldenHttpResult;
  if (!json.pptxBase64 && !json.pdfBase64) {
    throw new Error("HTTP renderer returned empty artifacts");
  }
  if (json.pptxBase64) {
    writeFileSync(pptxPath, Buffer.from(json.pptxBase64, "base64"));
  }
  if (json.pdfBase64) {
    writeFileSync(pdfPath, Buffer.from(json.pdfBase64, "base64"));
  }
  for (const page of json.pages ?? []) {
    writeFileSync(
      join(pagesDir, `page-${String(page.pageNumber).padStart(2, "0")}.png`),
      Buffer.from(page.contentBase64, "base64")
    );
  }
  // Транспорт не сочиняет: нет поля в ответе — нет файла на диске. Пустую
  // телеметрию ворота прочли бы как «проверено, потерь нет».
  if (json.layoutTelemetry) {
    writeFileSync(
      join(input.outputRoot, LAYOUT_TELEMETRY_FILE),
      JSON.stringify(json.layoutTelemetry, null, 2),
      "utf8"
    );
  }
  writeFileSync(
    join(input.outputRoot, "golden-render-meta.json"),
    JSON.stringify(
      {
        pdfExportMode: json.pdfExportMode ?? "unknown",
        slideCount: json.slideCount,
        warnings: json.warnings ?? [],
        via: "http",
      },
      null,
      2
    ),
    "utf8"
  );
  return finishFromFiles(pptxPath, pdfPath, pagesDir, "http:orion/render-golden");
}

/**
 * Local python spawn — opt-in only. Never call when HTTP URL is configured.
 */
export const renderDeckWithPython: DeckRenderAdapter = async (input) => {
  if (isExplicitHttpRendererConfigured()) {
    throw new Error(
      "local python render refused: explicit HTTP renderer URL is configured (no silent fallback)"
    );
  }
  const { payloadPath, pptxPath, pdfPath, pagesDir } = writePayload(input);
  try {
    execFileSync(
      "python",
      ["scripts/render-orion-golden-artifacts.py", payloadPath, pptxPath, pdfPath, pagesDir],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
    );
  } catch (err) {
    throw new Error(
      sanitizeRendererClientError(err instanceof Error ? err.message : String(err))
    );
  }
  const contactSheet = join(input.outputRoot, "contact-sheet.png");
  try {
    execFileSync(
      "python",
      ["-X", "utf8", "scripts/build-contact-sheet.py", pagesDir, contactSheet],
      { cwd: process.cwd(), encoding: "utf8" }
    );
  } catch {
    // contact sheet is diagnostic only
  }
  return finishFromFiles(pptxPath, pdfPath, pagesDir, "python:render-orion-golden-artifacts");
};

export type CanonicalRenderDeps = HttpRenderDeps;

/**
 * Default canonical adapter: HTTP when URL configured; else opt-in local python.
 * Never falls back from HTTP failure to local spawn.
 */
export function createCanonicalDeckRenderAdapter(
  deps: CanonicalRenderDeps = {}
): DeckRenderAdapter {
  return async (input) => {
    // Локальный python — только по явному требованию и только когда адрес
    // сервиса не передан вызывающим.
    if (!deps.rendererBaseUrl && isLocalPythonRenderAllowed()) {
      return renderDeckWithPython(input);
    }
    // Во всех прочих случаях — сервис по HTTP. Адрес рендерера всегда
    // разрешается (`digitalProfileConfig.rendererUrl`): на Railway это
    // внутреннее имя сервиса, локально — соседний порт.
    //
    // Раньше здесь спрашивали не то: «задана ли переменная явно» вместо «какой
    // адрес у рендерера». После переноса адреса в значения по умолчанию это
    // роняло сборку отчёта сообщением «Renderer not configured» при полностью
    // рабочей связке — тот же дефект, что и всюду в этом проекте: один вопрос,
    // два разных ответа в двух местах.
    return renderDeckViaHttp(input, deps);
  };
}

/** Production default used by canonical prepare when no adapter is injected. */
export const renderCanonicalDeck: DeckRenderAdapter = createCanonicalDeckRenderAdapter();
