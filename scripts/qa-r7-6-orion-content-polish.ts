import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findClientReportPolicyViolations } from "../src/modules/digital-profile/report/report-data-policy";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r7-6-orion-content-polish");
const PAGES_OUT = join(OUT, "pages-pdf");
const CLIENT_PAGES_OUT = join(OUT, "client-pages-pdf");
const FIXTURE =
  process.env.R76_LEXIS_DOCX_PATH ??
  "C:/Global Info/storage/digital-profile/qa-r7-4a-real-lexisnexis-docx/fixtures/LexisNexis_Дерипаска.docx";
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r7-6-orion-content-polish" };

const RAW_THEME_KEYS = [
  "political_exposure",
  "legal_dispute",
  "adverse_media",
  "sanctions_watchlist",
  "corporate_ownership",
];

const CLIENT_RAW_THEME_KEYS = new Set([
  "political_exposure",
  "legal_dispute",
  "adverse_media",
  "sanctions_watchlist",
  "corporate_ownership",
  "criminal",
  "regulatory",
  "unknown",
]);

const THEME_FIELD_KEYS = new Set(["theme", "riskTheme", "themeKey", "category", "categoryKey"]);

const ENGLISH_RU_LEAKS = [
  "Adverse organic content detected",
  "No international subject-matched results",
  "Source:",
  "No data",
  "ABSENT",
];

const RUNTIME_LEAKS = ["legacy_mock_first", "real_first_with_fallback", "mock"];

type LeakOffender = {
  path: string;
  value: string;
  key: string;
};

type SlidePhraseHit = {
  audience: "internal" | "client";
  slide: number;
  phrase: string;
  snippet: string;
};

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
      fullName: `R7.6 ORION Content Polish ${suffix}`,
      aliases: [],
      targetRegions: ["RU", "INTERNATIONAL"],
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      notes: "R7.6 content polish QA case",
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
    headers: { "x-actor-id": "qa-r7-6-orion-content-polish" },
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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r7-6-orion-content-polish" } });
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
        " 'executive-summary': ['резюме для руководства'],",
        " 'russia-top-results': ['ru — топ результатов поиска'],",
        " 'russia-negative-themes': ['ru — негативные публикации и темы'],",
        " 'russia-search-suggestions': ['ru — поисковые подсказки'],",
        " 'russia-related-queries': ['ru — похожие запросы'],",
        " 'russia-interim-conclusion': ['ru — промежуточный вывод'],",
        " 'international-top-results': ['международный сегмент — топ результатов поиска'],",
        " 'international-negative-themes': ['международный сегмент — негативные темы'],",
        " 'international-search-suggestions': ['международный сегмент — поисковые подсказки'],",
        " 'international-conclusion': ['международный сегмент — вывод'],",
        " 'compliance-top-matches': ['ключевые комплаенс', 'совпадения'],",
        " 'risk-reasoning-overview': ['обоснование итогового уровня риска'],",
        " 'evidence-appendix-map': ['карта раздела доказательств'],",
        " 'imported-lexis-intro-card': ['импортированный отчёт lexisnexis'],",
        " 'parsed-lexis-analytics': ['аналитика импортированного отчёта'],",
        " 'imported-lexis-visual-page-first': ['страница импортированного документа', 'lexisnexis · page 1'],",
        " 'offer-cover': ['карта доказательств', 'план действий'],",
        " 'solution-objective': ['цель', 'ожидаемый результат'],",
        " 'solution-pricing': ['стоимость'],",
        " 'closing-contact': ['о нас / контакты'],",
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

