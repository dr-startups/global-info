import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  sanitizeReportJsonForAudience,
  findClientReportPolicyViolations,
} from "../src/modules/digital-profile/report/report-data-policy";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = process.env.R74_QA_OUT
  ? join(process.cwd(), process.env.R74_QA_OUT)
  : join(process.cwd(), "storage/digital-profile/qa-r7-4b-real-lexisnexis-visual-conversion");
const PAGES_OUT = join(OUT, "pages-pdf");
const CLIENT_PAGES_OUT = join(OUT, "client-pages-pdf");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r7-4-lexis-hybrid" };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function uploadLexisIfAvailable(caseId: string): Promise<{ uploaded: boolean; note: string }> {
  const fixture =
    process.env.R74_LEXIS_DOCX_PATH ??
    process.env.LEXIS_DOCX_FIXTURE_PATH ??
    "/mnt/data/LexisNexis_Дерипаска.docx";
  if (!existsSync(fixture)) {
    return {
      uploaded: false,
      note: `Fixture not found: ${fixture}. Set R74_LEXIS_DOCX_PATH to enable visual+parser QA import.`,
    };
  }
  const form = new FormData();
  const file = new File([readFileSync(fixture)], "LexisNexis_fixture.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  form.append("file", file);
  const res = await fetch(`${BASE}/cases/${caseId}/compliance/lexisnexis-import`, {
    method: "POST",
    headers: { "x-actor-id": "qa-r7-4-lexis-hybrid" },
    body: form,
  });
  if (!res.ok) {
    return { uploaded: false, note: `Import endpoint returned ${res.status}. Continuing without fixture.` };
  }
  return { uploaded: true, note: `Imported fixture: ${fixture}` };
}

async function createIsolatedQaCase(): Promise<string> {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await api("/cases", {
    method: "POST",
    body: JSON.stringify({
      fullName: `R7.4b Lexis QA ${suffix}`,
      aliases: [],
      targetRegions: ["RU", "INTERNATIONAL"],
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      notes: "R7.4b isolated real DOCX conversion QA case",
    }),
  });
  const caseId = String(
    (created as { id?: unknown }).id ??
      ((created as { case?: { id?: unknown } }).case?.id ?? "")
  );
  if (!caseId) {
    throw new Error("Could not resolve case ID from create case response");
  }
  return caseId;
}

async function downloadArtifact(url: string, dest: string): Promise<void> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r7-4-lexis-hybrid" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function exportPages(pdfPath: string, outDir: string, toPage: number) {
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
    throw new Error(`page PNG export failed: ${fitzExport.stderr || ""}`);
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
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PAGES_OUT, { recursive: true });
  mkdirSync(CLIENT_PAGES_OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.R74_CASE_ID ?? (await createIsolatedQaCase());
  const importResult = await uploadLexisIfAvailable(caseId);

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

  const report = await api(`/cases/${caseId}/report`);
  const internalJson = (report.reportJson ?? report) as Record<string, unknown>;
  const internalJsonPath = join(OUT, "report-json-ru-internal.json");
  writeFileSync(internalJsonPath, JSON.stringify(internalJson, null, 2));
  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientJsonPath = join(OUT, "report-json-ru-client.json");
  writeFileSync(clientJsonPath, JSON.stringify(clientJson, null, 2));
  const lexisBlock = (internalJson.lexisNexisHybrid ?? {}) as Record<string, unknown>;
  const docs = Array.isArray(lexisBlock.documents) ? (lexisBlock.documents as Array<Record<string, unknown>>) : [];
  const latest = docs
    .slice()
    .sort((a, b) =>
      String(a.importedAt ?? "").localeCompare(String(b.importedAt ?? ""))
    )
    .slice(-1)[0];
  const latestStatus = String(latest?.status ?? "");
  const latestPageCount = Number(latest?.pageCount ?? 0);
  const latestRenderedPages = Array.isArray(latest?.renderedPages) ? latest.renderedPages.length : 0;
  const latestParserStatus = String(((latest?.parsedAnalytics as Record<string, unknown> | undefined)?.parserStatus ?? ""));
  const readyCount = docs.filter((d) => String(d.status ?? "") === "ready").length;
  const warningCount = docs.filter((d) => String(d.status ?? "").includes("warning")).length;
  const failedCount = docs.filter((d) => String(d.status ?? "") === "failed").length;

  exportPages(internalPdf, PAGES_OUT, Math.max(1, internalSlides));
  exportPages(clientPdf, CLIENT_PAGES_OUT, Math.max(1, clientSlides));

  const focused = [32, 33, 34, 35, 36, 44, 45, 46, 47, 72, 73];
  for (const n of focused) {
    const src = join(PAGES_OUT, `page-${String(n).padStart(2, "0")}.png`);
    const dst = join(OUT, `page-${String(n).padStart(2, "0")}.png`);
    try {
      copyFileSync(src, dst);
    } catch {
      // optional
    }
  }

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
  const hasLexisInternal = JSON.stringify(internalJson).includes("lexisNexisHybrid");
  const hasLexisClient = JSON.stringify(clientJson).includes("lexisNexisHybrid");
  const noRawLeak =
    !JSON.stringify(clientJson).includes("rawExtractedText") &&
    !JSON.stringify(clientJson).includes("parserWarnings") &&
    !JSON.stringify(clientJson).includes("internalReason") &&
    !JSON.stringify(clientJson).includes("storageKey");
  const lexisInspection = {
    importAttempted: importResult.uploaded,
    importNote: importResult.note,
    hasLexisInternal,
    hasLexisClient,
    noRawLeak,
    internalSlides,
    clientSlides,
    readyCount,
    warningCount,
    failedCount,
    latestImportStatus: latestStatus || "missing",
    latestImportPageCount: latestPageCount,
    latestRenderedPages,
    latestParserStatus: latestParserStatus || "missing",
    inspectInternalExit: inspectInternal.status,
    inspectClientExit: inspectClient.status,
    clientPolicyViolations: clientViolations.length,
    status:
      importResult.uploaded &&
      latestStatus === "ready" &&
      latestPageCount > 0 &&
      latestRenderedPages > 0 &&
      (latestParserStatus === "parsed" || latestParserStatus === "partial") &&
      inspectInternal.status === 0 &&
      inspectClient.status === 0 &&
      clientViolations.length === 0
        ? "PASS"
        : "BLOCKED",
  };
  writeFileSync(
    join(OUT, "lexisnexis-hybrid-import-inspection.json"),
    JSON.stringify(lexisInspection, null, 2)
  );
  writeFileSync(
    join(OUT, "client-policy-inspection.json"),
    JSON.stringify(
      {
        totalViolations: clientViolations.length,
        violations: clientViolations,
        status: clientViolations.length === 0 ? "PASS" : "BLOCKED",
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
        importResult,
        internalSlides,
        clientSlides,
        readyCount,
        warningCount,
        failedCount,
        latestImportStatus: latestStatus || "missing",
        latestImportPageCount: latestPageCount,
        latestRenderedPages,
        latestParserStatus: latestParserStatus || "missing",
        inspectInternalExit: inspectInternal.status,
        inspectClientExit: inspectClient.status,
        hasLexisInternal,
        hasLexisClient,
      },
      null,
      2
    )
  );

  const ok =
    importResult.uploaded &&
    latestStatus === "ready" &&
    latestPageCount > 0 &&
    latestRenderedPages > 0 &&
    (latestParserStatus === "parsed" || latestParserStatus === "partial") &&
    inspectInternal.status === 0 &&
    inspectClient.status === 0 &&
    clientViolations.length === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

