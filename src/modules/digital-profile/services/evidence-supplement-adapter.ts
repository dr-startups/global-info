/**
 * §1.4 — WikipediaCheck + real SERP screenshots into the
 * canonical evidence / visual contour.
 *
 * Offline fixtures win over prisma (same pattern as complianceHits).
 */

import type { RawInventoryItem } from "../orion-golden/types";
import { loadFile } from "../storage/private-store";
import { MOCK_URL_PATTERN } from "./composite-serp-merge";

/** Freshness window for live SERP captures (§5.3 / §1.4). */
export const SERP_SCREENSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type WikipediaCheckInput = {
  id: string;
  exists: boolean;
  url?: string | null;
  language?: string | null;
  pageTitle?: string | null;
  lastChecked?: string | Date | null;
  /** e.g. "real:WIKIPEDIA" vs demo — prefer real when ranking. */
  checkedBy?: string | null;
  /**
   * Запрос, которым спрашивали языковой раздел. Страница проверки печатает его
   * дословно: «статья не найдена» верно ровно про тот запрос, который ушёл в
   * API. Поле поднимается из снимка ответа провайдера (`snapshot.raw.query`) —
   * где именно оно лежит, знает только этот модуль.
   */
  query?: string | null;
  /**
   * Полный плейнтекст найденной статьи (`prop=extracts&explaintext`) — вход
   * разбора по существу. Поднимается из снимка тем же правилом, что и запрос.
   */
  articleText?: string | null;
  /** Как статья нашлась: `search` или `langlink`. */
  foundVia?: string | null;
  /** Раздел-источник межъязыковой ссылки, по которой найдена эта статья. */
  langlinkOf?: { language?: string | null; title?: string | null } | null;
  /** Снимок ответа провайдера, как его записал агент проверки. */
  snapshot?: unknown;
};

/**
 * Поля записи, которые лежат в снимке ответа провайдера.
 *
 * Где именно они лежат (`snapshot.raw.*`), знает только этот модуль: страница,
 * разбор и индекс доказательств читают уже поля записи. Явно заданное поле
 * снимком не переписывается — офлайн-фикстура задаёт их напрямую и снимка не
 * несёт.
 */
function snapshotString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function withWikipediaSnapshotFields(row: WikipediaCheckInput): WikipediaCheckInput {
  const raw = (row.snapshot as { raw?: Record<string, unknown> } | null)?.raw ?? {};
  const langlink = raw.langlinkOf as { language?: string; title?: string } | undefined;
  return {
    ...row,
    query: row.query ?? snapshotString(raw.query),
    articleText: row.articleText ?? snapshotString(raw.articleText),
    foundVia: row.foundVia ?? snapshotString(raw.foundVia),
    langlinkOf: row.langlinkOf ?? (langlink?.language && langlink?.title ? langlink : null),
  };
}

/**
 * Идентификатор материала записи проверки — одна форма на весь проект.
 *
 * Её строят адаптер, загрузчик входов деки и стадия разбора; разъехавшись, они
 * не сломали бы ни один тип — страница просто замолчала бы о разборе.
 */
export function wikipediaCheckInventoryId(id: string): string {
  return `wiki-${id}`;
}

/** Resolved screenshot ready to bind into p10 / p27. */
export type RealSerpScreenshotInput = {
  id: string;
  region: "RU" | "UAE" | string;
  engine?: "YANDEX" | "GOOGLE" | string | null;
  /** PNG/JPEG base64 (no data: prefix). */
  imageData: string;
  capturedAt?: string | null;
  evidenceRefs?: string[];
  caption?: string | null;
  title?: string | null;
  /** Fixture path helper — filled by loader before resolve. */
  storageKey?: string | null;
};

export type EvidenceSupplementBundle = {
  version: "evidence-supplement-v1";
  caseId: string;
  wikipediaChecks: WikipediaCheckInput[];
  serpScreenshots: RealSerpScreenshotInput[];
};

export type EvidenceSupplementPrisma = {
  wikipediaCheck?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<WikipediaCheckInput[]>;
  };
  serpCapture?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<
      Array<{
        id: string;
        region: string;
        engine: string;
        storageKey?: string | null;
        captureStatus: string;
        capturedAt?: Date | string | null;
        query?: string | null;
      }>
    >;
  };
};

function regionBucket(raw: string | undefined | null): "RU" | "UAE" {
  const r = String(raw ?? "").toUpperCase();
  return /UAE|AE|INTL|EN|GLOBAL/.test(r) ? "UAE" : "RU";
}

function languageToRegion(language: string | null | undefined): "RU" | "UAE" {
  const l = String(language ?? "en").toLowerCase();
  if (l === "ru" || l.startsWith("ru-")) return "RU";
  return "UAE";
}

