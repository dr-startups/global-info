import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { COLORS, FONT_STACK, truncateToWidth } from "../../serp-snapshot/layout";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ImageGridItem = {
  title: string;
  domain: string;
  /**
   * Полученное превью. Обязательно: плитки-заглушки в отчёте больше нет, и
   * строка без картинки на сетку не попадает вовсе — вернуть её сюда можно
   * теперь только ошибкой компиляции, а не молча.
   */
  previewBase64: string;
  /** Undesirable / risk — red cell border in the grid PNG. */
  highlight?: boolean;
  /** v57: red solid | amber dashed | none */
  frameTone?: "red" | "amber" | "none";
  themeLabel?: string;
};

export type ImagePreviewFetchOptions = {
  /** Per-URL timeout (default 5000). */
  timeoutMs?: number;
  /** Max parallel fetches (default 4). */
  concurrency?: number;
  /** Wall-clock budget for the whole batch (default 30000). */
  budgetMs?: number;
  /** Disk cache directory (URL sha → base64 PNG). */
  cacheDir?: string;
  /** Injected fetch for offline tests. */
  fetchImpl?: typeof fetch;
  /**
   * Разрешена ли сеть. Кэш читается всегда — он не сеть, а уже купленная
   * работа: пересборка оплаченного прогона обязана получить свои превью с
   * диска. Явный `false` даёт отказ `offline` на каждый некэшированный адрес,
   * даже когда выборка подменена в тесте.
   */
  allowNetwork?: boolean;
  nowMs?: () => number;
  /**
   * Почему очередное превью не получено. Пустая плитка в отчёте должна быть
   * объяснима: без причины «источник не отдал изображение» неотличимо от
   * «мы не спросили».
   */
  onFailure?: (url: string, reason: PreviewFailureReason) => void;
};

/**
 * Где лежит превью этого адреса. Раскладка кэша названа один раз: её читают
 * выборка, запись и посев детерминированных превью в золотом кейсе.
 */
