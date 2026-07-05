import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { processLexisDocxViaRenderer } from "./lexis-renderer-client";
import type {
  ImportedEvidenceDocument,
  ImportedEvidenceDocumentStatus,
  LexisNexisParsedAnalytics,
  LexisNexisSignal,
  RenderedDocumentPage,
} from "../types";

const PARSER_VERSION = "r74-det-v1";

export interface RenderedPageFile {
  pageNumber: number;
  width: number;
  height: number;
  fileBytes: Buffer;
}

export interface LexisHybridProcessingResult {
  status: ImportedEvidenceDocumentStatus;
  renderedPageFiles: RenderedPageFile[];
  parsedAnalytics: LexisNexisParsedAnalytics;
  parserWarnings: string[];
  conversionWarnings: string[];
}

function safeSentence(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function categoryLabels(category: LexisNexisSignal["category"]): { ru: string; en: string } {
  switch (category) {
    case "sanctions_watchlist":
      return { ru: "Санкционные / watchlist-сигналы", en: "Sanctions / watchlist signals" };
    case "pep_political_exposure":
      return { ru: "Политическая экспозиция / PEP-сигналы", en: "Political exposure / PEP signals" };
    case "adverse_media":
      return { ru: "Негативные публикации / adverse media", en: "Negative publications / adverse media" };
    case "legal_regulatory":
      return { ru: "Судебные и регуляторные упоминания", en: "Legal and regulatory mentions" };
    case "corporate_ownership":
      return { ru: "Корпоративные и имущественные связи", en: "Corporate and ownership links" };
    case "identity_match":
      return { ru: "Совпадение по идентичности", en: "Identity match signal" };
    default:
      return { ru: "Требует ручной классификации", en: "Requires manual classification" };
  }
}

function buildSignal(
  documentId: string,
  idx: number,
  category: LexisNexisSignal["category"],
  snippet: string
): LexisNexisSignal {
  const labels = categoryLabels(category);
  return {
    id: `lexis-signal-${idx + 1}`,
    sourceLabel: "LexisNexis",
    matchName: "Potential match",
    normalizedName: "potential match",
    category,
    categoryLabelRu: labels.ru,
    categoryLabelEn: labels.en,
    riskLevel: category === "sanctions_watchlist" ? "high" : category === "adverse_media" ? "medium" : "unknown",
    reviewStatus: "review_required",
    confidenceLabel: "medium",
    clientSafeFinding: "Сигнал из импортированного отчёта LexisNexis.",
    clientSafeReason: "Потенциальное совпадение; требует аналитической проверки и не является юридическим заключением.",
    internalReason: `detected_by=${PARSER_VERSION}; category=${category}`,
    snippetShort: safeSentence(snippet),
    evidenceDocumentId: documentId,
    requiresReview: true,
    isConfirmed: false,
    isExcludedNoise: false,
  };
}

function parseSignals(documentId: string, text: string): LexisNexisParsedAnalytics {
  const started = Date.now();
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const subjectNameDetected = lines.find((line) => /subject|entity|name|фио|субъект/i.test(line))?.slice(0, 120);
  const reportDateDetected = lines
    .join(" ")
    .match(/\b(20\d{2}[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01]))\b/)?.[1];
  const candidates: Array<{ category: LexisNexisSignal["category"]; line: string }> = [];
  const rules: Array<{ category: LexisNexisSignal["category"]; re: RegExp }> = [
    { category: "sanctions_watchlist", re: /\bsanction|watchlist|ofac|eu list|un list|санкц|список наблюден/i },
    { category: "pep_political_exposure", re: /\bpep|political exposure|public office|politically exposed|политическ/i },
    { category: "adverse_media", re: /\badverse media|negative media|controversy|негатив|публикац/i },
    { category: "legal_regulatory", re: /\blegal|regulator|court|litigation|enforcement|суд|регулятор|правонаруш/i },
    { category: "corporate_ownership", re: /\bownership|beneficial owner|corporate link|shareholder|бенефициар|компан/i },
    { category: "identity_match", re: /\bmatch|name match|identity|совпаден|идентичност/i },
  ];
  for (const line of lines) {
    for (const rule of rules) {
      if (rule.re.test(line)) {
        candidates.push({ category: rule.category, line });
        break;
      }
    }
  }
  if (candidates.length === 0 && lines.length > 0) {
    candidates.push({ category: "unknown", line: lines[0] });
  }
  const signals = candidates.slice(0, 40).map((c, idx) => buildSignal(documentId, idx, c.category, c.line));
  const count = (category: LexisNexisSignal["category"]) => signals.filter((s) => s.category === category).length;
  const warnings: string[] = [];
  let parserStatus: LexisNexisParsedAnalytics["parserStatus"] = "parsed";
  if (text.trim().length < 50) {
    parserStatus = "warning";
    warnings.push("low_text_volume_detected");
  }
  const reviewRequired = signals.filter((s) => s.requiresReview).length;
  const executiveSummaryClient =
    reviewRequired > 0
      ? "Импортированный отчёт LexisNexis содержит материалы, требующие аналитической проверки. Автоматический разбор выделил возможные совпадения и тематические сигналы; итоговая оценка должна подтверждаться вручную."
      : "Импортированный отчёт LexisNexis добавлен в приложение. Существенных клиентских сигналов не выделено; материалы требуют ручной аналитической проверки.";
  return {
    parserVersion: PARSER_VERSION,
    parserStatus,
    subjectNameDetected,
    reportDateDetected,
    executiveSummaryClient,
    executiveSummaryInternal:
      "Импортированный отчёт LexisNexis обработан детерминированным парсером. Результат не является юридическим заключением.",
    overallReviewStatus: reviewRequired > 0 ? "review_required" : "parse_uncertain",
    riskLevelSuggestion: reviewRequired > 0 ? "medium" : "unknown",
    confidenceLabel: reviewRequired > 0 ? "medium" : "low",
    signalCounts: {
      totalSignals: signals.length,
      reviewRequired,
      potentialMatches: signals.length,
      adverseMedia: count("adverse_media"),
      sanctionsOrWatchlist: count("sanctions_watchlist"),
      legalOrRegulatory: count("legal_regulatory"),
      pepOrPoliticalExposure: count("pep_political_exposure"),
      corporateOrOwnership: count("corporate_ownership"),
      unknown: count("unknown"),
    },
    signals,
    parserWarnings: warnings,
    provenance: {
      extractedTextLength: text.length,
      parserRuntimeMs: Date.now() - started,
      source: "lexisnexis_docx_import",
    },
  };
}

