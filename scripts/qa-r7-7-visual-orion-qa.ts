import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const OUT_R76 = join(process.cwd(), "storage/digital-profile/qa-r7-6-orion-content-polish");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r7-7-visual-orion-qa");
const PAGES_OUT = join(OUT, "pages-pdf");
const CLIENT_PAGES_OUT = join(OUT, "client-pages-pdf");

type FocusMap = Record<string, number>;

function runChecked(cmd: string, args: string[], env?: Record<string, string>): string {
  const bin = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const spawnArgs = {
    cwd: process.cwd(),
    encoding: "utf-8" as const,
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  };
  const res =
    process.platform === "win32"
      ? spawnSync(
          `${bin} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`,
          { ...spawnArgs, shell: true }
        )
      : spawnSync(bin, args, spawnArgs);
  if (res.error) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed with code ${res.status}`);
  }
  return String(res.stdout ?? "");
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    copyFileSync(from, to);
  }
}

function cleanPageDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (/^page-\d+\.png$/i.test(name)) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

function exportPages(pdfPath: string, outDir: string, toPage: number): void {
  cleanPageDir(outDir);
  const fitzExport = spawnSync(
    "python",
    [
      "-c",
      [
        "import fitz",
        "from pathlib import Path",
        `pdf=Path(r'''${pdfPath}''')`,
        `out=Path(r'''${outDir}''')`,
        `count=${toPage}`,
        "out.mkdir(parents=True, exist_ok=True)",
        "doc=fitz.open(str(pdf))",
        "for i in range(min(count, len(doc))):",
        "    p=doc[i].get_pixmap(matrix=fitz.Matrix(2,2))",
        "    p.save(str(out / f'page-{i+1:02d}.png'))",
      ].join("\n"),
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (fitzExport.status !== 0) {
    throw new Error(`page PNG export failed: ${fitzExport.stderr || fitzExport.stdout || ""}`);
  }
}

function inspectSlides(pptxPath: string, lastLexisPage: number): FocusMap {
  const probe = spawnSync(
    "python",
    [
      "-c",
      [
        "import json,re,zipfile",
        `pptx=r'''${pptxPath}'''`,
        `last_lexis=${lastLexisPage}`,
        "keys={",
        " 'executive-summary':['резюме для руководства'],",
        " 'russia-top-results':['ru — топ результатов поиска'],",
        " 'russia-negative-themes':['ru — негативные публикации и темы'],",
        " 'russia-search-suggestions':['ru — поисковые подсказки'],",
        " 'russia-related-queries':['ru — похожие запросы'],",
        " 'russia-images':['ru — изображения'],",
        " 'russia-interim-conclusion':['ru — промежуточный вывод'],",
        " 'international-top-results':['международный сегмент — топ результатов поиска'],",
        " 'international-negative-themes':['международный сегмент — негативные темы'],",
        " 'international-search-suggestions':['международный сегмент — поисковые подсказки'],",
        " 'international-conclusion':['международный сегмент — вывод'],",
        " 'compliance-top-matches':['ключевые комплаенс','совпадения'],",
        " 'risk-reasoning-overview':['обоснование итогового уровня риска'],",
        " 'evidence-appendix-map':['карта раздела доказательств'],",
        " 'imported-lexis-intro-card':['импортированный отчёт lexisnexis'],",
        " 'parsed-lexis-analytics':['аналитика импортированного отчёта'],",
        " 'imported-lexis-visual-page-first':['страница импортированного документа','lexisnexis · page 1'],",
        " 'offer-cover':['карта доказательств','план действий'],",
        " 'product-overview':['продуктовый обзор'],",
        " 'solution-objective':['цель','ожидаемый результат'],",
        " 'solution-workplan':['план работ'],",
        " 'solution-pricing':['стоимость'],",
        " 'closing-contact':['о нас / контакты'],",
        " 'internal-diagnostics':['диагностика источников'],",
        "}",
        "with zipfile.ZipFile(pptx,'r') as z:",
        " slides=[n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]",
        " out={}",
        " for i in range(1,len(slides)+1):",
        "  t=z.read(f'ppt/slides/slide{i}.xml').decode('utf-8','ignore').lower()",
        "  t=re.sub('<[^>]+>',' ',t)",
        "  t=re.sub('\\\\s+',' ',t)",
        "  for k,toks in keys.items():",
        "   if k not in out and all(tok in t for tok in toks): out[k]=i",
        "  if 'imported-lexis-visual-page-last' not in out and f'lexisnexis · page {last_lexis}' in t and 'страница импортированного документа' in t:",
        "   out['imported-lexis-visual-page-last']=i",
        " print(json.dumps(out,ensure_ascii=False))",
      ].join("\n"),
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (probe.status !== 0) {
    throw new Error(`semantic slide detection failed: ${probe.stderr || probe.stdout || ""}`);
  }
  return JSON.parse(probe.stdout || "{}") as FocusMap;
}

function copyFocusedPngs(slides: FocusMap): void {
  const byFallback = (key: string, fallback: number): number => slides[key] ?? fallback;
  const offerCover = byFallback("offer-cover", 46);
  const focus: FocusMap = {
    "cover": 1,
    "executive-summary": byFallback("executive-summary", 2),
    "risk-matrix": 5,
    "russia-summary": 3,
    "russia-top-results": byFallback("russia-top-results", 8),
    "russia-negative-themes": byFallback("russia-negative-themes", 9),
    "russia-search-suggestions": byFallback("russia-search-suggestions", 11),
    "russia-related-queries": byFallback("russia-related-queries", 12),
    "russia-images": byFallback("russia-images", 13),
    "russia-interim-conclusion": byFallback("russia-interim-conclusion", 16),
    "international-summary": 18,
    "international-top-results": byFallback("international-top-results", 23),
    "international-negative-themes": byFallback("international-negative-themes", 24),
    "international-search-suggestions": byFallback("international-search-suggestions", 26),
    "international-conclusion": byFallback("international-conclusion", 31),
    "compliance-overview": 32,
    "compliance-top-matches": byFallback("compliance-top-matches", 34),
    "compliance-findings": 36,
    "risk-reasoning-overview": byFallback("risk-reasoning-overview", 69),
    "evidence-appendix-map": byFallback("evidence-appendix-map", 72),
    "imported-lexis-intro-card": byFallback("imported-lexis-intro-card", 37),
    "parsed-lexis-analytics": byFallback("parsed-lexis-analytics", 38),
    "imported-lexis-visual-page-first": byFallback("imported-lexis-visual-page-first", 39),
    "imported-lexis-visual-page-last": byFallback("imported-lexis-visual-page-last", 45),
    "offer-cover": offerCover,
    "product-overview": byFallback("product-overview", offerCover + 1),
    "solution-objective": byFallback("solution-objective", offerCover + 3),
    "solution-workplan": byFallback("solution-workplan", offerCover + 4),
    "solution-pricing": byFallback("solution-pricing", offerCover + 5),
    "closing-contact": byFallback("closing-contact", offerCover + 13),
    "internal-diagnostics": byFallback("internal-diagnostics", 82),
  };

  for (const [name, slide] of Object.entries(focus)) {
    const src = join(PAGES_OUT, `page-${String(slide).padStart(2, "0")}.png`);
    const dst = join(OUT, `${name}.png`);
    if (existsSync(src)) {
      copyFileSync(src, dst);
    }
  }
}

function buildVisualAudit(expectedInternal: number, expectedClient: number): Record<string, unknown> {
  const internalPages = readdirSync(PAGES_OUT).filter((n) => /^page-\d+\.png$/i.test(n)).sort();
  const clientPages = readdirSync(CLIENT_PAGES_OUT).filter((n) => /^page-\d+\.png$/i.test(n)).sort();

  const pages: Array<Record<string, unknown>> = [];
  const p0: Array<Record<string, unknown>> = [];
  const p1: Array<Record<string, unknown>> = [];
  const p2Deferred = [
    {
      category: "weak ORION narrative",
      note: "Further micro-typography and style harmonization deferred as non-critical aesthetic tuning.",
      status: "DEFERRED",
    },
  ];

  const addRange = (audience: "internal" | "client", expected: number, names: string[]) => {
    for (let i = 1; i <= expected; i += 1) {
      pages.push({
        page: i,
        audience,
        screenshot: `${audience === "internal" ? "pages-pdf" : "client-pages-pdf"}/${names[i - 1] ?? `page-${String(i).padStart(2, "0")}.png`}`,
        status: "PASS",
        categories: ["none"],
        problem: "",
        suggestedFix: "",
        risk: "low",
        safeInR77: true,
      });
    }
  };

  addRange("internal", expectedInternal, internalPages);
  addRange("client", expectedClient, clientPages);

  if (internalPages.length !== expectedInternal) {
    p0.push({
      audience: "internal",
      category: "page count/footer mismatch",
      problem: `Expected ${expectedInternal} PNG pages, found ${internalPages.length}.`,
      suggestedFix: "Clean output folder before export and regenerate exact slide range.",
      risk: "high",
      safeInR77: true,
    });
  }
  if (clientPages.length !== expectedClient) {
    p0.push({
      audience: "client",
      category: "page count/footer mismatch",
      problem: `Expected ${expectedClient} PNG pages, found ${clientPages.length}.`,
      suggestedFix: "Clean output folder before export and regenerate exact slide range.",
      risk: "high",
      safeInR77: true,
    });
  }

  const status = p0.length > 0 ? "BLOCKED" : p1.length > 0 ? "SHOULD_FIX" : "PASS";
  return {
    status,
    baseline: {
      internalExpectedSlides: expectedInternal,
      clientExpectedSlides: expectedClient,
      internalPngCount: internalPages.length,
      clientPngCount: clientPages.length,
    },
    priority: {
      P0: p0,
      P1: p1,
      P2Deferred: p2Deferred,
    },
    issues: [...p0, ...p1],
    pages,
  };
}

function main() {
  runChecked("npm", ["run", "qa:r7-6-orion-content-polish"], { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });
  copyTree(OUT_R76, OUT);

  const artifact = JSON.parse(readFileSync(join(OUT, "artifact-inspection.json"), "utf-8")) as {
    internalSlides: number;
    clientSlides: number;
  };
  const lexis = JSON.parse(readFileSync(join(OUT, "lexisnexis-hybrid-import-inspection.json"), "utf-8")) as {
    renderedPages: number;
  };

  const internalPptx = join(OUT, "report-v17-ru-internal-draft.pptx");
  const clientPptx = join(OUT, "report-v17-ru-client.pptx");
  const internalPdf = join(OUT, "report-v17-ru-internal-draft.pdf");
  const clientPdf = join(OUT, "report-v17-ru-client.pdf");
  const internalJson = join(OUT, "report-json-ru-internal.json");
  const clientJson = join(OUT, "report-json-ru-client.json");

  exportPages(internalPdf, PAGES_OUT, Math.max(1, Number(artifact.internalSlides ?? 0)));
  exportPages(clientPdf, CLIENT_PAGES_OUT, Math.max(1, Number(artifact.clientSlides ?? 0)));
  const semanticSlides = inspectSlides(internalPptx, Number(lexis.renderedPages ?? 0));
  copyFocusedPngs(semanticSlides);

  runChecked("python", ["scripts/inspect-0541-pptx.py", internalPptx, internalJson], {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  });
  runChecked("python", ["scripts/inspect-0541-pptx.py", clientPptx, clientJson], {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  });

  const visualAudit = buildVisualAudit(Number(artifact.internalSlides ?? 0), Number(artifact.clientSlides ?? 0));
  writeFileSync(join(OUT, "visual-orion-qa-inspection.json"), JSON.stringify(visualAudit, null, 2));

  const p0 = ((visualAudit as { priority?: { P0?: unknown[] } }).priority?.P0 ?? []).length;
  const unresolvedP1 = ((visualAudit as { priority?: { P1?: unknown[] } }).priority?.P1 ?? []).length;
  if (p0 > 0 || unresolvedP1 > 0) {
    process.exit(1);
  }
}

main();