/**
 * Fail-closed guard: WikipediaCheck rows written by mock/demo agents
 * (checkedBy "mock:*" or reserved test domains like `.example`) must never
 * reach the evidence contour — they previously leaked into client source
 * lines as `en.wikipedia-mock.example`.
 */
export function isMockWikipediaCheck(row: Pick<WikipediaCheckInput, "url" | "checkedBy">): boolean {
  if (/mock|demo|fixture/i.test(String(row.checkedBy ?? ""))) return true;
  return MOCK_URL_PATTERN.test(String(row.url ?? ""));
}

function isFresh(capturedAt: string | Date | null | undefined, nowMs: number): boolean {
  if (!capturedAt) return true; // fixture without timestamp — treat as fresh
  const t = capturedAt instanceof Date ? capturedAt.getTime() : new Date(capturedAt).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t <= SERP_SCREENSHOT_MAX_AGE_MS;
}

export function adaptWikipediaCheckToInventoryItem(input: {
  row: WikipediaCheckInput;
  caseId: string;
  reportRunId: string;
}): RawInventoryItem {
  const { row, caseId, reportRunId } = input;
  const region = languageToRegion(row.language);
  const title =
    String(row.pageTitle ?? "").trim() ||
    (row.exists
      ? `Wikipedia (${row.language ?? "en"}): статья найдена`
      : `Wikipedia (${row.language ?? "en"}): статья не найдена`);
  return {
    inventoryId: wikipediaCheckInventoryId(row.id),
    caseId,
    reportRunId,
    source: "wikipedia_check",
    provider: "wikipedia",
    region,
    collectedAt:
      row.lastChecked instanceof Date
        ? row.lastChecked.toISOString()
        : String(row.lastChecked ?? new Date(0).toISOString()),
    evidenceType: "wikipedia_check",
    title,
    snippet: row.exists
      ? "Фактическая проверка Wikipedia: статья существует."
      : "Фактическая проверка Wikipedia: статья не найдена.",
    sourceUrl: row.url ?? undefined,
    classification: row.exists ? "SUBJECT_MATCH" : "NOT_FOUND",
    /*
     * Принадлежность найденной статьи здесь не решается.
     *
     * До 20.08.2026 адаптер ставил каждой записи `identityFromReview: true` и
     * `reviewStatus: exists ? "MATCH_CONFIRMED" : "PENDING"`, а классификатор
     * по этой мете отдавал `SUBJECT_MATCH @0.95`. То есть «принадлежность
     * подтверждена» выводилась из того же `exists`, который она обязана
     * проверять: на живом кейсе так подтверждалась статья о дворянском роде, а
     * ветка тёзки была недостижима при живых юнитах. Решает классификатор по
     * тексту заголовка; статья межъязыковой ссылки наследует решение
     * статьи-источника — это та же сущность, и двух ответов о ней быть не может.
     */
    rawMetadata: {
      surface: "wikipedia",
      wikipediaExists: row.exists,
      language: row.language ?? undefined,
      pageTitle: row.pageTitle ?? undefined,
      ...(row.foundVia === "langlink" && row.langlinkOf?.language
        ? { identityFromLanglink: { sourceLanguage: String(row.langlinkOf.language) } }
        : {}),
      evidenceRefs: [`wikipediaCheck:${row.id}`],
    },
  };
}

export function adaptWikipediaChecksToInventory(input: {
  rows: WikipediaCheckInput[];
  caseId: string;
  reportRunId: string;
}): RawInventoryItem[] {
  return input.rows.map((row) =>
    adaptWikipediaCheckToInventoryItem({
      row,
      caseId: input.caseId,
      reportRunId: input.reportRunId,
    })
  );
}

/**
 * Pick the best fresh real screenshot for a region.
 * Prefer YANDEX for RU, GOOGLE for UAE when multiple candidates exist.
 */