export function parseLexisTextDeterministicForTest(
  documentId: string,
  text: string
): LexisNexisParsedAnalytics {
  return parseSignals(documentId, text);
}

function extractDocxText(docxPath: string): { text: string; warnings: string[] } {
  const script = [
    "import json, re, zipfile, xml.etree.ElementTree as ET, sys",
    "docx = sys.argv[1]",
    "texts = []",
    "warnings = []",
    "try:",
    "    with zipfile.ZipFile(docx, 'r') as z:",
    "        for name in ['word/document.xml','word/header1.xml','word/footer1.xml']:",
    "            if name not in z.namelist():",
    "                continue",
    "            data = z.read(name)",
    "            root = ET.fromstring(data)",
    "            for node in root.iter():",
    "                if node.tag.endswith('}t') and node.text:",
    "                    texts.append(node.text)",
    "except Exception as e:",
    "    warnings.append('docx_extract_failed')",
    "text=' '.join(texts)",
    "text=re.sub(r'\\s+', ' ', text).strip()",
    "print(json.dumps({'text': text, 'warnings': warnings}, ensure_ascii=False))",
  ].join("\n");
  const out = spawnSync("python", ["-c", script, docxPath], { encoding: "utf-8" });
  if (out.status !== 0) {
    return { text: "", warnings: ["docx_extract_failed"] };
  }
  try {
    const parsed = JSON.parse(out.stdout || "{}") as { text?: string; warnings?: string[] };
    return { text: parsed.text ?? "", warnings: parsed.warnings ?? [] };
  } catch {
    return { text: "", warnings: ["docx_extract_parse_failed"] };
  }
}

function dockerAvailable(): boolean {
  const res = spawnSync("docker", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

function dockerImageExists(image: string): boolean {
  const res = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf-8",
  });
  return res.status === 0;
}

function convertDocxToPdfViaRendererContainer(
  docxPath: string,
  outDir: string
): { ok: boolean; pdfPath?: string; warning?: string } {
  if (!dockerAvailable()) {
    return { ok: false, warning: "docker_unavailable_for_docx_conversion" };
  }
  const imageCandidates = [
    process.env.DIGITAL_PROFILE_RENDERER_IMAGE,
    "global-info-renderer",
    "digital-profile-renderer",
  ].filter((x): x is string => Boolean(x && String(x).trim()));
  const image = imageCandidates.find((img) => dockerImageExists(img));
  if (!image) {
    return { ok: false, warning: "renderer_image_unavailable_for_docx_conversion" };
  }
  const sourceName = "source.docx";
  const expectedPdf = "source.pdf";
  const args = [
    "run",
    "--rm",
    "-v",
    `${outDir}:/work`,
    image,
    "soffice",
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    "/work",
    `/work/${sourceName}`,
  ];
  const res = spawnSync("docker", args, { encoding: "utf-8" });
  if (res.status !== 0) {
    return { ok: false, warning: "renderer_docx_to_pdf_failed" };
  }
  const pdfPath = join(outDir, expectedPdf);
  try {
    const buf = readFileSync(pdfPath);
    if (buf.length > 0) return { ok: true, pdfPath };
  } catch {
    // keep warning below
  }
  return { ok: false, warning: "renderer_docx_to_pdf_output_missing" };
}

