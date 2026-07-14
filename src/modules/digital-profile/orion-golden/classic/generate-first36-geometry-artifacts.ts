/**
 * First36 post-render geometry + contact-sheet artifacts (inspector v2).
 * Role-aware PPTX QA — never treats intentional background/card containment as CRITICAL.
 * Never invents an empty PASS when measurement is uncertain.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { ORION_FIRST36_REGISTRY_V1 } from "./orion-first36-registry.v1";

export type GeometrySeverity = "PASS" | "WARNING" | "CRITICAL" | "BLOCKER";

export const GEOMETRY_INSPECTOR_VERSION = "first36-geometry-v2";

export type GeometryIssue = {
  page: number;
  detail: string;
  code?: string;
  severity?: GeometrySeverity;
  role?: string;
  shapeId?: number;
  shapeIds?: number[];
};

export type GeometryShapeMeta = {
  page: number;
  id: number;
  name: string;
  type: string;
  role: string;
  bbox: { x: number; y: number; cx: number; cy: number };
  zOrder: number;
  hasText: boolean;
  textLength: number;
};

export type First36GeometryReport = {
  inspectorVersion: string;
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
  clipping: GeometryIssue[];
  blank: GeometryIssue[];
  missingAssets: GeometryIssue[];
  emptyContent: GeometryIssue[];
  emptyPages: GeometryIssue[];
  shapes: GeometryShapeMeta[];
  pages: Array<{ page: number; issues: GeometryIssue[]; shapes?: GeometryShapeMeta[] }>;
  summary: {
    issueCount: number;
    severity: GeometrySeverity;
    pageCount: number;
    bySeverity: Record<GeometrySeverity, number>;
  };
  inspectorError?: string | null;
  source: {
    pptx?: string;
    pagesPngDir?: string;
    pythonInspector?: string;
    layoutTelemetry?: string;
    fixture?: string;
  };
};

const TINY_PNG_BYTES = 2500;
export const SLIDE_W = 11_704_320;
export const SLIDE_H = 7_315_200;
export const FOOTER_Y = SLIDE_H - 440_000;
export const CONTENT_BOTTOM = SLIDE_H - 700_000;
export const FOOTER_ZONE_TOP = FOOTER_Y - 40_000;
export const TEXT_COLLISION_RATIO = 0.12;
export const CONTAINMENT_RATIO = 0.85;
export const BACKGROUND_AREA_RATIO = 0.88;
export const DECORATIVE_MAX_THICKNESS = 80_000;

export type ShapeRole =
  | "background"
  | "border"
  | "container"
  | "image"
  | "text"
  | "table"
  | "footer"
  | "decorative";

export type InspectableShape = {
  id: number;
  name: string;
  type?: string;
  role: ShapeRole;
  bbox: { x: number; y: number; cx: number; cy: number };
  zOrder?: number;
  hasText?: boolean;
  textLength?: number;
};

function area(b: InspectableShape["bbox"]): number {
  return Math.max(0, b.cx) * Math.max(0, b.cy);
}

function intersectArea(a: InspectableShape["bbox"], b: InspectableShape["bbox"]): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.cx, b.x + b.cx);
  const y1 = Math.min(a.y + a.cy, b.y + b.cy);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function contained(inner: InspectableShape["bbox"], outer: InspectableShape["bbox"]): boolean {
  const ia = area(inner);
  if (ia <= 0) return false;
  return intersectArea(inner, outer) / ia >= CONTAINMENT_RATIO;
}

function outOfBounds(b: InspectableShape["bbox"], margin = 20_000): boolean {
  return b.x < -margin || b.y < -margin || b.x + b.cx > SLIDE_W + margin || b.y + b.cy > SLIDE_H + margin;
}

function ignorePair(a: InspectableShape, b: InspectableShape): boolean {
  const ignoreRoles = new Set(["background", "border", "decorative", "footer"]);
  if (ignoreRoles.has(a.role) || ignoreRoles.has(b.role)) return true;
  for (const [inner, outer] of [
    [a, b],
    [b, a],
  ] as const) {
    if (
      (outer.role === "container" || outer.role === "background") &&
      (inner.role === "text" || inner.role === "image" || inner.role === "table" || inner.role === "container")
    ) {
      if (outer.role === "background" || contained(inner.bbox, outer.bbox)) return true;
    }
  }
  return false;
}

/** Classify a shape from bbox + text signals (unit-testable). */
export function classifyShapeRole(input: {
  name?: string;
  hasText?: boolean;
  textLength?: number;
  bbox: { x: number; y: number; cx: number; cy: number };
  isPicture?: boolean;
  isTable?: boolean;
  isLine?: boolean;
}): ShapeRole {
  const name = (input.name ?? "").toLowerCase();
  if (name.includes("footer") || name.includes("orion_footer")) return "footer";
  if (name.includes("background") || name.includes("orion_bg")) return "background";
  if (name.includes("border") || name.includes("decor") || name.includes("orion_decor")) return "decorative";
  if (name.includes("card") || name.includes("container") || name.includes("orion_card")) return "container";
  if (name.includes("table") || name.includes("orion_table") || input.isTable) return "table";
  if (name.includes("image") || name.includes("picture") || name.includes("orion_img") || input.isPicture) {
    return "image";
  }
  if (input.isLine) return "decorative";

  const { bbox } = input;
  const hasText = Boolean(input.hasText || (input.textLength ?? 0) > 0);
  const textLength = input.textLength ?? 0;
  const slideArea = SLIDE_W * SLIDE_H;
  const a = area(bbox);

  if (bbox.y >= FOOTER_ZONE_TOP && bbox.cy < 500_000) return "footer";
  if (bbox.cx <= DECORATIVE_MAX_THICKNESS || bbox.cy <= DECORATIVE_MAX_THICKNESS) return "decorative";
  if (a >= slideArea * BACKGROUND_AREA_RATIO && !hasText) return "background";
  if (hasText) {
    if (bbox.y >= FOOTER_ZONE_TOP && textLength < 24) return "footer";
    return "text";
  }
  if (a >= slideArea * 0.05) return "container";
  return "decorative";
}