export function previewCachePath(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.b64`);
}

function readPreviewCache(cacheDir: string | undefined, url: string): string | undefined {
  if (!cacheDir) return undefined;
  const path = previewCachePath(cacheDir, url);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writePreviewCache(cacheDir: string | undefined, url: string, b64: string): void {
  if (!cacheDir || !b64) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(previewCachePath(cacheDir, url), b64, "utf8");
  } catch {
    // Cache is best-effort — never fail the grid.
  }
}

/**
 * Fetch one image preview. Disk cache first; without network permission →
 * `offline` refusal, no request. Failures never throw (§5.2).
 */
/**
 * Кто мы для чужого сервера.
 *
 * Запрос за картинкой уходил вовсе без `User-Agent`, и крупные площадки такие
 * запросы отклоняют: Викимедиа отвечает 403 без описательного агента, за ним —
 * CDN ТАСС и другие. В отчёте 72 из шести плиток на странице изображений три
 * были пустыми: Википедия, ТАСС, МГИМО. Представляемся честно, тем же именем,
 * что и читатель страниц, — и в буквах ASCII: кириллица в значении заголовка
 * роняет запрос ещё до отправки.
 */
/**
 * Потолок размера превью.
 *
 * Два мегабайта отсекали обычные снимки с современных сайтов: в отчёте 73 одна
 * плитка пустовала именно поэтому. Картинка всё равно сразу ужимается до
 * 320×200, поэтому потолок нужен только против явно аномальных файлов.
 */
const MAX_PREVIEW_BYTES = 8_000_000;

/**
 * Картинка, которую страница объявляет своей: `og:image` или `twitter:image`.
 *
 * Относительный адрес разворачивается по адресу самой страницы — иначе
 * «/img/cover.jpg» не запросить.
 */
export function openGraphImage(html: string, pageUrl: string): string | undefined {
  const m =
    html.match(
      /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*\scontent=["']([^"']+)["']/iu
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/iu
    );
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return undefined;
  }
}

export const PREVIEW_USER_AGENT =
  "DigitalProfileAudit/1.0 (+reputation audit; fetches public preview images)";

/** Почему превью не получено — строкой для разбора прогона, не для клиента. */
export type PreviewFailureReason =
  | "no_url"
  | "offline"
  /** Бюджет выборки исчерпан — до этого адреса очередь не дошла. */
  | "budget_exhausted"
  | `http_${number}`
  | "not_an_image"
  | "too_large"
  | "decode_failed"
  | "network";

export async function tryFetchImagePreview(
  url: string | undefined,
  opts?: Pick<
    ImagePreviewFetchOptions,
    "timeoutMs" | "fetchImpl" | "cacheDir" | "allowNetwork"
  > & {
    /** Причина отказа — чтобы пустая плитка не была немой. */
    onFailure?: (url: string, reason: PreviewFailureReason) => void;
    /** Глубина перехода по `og:image`; больше одного шага не делаем. */
    depth?: number;
  }
): Promise<string | undefined> {
  const depth = opts?.depth ?? 0;
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const fail = (reason: PreviewFailureReason): undefined => {
    opts?.onFailure?.(url, reason);
    return undefined;
  };
  const cached = readPreviewCache(opts?.cacheDir, url);
  if (cached) return cached;
  /*
   * Разрешение спрашивается один раз и здесь: запрет сети живёт в самой
   * выборке, а не в вызывающем коде, иначе кэш перестаёт читаться вместе с ней.
   *
   * Право вето — за окружением: `NETWORK_CALLS=0` это условие офлайн-контура,
   * и разрешение вызывающего его не перебивает. Подменённая выборка сетью не
   * является — на ней и держится офлайновый тест.
   */
  const envAllows = process.env.NETWORK_CALLS !== "0" || Boolean(opts?.fetchImpl);
  if (!envAllows || opts?.allowNetwork === false) return fail("offline");
  try {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": PREVIEW_USER_AGENT, accept: "image/*" },
    });
    clearTimeout(timeout);
    if (!res.ok) return fail(`http_${res.status}` as PreviewFailureReason);
    const type = String(res.headers?.get?.("content-type") ?? "");
    const buf = Buffer.from(await res.arrayBuffer());
    /*
     * Страница вместо картинки — не тупик.
     *
     * Часть площадок отдаёт по адресу изображения свою страницу-обёртку. Раньше
     * такой ответ просто отбрасывался, и плитка оставалась пустой. Страница
     * почти всегда объявляет собственную картинку в `og:image` — берём её, один
     * раз и без рекурсии.
     */
    if (type && !/^image\//i.test(type)) {
      if (!/html/i.test(type) || depth > 0) return fail("not_an_image");
      const declared = openGraphImage(buf.toString("utf8").slice(0, 512_000), url);
      if (!declared) return fail("not_an_image");
      return await tryFetchImagePreview(declared, { ...opts, depth: 1 });
    }
    if (buf.length > MAX_PREVIEW_BYTES) return fail("too_large");
    const png = await sharp(buf).rotate().resize(320, 200, { fit: "inside" }).png().toBuffer();
    const b64 = png.toString("base64");
    writePreviewCache(opts?.cacheDir, url, b64);
    return b64;
  } catch (err) {
    return fail(err instanceof Error && /decode|unsupported/i.test(err.message) ? "decode_failed" : "network");
  }
}

/**
 * REMEDIATION §5.2 — parallel preview fetch with concurrency + wall budget.
 * Returns a map url → base64 | undefined (undefined = row is not drawn).
 */
export async function fetchImagePreviewsWithBudget(
  urls: Array<string | undefined>,
  opts?: ImagePreviewFetchOptions
): Promise<Map<string, string | undefined>> {
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const budgetMs = opts?.budgetMs ?? 30_000;
  const now = opts?.nowMs ?? (() => Date.now());
  const started = now();
  const wanted = [...new Set(urls.filter((u): u is string => Boolean(u)))];
  const unique = wanted.filter((u) => /^https?:\/\//i.test(u));
  const out = new Map<string, string | undefined>();
  // Адрес, который не адрес, называется своей причиной. Пока он молча выпадал
  // из очереди, вызывающий не знал ничего и печатал «источник не отдал файл» —
  // отказ площадки там, где запроса не было.
  for (const url of wanted) {
    if (unique.includes(url)) continue;
    out.set(url, undefined);
    opts?.onFailure?.(url, "no_url");
  }
  let cursor = 0;

  const worker = async () => {
    while (cursor < unique.length) {
      if (now() - started >= budgetMs) break;
      const idx = cursor;
      cursor += 1;
      const url = unique[idx]!;
      if (out.has(url)) continue;
      out.set(
        url,
        await tryFetchImagePreview(url, {
          timeoutMs: opts?.timeoutMs,
          fetchImpl: opts?.fetchImpl,
          cacheDir: opts?.cacheDir,
          allowNetwork: opts?.allowNetwork,
          onFailure: opts?.onFailure,
        })
      );
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  // URLs skipped after budget → explicit undefined (row is not drawn).
  for (const url of unique) {
    if (out.has(url)) continue;
    out.set(url, undefined);
    opts?.onFailure?.(url, "budget_exhausted");
  }
  return out;
}

export function buildImageGridSvg(input: { title: string; items: ImageGridItem[] }): string {
  const width = 1200;
  const height = 680;
  const cols = 3;
  const cellW = 360;
  const cellH = 200;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<text x="40" y="48" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
  ];
  input.items.forEach((item, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 40 + col * (cellW + 16);
    const y = 80 + row * (cellH + 16);
    const tone = item.frameTone ?? (item.highlight ? "red" : "none");
    const stroke =
      tone === "red" ? COLORS.highlight : tone === "amber" ? COLORS.amber : COLORS.panelBorder;
    const strokeW = tone === "none" ? 1 : 4;
    const fill =
      tone === "red" ? COLORS.highlightFill : tone === "amber" ? COLORS.amberFill : COLORS.panel;
    const dash = tone === "amber" ? ` stroke-dasharray="8 5"` : "";
    parts.push(
      `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"${dash}/>`
    );
    if (item.previewBase64) {
      parts.push(
        `<image href="data:image/png;base64,${esc(item.previewBase64)}" x="${x + 8}" y="${y + 8}" width="${cellW - 16}" height="${cellH - 56}" preserveAspectRatio="xMidYMid meet"/>`
      );
    }
    if (tone === "red" || tone === "amber") {
      const badgeFill = tone === "red" ? COLORS.highlight : COLORS.amber;
      const badge = truncateToWidth(
        item.themeLabel || (tone === "amber" ? "Требует сверки" : "Нежелательное"),
        160,
        10
      );
      parts.push(
        `<rect x="${x + 8}" y="${y + 8}" width="${Math.min(200, cellW - 16)}" height="22" rx="4" fill="${badgeFill}"/>`,
        `<text x="${x + 14}" y="${y + 23}" font-family="${FONT_STACK}" font-size="10" fill="#ffffff">${esc(badge)}</text>`
      );
    }
    parts.push(
      `<text x="${x + 12}" y="${y + cellH - 28}" font-family="${FONT_STACK}" font-size="12" fill="${COLORS.text}">${esc(truncateToWidth(item.title, cellW - 24, 12))}</text>`
    );
    if (item.domain) {
      parts.push(
        `<text x="${x + 12}" y="${y + cellH - 12}" font-family="${FONT_STACK}" font-size="11" fill="${COLORS.urlGreen}">${esc(truncateToWidth(item.domain, cellW - 24, 11))}</text>`
      );
    }
  });
  parts.push("</svg>");
  return parts.join("");
}