function tryConvertDocxToPdf(docxPath: string, outDir: string): { ok: boolean; pdfPath?: string; warning?: string } {
  const commands: Array<{ cmd: string; args: string[] }> = [
    { cmd: "soffice", args: ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath] },
    { cmd: "libreoffice", args: ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath] },
  ];
  for (const c of commands) {
    const res = spawnSync(c.cmd, c.args, { encoding: "utf-8" });
    if (res.status === 0) {
      const pdfPath = join(outDir, "source.pdf");
      try {
        // LibreOffice keeps original name by default; normalize to a predictable target.
        const generated = join(outDir, `${docxPath.split(/[\\/]/).pop()?.replace(/\.docx$/i, "")}.pdf`);
        const buf = readFileSync(generated);
        writeFileSync(pdfPath, buf);
        return { ok: true, pdfPath };
      } catch {
        const fallback = join(outDir, "source.pdf");
        try {
          const buf = readFileSync(fallback);
          if (buf.length > 0) return { ok: true, pdfPath: fallback };
        } catch {
          // continue
        }
      }
    }
  }
  const container = convertDocxToPdfViaRendererContainer(docxPath, outDir);
  if (container.ok) {
    return container;
  }
  return {
    ok: false,
    warning: container.warning ?? "docx_converter_unavailable",
  };
}

function renderPdfToPngPages(pdfPath: string, outDir: string): {
  pages: Array<{ pageNumber: number; width: number; height: number; filePath: string }>;
  warning?: string;
} {
  const script = [
    "import fitz, json, sys, pathlib",
    "pdf = pathlib.Path(sys.argv[1])",
    "out = pathlib.Path(sys.argv[2])",
    "out.mkdir(parents=True, exist_ok=True)",
    "doc = fitz.open(str(pdf))",
    "pages=[]",
    "for i in range(len(doc)):",
    "    p=doc[i].get_pixmap(matrix=fitz.Matrix(1.6,1.6))",
    "    name=f'page-{i+1:03d}.png'",
    "    path=out / name",
    "    p.save(str(path))",
    "    pages.append({'pageNumber': i+1, 'width': p.width, 'height': p.height, 'filePath': str(path)})",
    "print(json.dumps({'pages': pages}, ensure_ascii=False))",
  ].join("\n");
  const out = spawnSync("python", ["-c", script, pdfPath, outDir], { encoding: "utf-8" });
  if (out.status !== 0) return { pages: [], warning: "pdf_to_png_failed_or_fitz_missing" };
  try {
    const parsed = JSON.parse(out.stdout || "{}") as {
      pages?: Array<{ pageNumber: number; width: number; height: number; filePath: string }>;
    };
    return { pages: parsed.pages ?? [] };
  } catch {
    return { pages: [], warning: "pdf_to_png_parse_failed" };
  }
}