/** Pure role-aware geometry inspection for unit tests / fixtures. */
export function inspectRoleAwareShapes(
  shapes: InspectableShape[],
  page: number
): { overlaps: GeometryIssue[]; overflow: GeometryIssue[]; emptyPages: GeometryIssue[] } {
  const overlaps: GeometryIssue[] = [];
  const overflow: GeometryIssue[] = [];
  const emptyPages: GeometryIssue[] = [];

  const meaningful = shapes.filter(
    (s) =>
      (s.role === "text" && (s.textLength ?? 0) >= 8) || s.role === "image" || s.role === "table"
  );
  if (!meaningful.length) {
    emptyPages.push({
      page,
      code: "empty-page",
      severity: "CRITICAL",
      detail: "page has no meaningful text/image/table content",
    });
  }

  for (const s of shapes) {
    if (s.role === "background" || s.role === "decorative" || s.role === "border" || s.role === "footer") {
      continue;
    }
    if (outOfBounds(s.bbox)) {
      overflow.push({
        page,
        code: "out-of-bounds",
        severity: "CRITICAL",
        role: s.role,
        shapeId: s.id,
        detail: `content shape '${s.name}' role=${s.role} exceeds slide bounds`,
      });
    }
  }

  const texts = shapes.filter((s) => s.role === "text");
  const images = shapes.filter((s) => s.role === "image" || s.role === "table");
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (ignorePair(a, b)) continue;
      const ia = intersectArea(a.bbox, b.bbox);
      if (ia <= 0) continue;
      const minA = Math.min(area(a.bbox), area(b.bbox));
      const ratio = minA ? ia / minA : 0;
      if (ratio >= TEXT_COLLISION_RATIO) {
        overlaps.push({
          page,
          code: "text-text-collision",
          severity: "CRITICAL",
          shapeIds: [a.id, b.id],
          detail: `text-text collision ratio=${ratio.toFixed(2)} '${a.name}' vs '${b.name}'`,
        });
      }
    }
  }

  for (const t of texts) {
    for (const img of images) {
      if (ignorePair(t, img)) continue;
      const ia = intersectArea(t.bbox, img.bbox);
      if (ia <= 0) continue;
      const tMid = t.bbox.y + t.bbox.cy / 2;
      const imgBottom = img.bbox.y + img.bbox.cy;
      if (tMid >= imgBottom - 80_000) continue;
      const minA = Math.min(area(t.bbox), area(img.bbox));
      const ratio = minA ? ia / minA : 0;
      if (ratio >= 0.08) {
        overlaps.push({
          page,
          code: "text-over-image",
          severity: "CRITICAL",
          shapeIds: [t.id, img.id],
          detail: `text '${t.name}' overlaps ${img.role} '${img.name}' ratio=${ratio.toFixed(2)}`,
        });
      }
    }
  }

  return { overlaps, overflow, emptyPages };
}

