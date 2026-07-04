import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findClientReportPolicyViolations } from "../src/modules/digital-profile/report/report-data-policy";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r7-5-ui-lexisnexis-e2e");
const PAGES_OUT = join(OUT, "pages-pdf");
const CLIENT_PAGES_OUT = join(OUT, "client-pages-pdf");
const FIXTURE =
  process.env.R75_LEXIS_DOCX_PATH ??
  "C:/Global Info/storage/digital-profile/qa-r7-4a-real-lexisnexis-docx/fixtures/LexisNexis_Дерипаска.docx";
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r7-5-ui-lexis-e2e" };

async function api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function createCase(): Promise<string> {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await api("/cases", {
    method: "POST",
    body: JSON.stringify({
      fullName: `R7.5 Lexis UI E2E ${suffix}`,
      aliases: [],
      targetRegions: ["RU", "INTERNATIONAL"],
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      notes: "R7.5 e2e case",
    }),
  });
  const caseId = String(created.id ?? ((created.case as { id?: unknown } | undefined)?.id ?? ""));
  if (!caseId) throw new Error("Could not determine case ID from create case response");
  return caseId;
}

async function uploadLexis(caseId: string): Promise<Record<string, unknown>> {
  const form = new FormData();
  const file = new File([readFileSync(FIXTURE)], "LexisNexis_Дерипаска.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  form.append("file", file);
  const res = await fetch(`${BASE}/cases/${caseId}/compliance/lexisnexis-import`, {
    method: "POST",
    headers: { "x-actor-id": "qa-r7-5-ui-lexis-e2e" },
    body: form,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`lexis import failed: ${res.status}: ${text.slice(0, 600)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function downloadArtifact(url: string, dest: string): Promise<void> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r7-5-ui-lexis-e2e" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function exportPages(pdfPath: string, outDir: string, toPage: number): void {
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

function inspectSlides(pptxPath: string, lastLexisPage: number): Record<string, number> {
  const probe = spawnSync(
    "python",
    [
      "-c",
      [
        "import json,re,zipfile",
        `pptx=r'''${pptxPath}'''`,
        `last_lexis=${lastLexisPage}`,
        "keys={",
        " 'imported-lexis-intro-card': ['импортированный отчёт lexisnexis'],",
        " 'parsed-lexis-analytics': ['аналитика импортированного отчёта'],",
        " 'imported-lexis-visual-page-first': ['страница импортированного документа', 'lexisnexis · page 1'],",
        " 'compliance-overview': ['compliance overview'],",
        " 'compliance-top-matches': ['top matches'],",
        " 'compliance-findings': ['findings'],",
        " 'risk-reasoning-overview': ['risk reasoning'],",
        " 'evidence-appendix-map': ['карта раздела'],",
        " 'source-provenance-traceability': ['происхождение источников'],",
        " 'internal-diagnostics': ['диагностика источников'],",
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
  return JSON.parse(probe.stdout || "{}") as Record<string, number>;
}

function copyFocusedPngs(slides: Record<string, number>): void {
  for (const [name, slide] of Object.entries(slides)) {
    const src = join(PAGES_OUT, `page-${String(slide).padStart(2, "0")}.png`);
    const dst = join(OUT, `${name}.png`);
    if (existsSync(src)) copyFileSync(src, dst);
  }
}

async function render(caseId: string, audience: "internal" | "client", watermarkMode: "draft" | "none") {
  return api(`/cases/${caseId}/report/render`, {
    method: "POST",
    body: JSON.stringify({
      templateVersion: "report-template-v3",
      audience,
      watermarkMode,
      reportLanguage: "ru",
    }),
  });
}

async function main() {
  if (!existsSync(FIXTURE)) {
    throw new Error(`Real LexisNexis fixture is missing. Expected path: ${FIXTURE}`);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PAGES_OUT, { recursive: true });
  mkdirSync(CLIENT_PAGES_OUT, { recursive: true });

  const caseId = process.argv[2] ?? process.env.R75_CASE_ID ?? (await createCase());
  const importResult = await uploadLexis(caseId);
  const document = (importResult.document ?? {}) as Record<string, unknown>;
  const parsedAnalytics = (document.parsedAnalytics ?? {}) as Record<string, unknown>;
  const signalCounts = (parsedAnalytics.signalCounts ?? {}) as Record<string, unknown>;
  const lexisImportOk =
    String(document.status ?? "") === "ready" &&
    Number(document.pageCount ?? 0) > 0 &&
    (String(importResult.parserStatus ?? "") === "parsed" ||
      String(importResult.parserStatus ?? "") === "partial") &&
    String(importResult.conversionStatus ?? "") === "ready";

  const fullAudit = await api(`/cases/${caseId}/audit/run`, {
    method: "POST",
    body: JSON.stringify({ runtimeMode: "real_first_with_fallback" }),
  });
  const runSummary = Array.isArray(fullAudit.runSummary)
    ? (fullAudit.runSummary as Array<Record<string, unknown>>)
    : [];
  const fallbackCount = runSummary.filter((s) => !!s.fallbackAgent).length;
  const completedCount = runSummary.filter((s) => String(s.status) === "completed").length;
  const skippedCount = runSummary.filter((s) => String(s.status) === "skipped").length;
  const unavailableCount = runSummary.filter((s) => String(s.status) === "unavailable").length;
  const failedCount = runSummary.filter((s) => String(s.status) === "failed").length;
  const fullAuditOk =
    runSummary.length > 0 &&
    String((fullAudit.runtimeStrategy as Record<string, unknown> | undefined)?.mode ?? "") ===
      "real_first_with_fallback";

  await api(`/cases/${caseId}/report/generate`, {
    method: "POST",
    body: JSON.stringify({ reportLanguage: "ru" }),
  });
  const internal = await render(caseId, "internal", "draft");
  const internalSlides = Number(internal.slideCount ?? 0);
  const internalPptx = join(OUT, "report-v17-ru-internal-draft.pptx");
  const internalPdf = join(OUT, "report-v17-ru-internal-draft.pdf");
  await downloadArtifact(String(internal.pptxDownloadUrl ?? ""), internalPptx);
  await downloadArtifact(String(internal.pdfDownloadUrl ?? ""), internalPdf);

  const client = await render(caseId, "client", "draft");
  const clientSlides = Number(client.slideCount ?? 0);
  const clientPptx = join(OUT, "report-v17-ru-client.pptx");
  const clientPdf = join(OUT, "report-v17-ru-client.pdf");
  await downloadArtifact(String(client.pptxDownloadUrl ?? ""), clientPptx);
  await downloadArtifact(String(client.pdfDownloadUrl ?? ""), clientPdf);

  const internalReport = await api(`/cases/${caseId}/report?audience=internal`);
  const clientReport = await api(`/cases/${caseId}/report?audience=client`);
  const internalJson = (internalReport.reportJson ?? internalReport) as Record<string, unknown>;
  const clientJson = (clientReport.reportJson ?? clientReport) as Record<string, unknown>;
  const internalJsonPath = join(OUT, "report-json-ru-internal.json");
  const clientJsonPath = join(OUT, "report-json-ru-client.json");
  writeFileSync(internalJsonPath, JSON.stringify(internalJson, null, 2));
  writeFileSync(clientJsonPath, JSON.stringify(clientJson, null, 2));

  exportPages(internalPdf, PAGES_OUT, Math.max(1, internalSlides));
  exportPages(clientPdf, CLIENT_PAGES_OUT, Math.max(1, clientSlides));

  const semanticSlides = inspectSlides(internalPptx, Number(document.pageCount ?? 0));
  copyFocusedPngs(semanticSlides);

  const inspectInternal = spawnSync(
    "python",
    ["scripts/inspect-0541-pptx.py", internalPptx, internalJsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspectInternal.stdout) process.stdout.write(inspectInternal.stdout);
  if (inspectInternal.stderr) process.stderr.write(inspectInternal.stderr);
  const inspectClient = spawnSync(
    "python",
    ["scripts/inspect-0541-pptx.py", clientPptx, clientJsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspectClient.stdout) process.stdout.write("\n--- CLIENT INSPECT ---\n" + inspectClient.stdout);
  if (inspectClient.stderr) process.stderr.write(inspectClient.stderr);

  const clientViolations = findClientReportPolicyViolations(JSON.stringify(clientJson));
  const hasClientDiagnostics = JSON.stringify(clientJson).includes("providerDiagnostics");
  const hasLexisClient =
    JSON.stringify(clientJson).includes("lexisNexisHybrid") &&
    JSON.stringify(clientJson).includes("sourceLabel");
  const reportPlacementOk =
    typeof semanticSlides["imported-lexis-intro-card"] === "number" &&
    typeof semanticSlides["parsed-lexis-analytics"] === "number" &&
    typeof semanticSlides["imported-lexis-visual-page-first"] === "number" &&
    typeof semanticSlides["imported-lexis-visual-page-last"] === "number";

  const lexisInspection = {
    fixturePath: FIXTURE,
    importAttempted: true,
    latestImportStatus: String(document.status ?? "missing"),
    renderedPages: Number(document.pageCount ?? 0),
    parserStatus: String(importResult.parserStatus ?? "missing"),
    conversionStatus: String(importResult.conversionStatus ?? "missing"),
    signalCount: Number(signalCounts.totalSignals ?? 0),
    reviewRequired: Number(signalCounts.reviewRequired ?? 0),
    status: lexisImportOk ? "PASS" : "BLOCKED",
  };
  writeFileSync(join(OUT, "lexisnexis-hybrid-import-inspection.json"), JSON.stringify(lexisInspection, null, 2));

  const fullAuditInspection = {
    runtimeMode: String((fullAudit.runtimeStrategy as Record<string, unknown> | undefined)?.mode ?? "unknown"),
    runSummaryCount: runSummary.length,
    completedCount,
    skippedCount,
    unavailableCount,
    fallbackCount,
    failedCount,
    outcome: String(fullAudit.outcome ?? "unknown"),
    status: fullAuditOk ? "PASS" : "BLOCKED",
  };
  writeFileSync(join(OUT, "full-audit-run-inspection.json"), JSON.stringify(fullAuditInspection, null, 2));

  writeFileSync(
    join(OUT, "client-policy-inspection.json"),
    JSON.stringify(
      {
        totalViolations: clientViolations.length,
        violations: clientViolations,
        hasClientDiagnostics,
        status: clientViolations.length === 0 && !hasClientDiagnostics ? "PASS" : "BLOCKED",
      },
      null,
      2
    )
  );

  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify(
      {
        caseId,
        internalSlides,
        clientSlides,
        inspectInternalExit: inspectInternal.status,
        inspectClientExit: inspectClient.status,
        semanticSlides,
      },
      null,
      2
    )
  );

  const uiE2EInspection = {
    caseId,
    fixturePath: FIXTURE,
    uploadApiPath: "/cases/:id/compliance/lexisnexis-import",
    fullAuditApiPath: "/cases/:id/audit/run",
    reportPlacementOk,
    hasLexisClient,
    hasClientDiagnostics,
    clientPolicyViolations: clientViolations.length,
    inspectInternalExit: inspectInternal.status,
    inspectClientExit: inspectClient.status,
    status:
      lexisImportOk &&
      fullAuditOk &&
      reportPlacementOk &&
      !hasClientDiagnostics &&
      hasLexisClient &&
      clientViolations.length === 0 &&
      inspectInternal.status === 0 &&
      inspectClient.status === 0
        ? "PASS"
        : "BLOCKED",
  };
  writeFileSync(join(OUT, "ui-lexisnexis-e2e-inspection.json"), JSON.stringify(uiE2EInspection, null, 2));

  const ok = uiE2EInspection.status === "PASS";
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