function extractSlideTextMap(pptxPath: string): Record<string, string> {
  const probe = spawnSync(
    "python",
    [
      "-c",
      [
        "import json,re,zipfile",
        `pptx=r'''${pptxPath}'''`,
        "out={}",
        "with zipfile.ZipFile(pptx,'r') as z:",
        " slides=[n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]",
        " for i in range(1,len(slides)+1):",
        "  t=z.read(f'ppt/slides/slide{i}.xml').decode('utf-8','ignore').lower()",
        "  t=re.sub('<[^>]+>',' ',t)",
        "  t=re.sub('\\\\s+',' ',t).strip()",
        "  out[str(i)] = t",
        "print(json.dumps(out,ensure_ascii=False))",
      ].join("\n"),
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (probe.status !== 0) {
    throw new Error(`slide text extraction failed: ${probe.stderr || probe.stdout || ""}`);
  }
  return JSON.parse(probe.stdout || "{}") as Record<string, string>;
}

function hasRawThemeLeak(text: string): boolean {
  const low = text.toLowerCase();
  return RAW_THEME_KEYS.some((k) => low.includes(k));
}

function hasEnglishRuLeak(text: string): boolean {
  return ENGLISH_RU_LEAKS.some((k) => text.includes(k.toLowerCase()));
}

function hasRuntimeLeak(text: string): boolean {
  return RUNTIME_LEAKS.some((k) => text.includes(k.toLowerCase()));
}

function domainChecks(reportJson: Record<string, unknown>): {
  dashCount: number;
  unavailableCount: number;
  realDomainCount: number;
  derivableUrlCount: number;
  domainSamples: string[];
  domainSourcePaths: string[];
} {
  const DOMAIN_KEYS = new Set(["domain", "sourceDomain", "canonicalDomain"]);
  const URL_KEYS = new Set(["url", "link", "sourceUrl", "sourcePageUrl", "evidenceUrl", "canonicalUrl"]);
  let dashCount = 0;
  let unavailableCount = 0;
  let realDomainCount = 0;
  let derivableUrlCount = 0;
  const domainSamples = new Set<string>();
  const domainSourcePaths = new Set<string>();

  const normalizeDomain = (value: string): string => {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw) return "";
    if (raw === "—") return "—";
    if (raw === "domain unavailable" || raw === "домен не указан") return raw;
    const noScheme = raw.replace(/^https?:\/\//i, "");
    const host = noScheme.split("/")[0]?.replace(/^www\./i, "").split("?")[0]?.split("#")[0]?.trim() ?? "";
    if (!host || host.includes("\\") || host.startsWith("localhost")) return "";
    const noPort = host.split(":")[0];
    return noPort.includes(".") ? noPort : "";
  };

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === "string" && DOMAIN_KEYS.has(key)) {
        const normalized = normalizeDomain(child);
        if (!normalized || normalized === "—") {
          dashCount += 1;
        } else if (normalized === "domain unavailable" || normalized === "домен не указан") {
          unavailableCount += 1;
        } else {
          realDomainCount += 1;
          domainSamples.add(normalized);
          domainSourcePaths.add(childPath);
        }
      } else if (typeof child === "string" && URL_KEYS.has(key)) {
        const normalized = normalizeDomain(child);
        if (normalized && normalized !== "—" && normalized !== "domain unavailable" && normalized !== "домен не указан") {
          derivableUrlCount += 1;
          if (domainSamples.size < 12) domainSamples.add(normalized);
          if (domainSourcePaths.size < 20) domainSourcePaths.add(childPath);
        }
      }
      walk(child, childPath);
    }
  };

  walk(reportJson, "");
  return {
    dashCount,
    unavailableCount,
    realDomainCount,
    derivableUrlCount,
    domainSamples: Array.from(domainSamples).slice(0, 12),
    domainSourcePaths: Array.from(domainSourcePaths).slice(0, 20),
  };
}

function collectRawThemeLeakOffendersFromClientJson(reportJson: Record<string, unknown>): LeakOffender[] {
  const offenders: LeakOffender[] = [];
  const addOffender = (path: string, value: string, key: string) => {
    offenders.push({ path, value, key });
  };

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        path.endsWith("riskSummary.findingsByTheme") &&
        CLIENT_RAW_THEME_KEYS.has(String(key).toLowerCase())
      ) {
        addOffender(childPath, String((value as Record<string, unknown>)[key]), String(key).toLowerCase());
      }
      if (typeof child === "string") {
        const low = child.toLowerCase().trim();
        if (THEME_FIELD_KEYS.has(key) && CLIENT_RAW_THEME_KEYS.has(low)) {
          addOffender(childPath, child, low);
        }
        if (/^auditSummary\.keyFindings\[\d+\]\.points\[\d+\]$/.test(childPath)) {
          for (const token of CLIENT_RAW_THEME_KEYS) {
            if (new RegExp(`\\b${token}\\b`, "i").test(child)) {
              addOffender(childPath, child, token);
            }
          }
        }
      }
      walk(child, childPath);
    }
  };

  walk(reportJson, "");
  return offenders;
}