/**
 * @deprecated Prefer inspectRoleAwareShapes. Kept for callers that feed raw EMU XML;
 * classifies heuristically without names (background-sized boxes ignored).
 */
export function inspectSlideXmlGeometry(
  xml: string,
  page: number
): { overlaps: GeometryIssue[]; overflow: GeometryIssue[]; emptyPages?: GeometryIssue[] } {
  const boxes: Array<{ x: number; y: number; cx: number; cy: number }> = [];
  const re = /<a:off x="(\d+)" y="(\d+)"[^/]*\/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    boxes.push({
      x: Number(m[1]),
      y: Number(m[2]),
      cx: Number(m[3]),
      cy: Number(m[4]),
    });
  }
  const shapes: InspectableShape[] = boxes.map((bbox, id) => {
    const role = classifyShapeRole({
      name: `xml_${id}`,
      bbox,
      hasText: bbox.cy < SLIDE_H * 0.5 && bbox.cx < SLIDE_W * 0.95,
      textLength: bbox.cy < SLIDE_H * 0.5 ? 40 : 0,
    });
    // Heuristic: large box without "text-like" size → background/container
    const slideArea = SLIDE_W * SLIDE_H;
    let finalRole = role;
    if (area(bbox) >= slideArea * BACKGROUND_AREA_RATIO) finalRole = "background";
    else if (area(bbox) >= slideArea * 0.05 && bbox.cy > 400_000 && !finalRole) finalRole = "container";
    return {
      id,
      name: `xml_${id}`,
      role: finalRole,
      bbox,
      hasText: finalRole === "text",
      textLength: finalRole === "text" ? 40 : 0,
    };
  });
  return inspectRoleAwareShapes(shapes, page);
}

export function listFirst36PagePngs(pagesPngDir: string): string[] {
  if (!existsSync(pagesPngDir)) return [];
  return readdirSync(pagesPngDir)
    .filter((name) => /\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function inspectBlankPagePngs(pagesPngDir: string): GeometryIssue[] {
  const files = listFirst36PagePngs(pagesPngDir);
  const issues: GeometryIssue[] = [];
  if (files.length !== 36) {
    issues.push({
      page: 0,
      code: "png-count",
      severity: "BLOCKER",
      detail: `expected 36 PNGs, found ${files.length}`,
    });
  }
  files.forEach((name, idx) => {
    const size = statSync(join(pagesPngDir, name)).size;
    if (size < TINY_PNG_BYTES) {
      issues.push({
        page: idx + 1,
        code: "blank-png",
        severity: "CRITICAL",
        detail: `tiny/blank png bytes=${size} file=${name}`,
      });
    }
  });
  return issues;
}

export function inspectDeckEmptyContent(
  slides: Array<{ pageNumber: number; title?: string; narrative?: string; bullets?: string[]; clientTakeaway?: string }>
): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  for (const slide of slides) {
    const blob = [slide.title, slide.narrative, ...(slide.bullets ?? []), slide.clientTakeaway]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!blob || blob.length < 8) {
      issues.push({
        page: slide.pageNumber,
        code: "empty-content",
        severity: "CRITICAL",
        detail: "empty or near-empty client content block",
      });
    }
  }
  return issues;
}

/** Resolve requiredVisual from ORION_FIRST36_REGISTRY_V1 by page/slotId — not finalSlide.requiredVisual alone. */
export function resolveRequiredVisualForSlide(slide: {
  pageNumber: number;
  slideKey?: string;
  slotId?: string;
  requiredVisual?: boolean;
}): boolean {
  if (typeof slide.requiredVisual === "boolean") return slide.requiredVisual;
  const slotId = slide.slotId ?? slide.slideKey;
  const bySlot = ORION_FIRST36_REGISTRY_V1.find((s) => s.slotId === slotId);
  if (bySlot) return bySlot.requiredVisual;
  const byPage = ORION_FIRST36_REGISTRY_V1.find((s) => s.page === slide.pageNumber);
  return byPage?.requiredVisual ?? false;
}