export async function processLexisNexisDocx(
  input: {
    documentId: string;
    fileBuffer: Buffer;
    originalFileName: string;
  }
): Promise<LexisHybridProcessingResult> {
  const tempRoot = mkdtempSync(join(tmpdir(), "dp-lexis-"));
  const workDir = join(tempRoot, "work");
  mkdirSync(workDir, { recursive: true });
  const docxPath = join(workDir, "source.docx");
  writeFileSync(docxPath, input.fileBuffer);

  const parserWarnings: string[] = [];
  const conversionWarnings: string[] = [];
  try {
    const extracted = extractDocxText(docxPath);
    parserWarnings.push(...extracted.warnings);

    const conversionDir = join(workDir, "rendered");
    mkdirSync(conversionDir, { recursive: true });
    const pdf = tryConvertDocxToPdf(docxPath, workDir);
    let renderedPageFiles: RenderedPageFile[] = [];
    let extractedText = extracted.text;

    if (!pdf.ok || !pdf.pdfPath) {
      conversionWarnings.push(pdf.warning ?? "docx_to_pdf_failed");
    } else {
      const rendered = renderPdfToPngPages(pdf.pdfPath, conversionDir);
      renderedPageFiles = (rendered.pages ?? []).map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
        fileBytes: readFileSync(p.filePath),
      }));
      if (rendered.warning) conversionWarnings.push(rendered.warning);
      if (renderedPageFiles.length === 0) conversionWarnings.push("no_rendered_pages");
    }

    const needsRendererFallback =
      renderedPageFiles.length === 0 ||
      extractedText.trim().length < 50 ||
      parserWarnings.includes("docx_extract_failed");

    if (needsRendererFallback) {
      const remote = await processLexisDocxViaRenderer(input.fileBuffer);
      if (remote) {
        if (remote.text.trim().length > extractedText.trim().length) {
          extractedText = remote.text;
        }
        parserWarnings.push(...remote.parserWarnings);
        if (remote.pages.length > 0) {
          renderedPageFiles = remote.pages.map((page) => ({
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            fileBytes: Buffer.from(page.contentBase64, "base64"),
          }));
          conversionWarnings.push("local_conversion_bypassed_via_renderer");
        } else {
          conversionWarnings.push(...remote.conversionWarnings);
        }
      } else if (renderedPageFiles.length === 0) {
        conversionWarnings.push("renderer_unavailable_for_docx_conversion");
      }
    }

    const parsedAnalytics = parseSignals(input.documentId, extractedText);
    if (parsedAnalytics.parserWarnings?.length) parserWarnings.push(...parsedAnalytics.parserWarnings);

    let status: ImportedEvidenceDocumentStatus = "ready";
    const hasPages = renderedPageFiles.length > 0;
    const benignConversionWarnings = new Set([
      "local_conversion_bypassed_via_renderer",
    ]);
    const significantConversionWarnings = conversionWarnings.filter(
      (warning) => !benignConversionWarnings.has(warning)
    );
    if (!hasPages) {
      if (conversionWarnings.length > 0 && parserWarnings.length > 0) status = "failed";
      else if (conversionWarnings.length > 0) status = "conversion_warning";
      else if (parserWarnings.length > 0 || parsedAnalytics.parserStatus !== "parsed") {
        status = "parse_warning";
      }
    } else if (significantConversionWarnings.length > 0) {
      status = "conversion_warning";
    } else if (parserWarnings.length > 0 || parsedAnalytics.parserStatus !== "parsed") {
      status = "parse_warning";
    }
    return {
      status,
      renderedPageFiles,
      parsedAnalytics: {
        ...parsedAnalytics,
        parserWarnings: parserWarnings.length ? Array.from(new Set(parserWarnings)) : undefined,
      },
      parserWarnings: Array.from(new Set(parserWarnings)),
      conversionWarnings: Array.from(new Set(conversionWarnings)),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function toRenderedPageModel(
  page: RenderedPageFile,
  storageKey: string,
  warning?: string
): RenderedDocumentPage {
  return {
    pageNumber: page.pageNumber,
    storageKey,
    width: page.width,
    height: page.height,
    renderStatus: warning ? "warning" : "ready",
    renderWarning: warning,
  };
}

export function buildFallbackLexisDocument(
  input: {
    documentId: string;
    caseId: string;
    fileName: string;
    storageKey: string;
    importedAt: string;
    importedBy?: string | null;
  },
  warning: string
): ImportedEvidenceDocument {
  return {
    id: input.documentId,
    caseId: input.caseId,
    kind: "lexisnexis_report",
    sourceLabel: "LexisNexis",
    fileName: input.fileName,
    storageKey: input.storageKey,
    importedAt: input.importedAt,
    importedBy: input.importedBy,
    status: "parse_warning",
    pageCount: 0,
    renderedPages: [],
    parsedAnalytics: {
      parserVersion: PARSER_VERSION,
      parserStatus: "warning",
      executiveSummaryClient:
        "Импортированный отчёт LexisNexis добавлен в приложение. Автоматический разбор выполнен частично; материалы требуют ручной проверки.",
      executiveSummaryInternal:
        "Автоматический разбор LexisNexis-отчёта выполнен частично. Требуется аналитическая проверка.",
      overallReviewStatus: "parse_uncertain",
      riskLevelSuggestion: "unknown",
      confidenceLabel: "low",
      signalCounts: {
        totalSignals: 0,
        reviewRequired: 0,
        potentialMatches: 0,
        adverseMedia: 0,
        sanctionsOrWatchlist: 0,
        legalOrRegulatory: 0,
        pepOrPoliticalExposure: 0,
        corporateOrOwnership: 0,
        unknown: 0,
      },
      signals: [],
      parserWarnings: [warning],
      provenance: {
        source: "lexisnexis_docx_import",
      },
    },
    clientVisible: true,
    internalNotes: [warning],
    provenance: {
      importMethod: "manual_upload",
      parserVersion: PARSER_VERSION,
      conversionAvailable: false,
    },
  };
}