function collectEnglishLeakOffenders(
  slides: Record<string, string>,
  audience: "internal" | "client",
  internalLastSlide: number
): SlidePhraseHit[] {
  const offenders: SlidePhraseHit[] = [];
  for (const [slideStr, text] of Object.entries(slides)) {
    const slide = Number(slideStr);
    if (audience === "internal" && slide === internalLastSlide) continue; // diagnostics slide is internal-only
    const low = text.toLowerCase();
    for (const phrase of ENGLISH_RU_LEAKS) {
      const target = phrase.toLowerCase();
      const idx = low.indexOf(target);
      if (idx < 0) continue;
      const snippet = text.slice(Math.max(0, idx - 120), idx + target.length + 200);
      offenders.push({
        audience,
        slide,
        phrase,
        snippet,
      });
    }
  }
  return offenders;
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

  const caseId = process.argv[2] ?? process.env.R76_CASE_ID ?? (await createCase());
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

  const internalTextMap = extractSlideTextMap(internalPptx);
  const clientTextMap = extractSlideTextMap(clientPptx);
  const internalNormalText = Object.entries(internalTextMap)
    .filter(([slide]) => Number(slide) !== internalSlides)
    .map(([, text]) => text)
    .join("\n");
  const clientAllText = Object.values(clientTextMap).join("\n");

  const rawThemeLeakInSlides = hasRawThemeLeak(internalNormalText) || hasRawThemeLeak(clientAllText);
  const rawThemeLeakOffendersClientJson = collectRawThemeLeakOffendersFromClientJson(clientJson);
  const rawThemeLeakInClientJson = rawThemeLeakOffendersClientJson.length > 0;
  const englishLeakOffenders = [
    ...collectEnglishLeakOffenders(internalTextMap, "internal", internalSlides),
    ...collectEnglishLeakOffenders(clientTextMap, "client", internalSlides),
  ];
  const englishLeakRuSlides = englishLeakOffenders.length > 0;
  const runtimeLeakSlides = hasRuntimeLeak(internalNormalText) || hasRuntimeLeak(clientAllText);
  const domainInternal = domainChecks(internalJson);
  const domainClient = domainChecks(clientJson);
  const domainDashLeak = domainInternal.dashCount > 0 || domainClient.dashCount > 0;
  const domainDerivedExists =
    domainInternal.realDomainCount > 0 ||
    domainClient.realDomainCount > 0 ||
    domainInternal.derivableUrlCount > 0 ||
    domainClient.derivableUrlCount > 0;

  const clientViolations = findClientReportPolicyViolations(JSON.stringify(clientJson));
  const hasClientDiagnostics = JSON.stringify(clientJson).includes("providerDiagnostics");
  const hasLexisClient = JSON.stringify(clientJson).includes("lexisNexisHybrid");
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

  const contentPolishInspection = {
    caseId,
    rawThemeLeakInSlides,
    rawThemeLeakInClientJson,
    rawThemeLeakOffendersClientJson,
    englishLeakRuSlides,
    englishLeakOffenders,
    runtimeLeakSlides,
    domainInternal,
    domainClient,
    domainDashLeak,
    domainDerivedExists,
    reportPlacementOk,
    hasLexisClient,
    clientPolicyViolations: clientViolations.length,
    inspectInternalExit: inspectInternal.status,
    inspectClientExit: inspectClient.status,
    status:
      !rawThemeLeakInSlides &&
      !rawThemeLeakInClientJson &&
      !englishLeakRuSlides &&
      !runtimeLeakSlides &&
      !domainDashLeak &&
      domainDerivedExists &&
      reportPlacementOk &&
      hasLexisClient &&
      clientViolations.length === 0 &&
      inspectInternal.status === 0 &&
      inspectClient.status === 0 &&
      fullAuditOk &&
      lexisImportOk
        ? "PASS"
        : "BLOCKED",
  };
  writeFileSync(join(OUT, "report-content-polish-inspection.json"), JSON.stringify(contentPolishInspection, null, 2));

  const ok = contentPolishInspection.status === "PASS";
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

