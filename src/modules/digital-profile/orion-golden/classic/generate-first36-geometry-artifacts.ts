/**
 * First36 post-render geometry + contact-sheet artifacts.
 * Uses PPTX/XML shape inspection + PNG blank/tiny checks. Never invents an empty PASS.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

export type GeometryIssue = { page: number; detail: string };

export type First36GeometryReport = {
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
  blank: GeometryIssue[];
  inspectorError?: string | null;
  source: {
    pptx?: string;
    pagesPngDir?: string;
    pythonInspector?: string;
  };
};

const TINY_PNG_BYTES = 2500;
const FOOTER_SAFE_BOTTOM = 6_315_360;

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
    issues.push({ page: 0, detail: `expected 36 PNGs, found ${files.length}` });
  }
  files.forEach((name, idx) => {
    const size = statSync(join(pagesPngDir, name)).size;
    if (size < TINY_PNG_BYTES) {
      issues.push({ page: idx + 1, detail: `tiny/blank png bytes=${size} file=${name}` });
    }
  });
  return issues;
}

/** Pure XML helpers for unit tests (EMU boxes). */
export function inspectSlideXmlGeometry(xml: string, page: number): {
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
} {
  const overlaps: GeometryIssue[] = [];
  const overflow: GeometryIssue[] = [];
  const boxes: Array<{ x: number; y: number; cx: number; cy: number; bottom: number }> = [];
  const re = /<a:off x="(\d+)" y="(\d+)"[^/]*\/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const cx = Number(m[3]);
    const cy = Number(m[4]);
    boxes.push({ x, y, cx, cy, bottom: y + cy });
  }
  for (const box of boxes) {
    if (box.bottom > FOOTER_SAFE_BOTTOM) {
      overflow.push({ page, detail: `shape bottom ${box.bottom} exceeds footer safe ${FOOTER_SAFE_BOTTOM}` });
    }
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const horiz = a.x < b.x + b.cx && b.x < a.x + a.cx;
      const vert = a.y < b.y + b.cy && b.y < a.y + a.cy;
      if (horiz && vert) {
        overlaps.push({ page, detail: `overlapping shapes i=${i} j=${j}` });
      }
    }
  }
  return { overlaps, overflow };
}

function runPythonPptxInspector(pptxPath: string): {
  overlaps: GeometryIssue[];
  overflow: GeometryIssue[];
  error?: string;
} {
  const script = join(process.cwd(), "scripts", "inspect-first36-pptx-geometry.py");
  if (!existsSync(script)) {
    return { overlaps: [], overflow: [], error: `missing inspector script: ${script}` };
  }
  const py = spawnSync("python", [script, pptxPath], { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
  if (py.status !== 0) {
    return {
      overlaps: [],
      overflow: [],
      error: `python inspector failed: ${(py.stderr || py.stdout || "").slice(0, 400)}`,
    };
  }
  try {
    const parsed = JSON.parse(py.stdout) as {
      overlaps?: GeometryIssue[];
      overflow?: GeometryIssue[];
    };
    return {
      overlaps: parsed.overlaps ?? [],
      overflow: parsed.overflow ?? [],
    };
  } catch (err) {
    return {
      overlaps: [],
      overflow: [],
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
  const tileHeight = Math.round((tileWidth * 9) / 16);
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

export async function generateFirst36GeometryArtifacts(outputRoot: string): Promise<{
  report: First36GeometryReport;
  geometryPath: string;
  contactSheetPath: string | null;
  ok: boolean;
}> {
  const pptx = join(outputRoot, "rendered-client.pptx");
  const pagesPngDir = join(outputRoot, "pages-png");
  const geometryPath = join(outputRoot, "geometry-report.json");
  const contactSheetPath = join(outputRoot, "contact-sheet.png");

  const blank = inspectBlankPagePngs(pagesPngDir);
  let overlaps: GeometryIssue[] = [];
  let overflow: GeometryIssue[] = [];
  let inspectorError: string | null = null;

  if (!existsSync(pptx)) {
    inspectorError = `missing pptx: ${pptx}`;
  } else {
    const inspected = runPythonPptxInspector(pptx);
    overlaps = inspected.overlaps;
    overflow = inspected.overflow;
    if (inspected.error) inspectorError = inspected.error;
  }

  const report: First36GeometryReport = {
    overlaps,
    overflow,
    blank,
    inspectorError,
    source: { pptx, pagesPngDir, pythonInspector: "scripts/inspect-first36-pptx-geometry.py" },
  };
  writeFileSync(geometryPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  let contactOk = false;
  if (blank.every((b) => b.page !== 0)) {
    const sheet = await generateContactSheetPng({ pagesPngDir, outPath: contactSheetPath });
    contactOk = sheet.ok;
    if (!sheet.ok) {
      report.inspectorError = `${report.inspectorError ?? ""}; contact-sheet: ${sheet.detail}`.replace(/^; /, "");
      writeFileSync(geometryPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    }
  }

  const ok =
    !inspectorError &&
    overlaps.length === 0 &&
    overflow.length === 0 &&
    blank.length === 0 &&
    contactOk;

  return {
    report,
    geometryPath,
    contactSheetPath: existsSync(contactSheetPath) ? contactSheetPath : null,
    ok,
  };
}

/** Test helper: write a minimal geometry report object. */
export function geometryReportIsClean(report: First36GeometryReport): boolean {
  return (
    !report.inspectorError &&
    report.overlaps.length === 0 &&
    report.overflow.length === 0 &&
    report.blank.length === 0
  );
}