export function buildKnowledgePanelSvg(input: {
  title: string;
  summary: string;
  facts: string[];
}): string {
  const width = 1200;
  const height = 420;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<rect x="40" y="40" width="1120" height="340" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}"/>`,
    `<text x="64" y="84" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
    `<text x="64" y="118" font-family="${FONT_STACK}" font-size="14" fill="${COLORS.muted}">${esc(truncateToWidth(input.summary, 1000, 14))}</text>`,
  ];
  input.facts.slice(0, 4).forEach((fact, idx) => {
    parts.push(
      `<text x="64" y="${160 + idx * 28}" font-family="${FONT_STACK}" font-size="13" fill="${COLORS.text}">• ${esc(truncateToWidth(fact, 900, 13))}</text>`
    );
  });
  parts.push("</svg>");
  return parts.join("");
}

/** Screenshot-like panel for suggestions / related queries (ORION surface visuals). */
export function buildSurfacePanelSvg(input: {
  title: string;
  subtitle?: string;
  engineLabel?: string;
  items: Array<{ label: string; meta?: string; adverse?: boolean }>;
}): string {
  const width = 1200;
  const height = 720;
  const items = input.items.slice(0, 10);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<rect x="32" y="28" width="1136" height="664" rx="10" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}"/>`,
    `<text x="56" y="72" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
  ];
  if (input.engineLabel) {
    parts.push(
      `<rect x="56" y="88" width="160" height="28" rx="6" fill="#E8EEF7"/>`,
      `<text x="68" y="108" font-family="${FONT_STACK}" font-size="13" fill="${COLORS.muted}">${esc(input.engineLabel)}</text>`
    );
  }
  if (input.subtitle) {
    parts.push(
      `<text x="56" y="140" font-family="${FONT_STACK}" font-size="13" fill="${COLORS.muted}">${esc(truncateToWidth(input.subtitle, 980, 13))}</text>`
    );
  }
  const startY = input.subtitle || input.engineLabel ? 168 : 120;
  items.forEach((item, idx) => {
    const y = startY + idx * 48;
    // ORION style: negative phrases (criminal/court/compromising wording) are
    // framed red with a tag so the client immediately sees which suggestions
    // are undesirable.
    if (item.adverse) {
      parts.push(
        `<rect x="56" y="${y}" width="1088" height="40" rx="6" fill="#FDF2F2" stroke="#C0392B" stroke-width="2"/>`,
        `<rect x="60" y="${y + 4}" width="6" height="32" rx="3" fill="#C0392B"/>`,
        `<text x="80" y="${y + 26}" font-family="${FONT_STACK}" font-size="15" fill="#7B241C">${esc(truncateToWidth(item.label, 760, 15))}</text>`,
        `<rect x="980" y="${y + 8}" width="150" height="24" rx="6" fill="#C0392B"/>`,
        `<text x="1055" y="${y + 25}" font-family="${FONT_STACK}" font-size="12" fill="#FFFFFF" text-anchor="middle">нежелательный</text>`
      );
      return;
    }
    parts.push(
      `<rect x="56" y="${y}" width="1088" height="40" rx="6" fill="#F7F9FC" stroke="${COLORS.panelBorder}"/>`,
      `<text x="72" y="${y + 26}" font-family="${FONT_STACK}" font-size="15" fill="${COLORS.text}">${esc(truncateToWidth(item.label, 820, 15))}</text>`
    );
    if (item.meta) {
      parts.push(
        `<text x="980" y="${y + 26}" font-family="${FONT_STACK}" font-size="12" fill="${COLORS.muted}" text-anchor="end">${esc(truncateToWidth(item.meta, 160, 12))}</text>`
      );
    }
  });
  if (items.length === 0) {
    parts.push(
      `<text x="56" y="${startY + 24}" font-family="${FONT_STACK}" font-size="14" fill="${COLORS.muted}">Нет сохранённых строк поверхности для этого слота</text>`
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

export async function svgToPngBase64(svg: string): Promise<string> {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}