export function inspectMissingVisualAssets(
  slides: Array<{
    pageNumber: number;
    slideKey?: string;
    slotId?: string;
    assetRefs?: string[];
    requiredVisual?: boolean;
  }>,
  assets: Array<{ assetRef: string; status?: string }>
): GeometryIssue[] {
  const byRef = new Map(assets.map((a) => [a.assetRef, a]));
  const issues: GeometryIssue[] = [];
  for (const slide of slides) {
    if (!resolveRequiredVisualForSlide(slide)) continue;
    const refs = slide.assetRefs ?? [];
    if (refs.length === 0) {
      issues.push({
        page: slide.pageNumber,
        code: "missing-asset",
        severity: "BLOCKER",
        detail: "required visual slide has no assetRefs",
      });
      continue;
    }
    for (const ref of refs) {
      const asset = byRef.get(ref);
      if (!asset || asset.status !== "ready") {
        issues.push({
          page: slide.pageNumber,
          code: "missing-asset",
          severity: "BLOCKER",
          detail: `missing/unready asset ${ref}`,
        });
      }
    }
  }
  return issues;
}

export function inspectLayoutTelemetry(telemetryPath: string | null | undefined): GeometryIssue[] {
  if (!telemetryPath || !existsSync(telemetryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(telemetryPath, "utf-8")) as {
      entries?: Array<Record<string, unknown>>;
      textBoxes?: Array<Record<string, unknown>>;
    };
    const rows = raw.entries ?? raw.textBoxes ?? [];
    const issues: GeometryIssue[] = [];
    for (const row of rows) {
      if (row.clipped === true) {
        issues.push({
          page: Number(row.page ?? 0),
          code: "text-clipping",
          severity: "CRITICAL",
          detail: `text clipping requiredHeight=${row.requiredHeight} availableHeight=${row.availableHeight} name=${row.name ?? row.role ?? ""}`,
        });
      } else if (row.measurementUncertain === true) {
        issues.push({
          page: Number(row.page ?? 0),
          code: "text-measurement-uncertain",
          severity: "WARNING",
          detail: "font measurement unavailable; clipping not proven",
        });
      }
    }
    return issues;
  } catch (err) {
    return [
      {
        page: 0,
        code: "telemetry-read-error",
        severity: "WARNING",
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

export function summarizeGeometrySeverity(issues: GeometryIssue[]): GeometrySeverity {
  if (issues.some((i) => i.severity === "BLOCKER")) return "BLOCKER";
  if (issues.some((i) => i.severity === "CRITICAL")) return "CRITICAL";
  if (issues.some((i) => i.severity === "WARNING")) return "WARNING";
  return "PASS";
}

function countBySeverity(issues: GeometryIssue[]): Record<GeometrySeverity, number> {
  const out: Record<GeometrySeverity, number> = { PASS: 0, WARNING: 0, CRITICAL: 0, BLOCKER: 0 };
  for (const i of issues) {
    const s = i.severity ?? "CRITICAL";
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

export function buildGeometryReportFromParts(input: {
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
  blank: GeometryIssue[];
  clipping?: GeometryIssue[];
  missingAssets?: GeometryIssue[];
  emptyContent?: GeometryIssue[];
  emptyPages?: GeometryIssue[];
  shapes?: GeometryShapeMeta[];
  pageShapes?: Array<{ page: number; shapes: GeometryShapeMeta[] }>;
  inspectorError?: string | null;
  source?: First36GeometryReport["source"];
  pageCount?: number;
  inspectorVersion?: string;
}): First36GeometryReport {
  const missingAssets = input.missingAssets ?? [];
  const emptyContent = input.emptyContent ?? [];
  const emptyPages = input.emptyPages ?? [];
  const clipping = input.clipping ?? [];
  const all = [
    ...input.overlaps,
    ...input.overflow,
    ...input.blank,
    ...clipping,
    ...missingAssets,
    ...emptyContent,
    ...emptyPages,
  ];
  if (input.inspectorError) {
    all.push({
      page: 0,
      code: "inspector-error",
      severity: "BLOCKER",
      detail: input.inspectorError,
    });
  }
  const byPage = new Map<number, GeometryIssue[]>();
  for (const issue of all) {
    byPage.set(issue.page, [...(byPage.get(issue.page) ?? []), issue]);
  }
  const shapeByPage = new Map<number, GeometryShapeMeta[]>();
  for (const s of input.shapes ?? []) {
    shapeByPage.set(s.page, [...(shapeByPage.get(s.page) ?? []), s]);
  }
  for (const p of input.pageShapes ?? []) {
    shapeByPage.set(p.page, p.shapes);
  }
  const pages = [...new Set([...byPage.keys(), ...shapeByPage.keys()])]
    .sort((a, b) => a - b)
    .map((page) => ({
      page,
      issues: byPage.get(page) ?? [],
      shapes: shapeByPage.get(page),
    }));
  return {
    inspectorVersion: input.inspectorVersion ?? GEOMETRY_INSPECTOR_VERSION,
    overlaps: input.overlaps,
    overflow: input.overflow,
    clipping,
    blank: input.blank,
    missingAssets,
    emptyContent,
    emptyPages,
    shapes: input.shapes ?? [],
    pages,
    summary: {
      issueCount: all.length,
      severity: summarizeGeometrySeverity(all),
      pageCount: input.pageCount ?? 36,
      bySeverity: countBySeverity(all),
    },
    inspectorError: input.inspectorError ?? null,
    source: input.source ?? {},
  };
}

function runPythonPptxInspector(pptxPath: string): {
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
  clipping: GeometryIssue[];
  emptyPages: GeometryIssue[];
  shapes: GeometryShapeMeta[];
  pageShapes: Array<{ page: number; shapes: GeometryShapeMeta[] }>;
  inspectorVersion?: string;
  error?: string;
} {
  const script = join(process.cwd(), "scripts", "inspect-first36-pptx-geometry.py");
  if (!existsSync(script)) {
    return {
      overlaps: [],
      overflow: [],
      clipping: [],
      emptyPages: [],
      shapes: [],
      pageShapes: [],
      error: `missing inspector script: ${script}`,
    };
  }
  const py = spawnSync("python", [script, pptxPath, "--expect-pages=36"], {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (py.status !== 0) {
    return {
      overlaps: [],
      overflow: [],
      clipping: [],
      emptyPages: [],
      shapes: [],
      pageShapes: [],
      error: `python inspector failed: ${(py.stderr || py.stdout || "").slice(0, 400)}`,
    };
  }
  try {
    const parsed = JSON.parse(py.stdout) as {
      overlaps?: GeometryIssue[];
      overflow?: GeometryIssue[];
      clipping?: GeometryIssue[];
      emptyPages?: GeometryIssue[];
      shapes?: GeometryShapeMeta[];
      pages?: Array<{ page: number; shapes?: GeometryShapeMeta[] }>;
      inspectorVersion?: string;
      error?: string;
    };
    if (parsed.error) {
      return {
        overlaps: [],
        overflow: [],
        clipping: [],
        emptyPages: [],
        shapes: [],
        pageShapes: [],
        error: parsed.error,
      };
    }
    const norm = (list: GeometryIssue[] | undefined, defaultCode: string): GeometryIssue[] =>
      (list ?? []).map((i) => ({
        ...i,
        code: i.code ?? defaultCode,
        severity: i.severity ?? "CRITICAL",
      }));
    return {
      overlaps: norm(parsed.overlaps, "overlap"),
      overflow: norm(parsed.overflow, "overflow"),
      clipping: norm(parsed.clipping, "text-clipping"),
      emptyPages: norm(parsed.emptyPages, "empty-page"),
      shapes: parsed.shapes ?? [],
      pageShapes: (parsed.pages ?? [])
        .filter((p) => p.shapes)
        .map((p) => ({ page: p.page, shapes: p.shapes! })),
      inspectorVersion: parsed.inspectorVersion,
    };
  } catch (err) {
    return {
      overlaps: [],
      overflow: [],
      clipping: [],
      emptyPages: [],
      shapes: [],
      pageShapes: [],
      error: `invalid inspector json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function generateContactSheetPng(input: {
  pagesPngDir: string;
  outPath: string;
  cols?: number;
  tileWidth?: number;
}): Promise<{ ok: boolean; detail: string }> {
  const cols = input.cols ?? 6;
  const tileWidth = input.tileWidth ?? 320;
  const files = listFirst36PagePngs(input.pagesPngDir);
  if (files.length !== 36) {
    return { ok: false, detail: `need 36 pngs for contact sheet, got ${files.length}` };
  }
  const rows = Math.ceil(files.length / cols);
  const tileHeight = Math.round((tileWidth * 10) / 16);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < files.length; i += 1) {
    const buf = await sharp(join(input.pagesPngDir, files[i]!))
      .resize(tileWidth, tileHeight, { fit: "cover" })
      .png()
      .toBuffer();
    composites.push({
      input: buf,
      left: (i % cols) * tileWidth,
      top: Math.floor(i / cols) * tileHeight,
    });
  }
  mkdirSync(join(input.outPath, ".."), { recursive: true });
  await sharp({
    create: {
      width: cols * tileWidth,
      height: rows * tileHeight,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .composite(composites)
    .png()
    .toFile(input.outPath);
  return { ok: true, detail: input.outPath };
}

export async function generateFirst36GeometryArtifacts(
  outputRoot: string,
  options?: {
    slides?: Array<{
      pageNumber: number;
      slideKey?: string;
      slotId?: string;
      title?: string;
      narrative?: string;
      bullets?: string[];
      clientTakeaway?: string;
      assetRefs?: string[];
      requiredVisual?: boolean;
    }>;
    assets?: Array<{ assetRef: string; status?: string }>;
  }
): Promise<{
  report: First36GeometryReport;
  geometryPath: string;
  contactSheetPath: string | null;
  ok: boolean;
}> {
  const pptx = join(outputRoot, "rendered-client.pptx");
  const pagesPngDir = join(outputRoot, "pages-png");
  const geometryPath = join(outputRoot, "geometry-report.json");
  const contactSheetPath = join(outputRoot, "contact-sheet.png");
  const layoutTelemetry = join(outputRoot, "layout-telemetry.json");

  const blank = inspectBlankPagePngs(pagesPngDir);
  let overlaps: GeometryIssue[] = [];
  let overflow: GeometryIssue[] = [];
  let clipping: GeometryIssue[] = [];
  let emptyPages: GeometryIssue[] = [];
  let shapes: GeometryShapeMeta[] = [];
  let pageShapes: Array<{ page: number; shapes: GeometryShapeMeta[] }> = [];
  let inspectorVersion = GEOMETRY_INSPECTOR_VERSION;
  let inspectorError: string | null = null;

  if (!existsSync(pptx)) {
    inspectorError = `missing pptx: ${pptx}`;
  } else {
    const inspected = runPythonPptxInspector(pptx);
    overlaps = inspected.overlaps;
    overflow = inspected.overflow;
    clipping = [...inspected.clipping, ...inspectLayoutTelemetry(layoutTelemetry)];
    emptyPages = inspected.emptyPages;
    shapes = inspected.shapes;
    pageShapes = inspected.pageShapes;
    if (inspected.inspectorVersion) inspectorVersion = inspected.inspectorVersion;
    if (inspected.error) inspectorError = inspected.error;
  }

  // Deduplicate clipping entries from python + direct telemetry read
  const clipKey = new Set<string>();
  clipping = clipping.filter((c) => {
    const k = `${c.page}|${c.code}|${c.detail}`;
    if (clipKey.has(k)) return false;
    clipKey.add(k);
    return true;
  });

  const emptyContent = options?.slides ? inspectDeckEmptyContent(options.slides) : [];
  const missingAssets =
    options?.slides && options.assets ? inspectMissingVisualAssets(options.slides, options.assets) : [];

  let contactOk = blank.every((b) => b.page !== 0);
  if (contactOk) {
    const sheet = await generateContactSheetPng({ pagesPngDir, outPath: contactSheetPath });
    contactOk = sheet.ok;
    if (!sheet.ok) {
      inspectorError = `${inspectorError ?? ""}; contact-sheet: ${sheet.detail}`.replace(/^; /, "");
    }
  } else {
    inspectorError = `${inspectorError ?? ""}; contact-sheet skipped: png count`.replace(/^; /, "");
  }

  const report = buildGeometryReportFromParts({
    overlaps,
    overflow,
    blank,
    clipping,
    missingAssets,
    emptyContent,
    emptyPages,
    shapes,
    pageShapes,
    inspectorError,
    inspectorVersion,
    source: {
      pptx,
      pagesPngDir,
      pythonInspector: "scripts/inspect-first36-pptx-geometry.py",
      layoutTelemetry: existsSync(layoutTelemetry) ? layoutTelemetry : undefined,
    },
    pageCount: 36,
  });
  writeFileSync(geometryPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  const ok = report.summary.severity === "PASS" && contactOk && !report.inspectorError;
  return {
    report,
    geometryPath,
    contactSheetPath: existsSync(contactSheetPath) ? contactSheetPath : null,
    ok,
  };
}

export function geometryReportIsClean(report: First36GeometryReport): boolean {
  return report.summary.severity === "PASS" && !report.inspectorError && report.summary.issueCount === 0;
}

/** Load fixture JSON for geometry unit tests. */
export function loadGeometryFixture(name: string): First36GeometryReport {
  const path = join(
    process.cwd(),
    "src/modules/digital-profile/orion-golden/classic/fixtures/geometry",
    name
  );
  return JSON.parse(readFileSync(path, "utf-8")) as First36GeometryReport;
}