export function pickRealSerpScreenshot(
  assets: RealSerpScreenshotInput[],
  region: "RU" | "UAE",
  opts?: { nowMs?: number; maxAgeMs?: number }
): RealSerpScreenshotInput | null {
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? SERP_SCREENSHOT_MAX_AGE_MS;
  const preferredEngine = region === "RU" ? "YANDEX" : "GOOGLE";
  const candidates = assets.filter((a) => {
    if (regionBucket(a.region) !== region) return false;
    if (!a.imageData || a.imageData.length < 80) return false;
    if (!isFresh(a.capturedAt ?? null, nowMs)) return false;
    // Re-check age with custom window
    if (a.capturedAt) {
      const t = new Date(a.capturedAt).getTime();
      if (!Number.isNaN(t) && nowMs - t > maxAgeMs) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;
  const preferred = candidates.find(
    (c) => String(c.engine ?? "").toUpperCase() === preferredEngine
  );
  return preferred ?? candidates[0]!;
}

export async function loadWikipediaChecksFromPrisma(input: {
  prisma: EvidenceSupplementPrisma;
  caseId: string;
}): Promise<WikipediaCheckInput[]> {
  if (!input.prisma.wikipediaCheck) return [];
  const rows = await input.prisma.wikipediaCheck.findMany({
    where: { caseId: input.caseId },
    orderBy: [{ lastChecked: "desc" }],
  });
  // Prefer real checks, then exists=true, keep stable order otherwise.
  return [...rows]
    .sort((a, b) => {
      const realA = String(a.checkedBy ?? "").startsWith("real") ? 1 : 0;
      const realB = String(b.checkedBy ?? "").startsWith("real") ? 1 : 0;
      if (realA !== realB) return realB - realA;
      if (Boolean(a.exists) !== Boolean(b.exists)) return a.exists ? -1 : 1;
      return 0;
    })
    .map(withWikipediaSnapshotFields);
}

export async function loadSerpScreenshotsFromPrisma(input: {
  prisma: EvidenceSupplementPrisma;
  caseId: string;
  nowMs?: number;
}): Promise<RealSerpScreenshotInput[]> {
  if (!input.prisma.serpCapture) return [];
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - SERP_SCREENSHOT_MAX_AGE_MS);
  const rows = await input.prisma.serpCapture.findMany({
    where: {
      caseId: input.caseId,
      captureStatus: "READY",
      storageKey: { not: null },
      capturedAt: { gte: cutoff },
    },
    orderBy: [{ capturedAt: "desc" }],
  });
  const out: RealSerpScreenshotInput[] = [];
  for (const row of rows) {
    if (!row.storageKey) continue;
    try {
      const buf = await loadFile(row.storageKey);
      if (buf.length < 80) continue;
      out.push({
        id: row.id,
        region: regionBucket(row.region),
        engine: String(row.engine ?? "").toUpperCase(),
        imageData: buf.toString("base64"),
        capturedAt:
          row.capturedAt instanceof Date
            ? row.capturedAt.toISOString()
            : row.capturedAt
              ? String(row.capturedAt)
              : null,
        evidenceRefs: [`serp_capture:${row.id}`],
        title:
          regionBucket(row.region) === "UAE"
            ? "ОАЭ — снимок выдачи (LIVE)"
            : "Россия — снимок выдачи (LIVE)",
        caption: `Реальный снимок выдачи${row.query ? `: ${row.query}` : ""}`,
        storageKey: row.storageKey,
      });
    } catch {
      // Missing file — skip; synthetic path remains.
    }
  }
  return out;
}

export async function resolveEvidenceSupplement(input: {
  caseId: string;
  reportRunId: string;
  /** Offline fixture wins. */
  fixture?: EvidenceSupplementBundle | null;
  prisma?: EvidenceSupplementPrisma | null;
  nowMs?: number;
}): Promise<{
  wikipediaItems: RawInventoryItem[];
  serpScreenshots: RealSerpScreenshotInput[];
  bundle: EvidenceSupplementBundle;
}> {
  let wikipediaChecks: WikipediaCheckInput[] = [];
  let serpScreenshots: RealSerpScreenshotInput[] = [];

  if (input.fixture != null) {
    wikipediaChecks = input.fixture.wikipediaChecks ?? [];
    serpScreenshots = (input.fixture.serpScreenshots ?? []).filter(
      (s) => s.imageData && s.imageData.length >= 80
    );
  } else if (input.prisma) {
    wikipediaChecks = await loadWikipediaChecksFromPrisma({
      prisma: input.prisma,
      caseId: input.caseId,
    });
    serpScreenshots = await loadSerpScreenshotsFromPrisma({
      prisma: input.prisma,
      caseId: input.caseId,
      nowMs: input.nowMs,
    });
  }

  // Fail-closed regardless of source (fixture or prisma): mock-era checks
  // never enter inventory, evidence-supplement.json or slide source lines.
  // Поля снимка разворачиваются один раз здесь: обе дороги — фикстура и база —
  // обязаны дать записи одной формы.
  wikipediaChecks = wikipediaChecks
    .filter((w) => !isMockWikipediaCheck(w))
    .map(withWikipediaSnapshotFields);

  const wikipediaItems = adaptWikipediaChecksToInventory({
    rows: wikipediaChecks,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
  });

  return {
    wikipediaItems,
    serpScreenshots,
    bundle: {
      version: "evidence-supplement-v1",
      caseId: input.caseId,
      wikipediaChecks,
      // Persist metadata without huge base64 in analytics when possible —
      // keep imageData for offline fixture replay (golden case).
      serpScreenshots: serpScreenshots.map((s) => ({
        ...s,
        imageData: s.imageData,
      })),
    },
  };
}
