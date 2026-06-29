/**
 * Report data hygiene policy (Stage R1.1).
 *
 * Production/client/internal reports exclude mock/demo fixtures from factual
 * sections unless explicit demo mode is enabled (meta.demo === true).
 */

import { isRealSource } from "../serp-snapshot/data-loader";

export interface ReportDataPolicy {
  includeDemoData: boolean;
}

export function resolveReportDataPolicy(meta?: { demo?: boolean } | null): ReportDataPolicy {
  return { includeDemoData: meta?.demo === true };
}

const DEMO_DOMAIN_SUFFIXES = [".example.com", ".example.test", ".example.org", ".example.net", ".example"];
const MOCK_URL_HINTS = /example\.(com|test|org|net)|\/mock[/\-]|mock\.example/i;

function readMeta(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function isDemoSearchRow(row: {
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
  source?: string | null;
  rawMetadata?: unknown;
}): boolean {
  const src = (row.source ?? "").toLowerCase();
  if (src.startsWith("mock:")) return true;
  const meta = readMeta(row.rawMetadata);
  if (meta.demo === true || meta.mock === true) return true;
  if (/^\[DEMO\]/i.test(row.title ?? "")) return true;
  const url = (row.url ?? "").toLowerCase();
  if (MOCK_URL_HINTS.test(url)) return true;
  try {
    const host = new URL(row.url ?? "http://invalid").hostname.replace(/^www\./, "").toLowerCase();
    if (host.endsWith(".example") || DEMO_DOMAIN_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return true;
    }
  } catch {
    /* invalid url */
  }
  return false;
}

/** Prefer real rows per engine; never fall back to mock in production mode. */
export function filterSearchResultsForReport<T extends { engine: string; source?: string | null }>(
  rows: T[],
  isDemo: (row: T) => boolean,
  policy: ReportDataPolicy
): { rows: T[]; excluded: number } {
  if (policy.includeDemoData) return { rows, excluded: 0 };

  const byEngine = new Map<string, T[]>();
  for (const row of rows) {
    const engine = row.engine ?? "UNKNOWN";
    const list = byEngine.get(engine) ?? [];
    list.push(row);
    byEngine.set(engine, list);
  }

  const out: T[] = [];
  let excluded = 0;
  for (const engineRows of byEngine.values()) {
    const nonDemo = engineRows.filter((row) => !isDemo(row));
    const real = nonDemo.filter((row) => isRealSource(row.source ?? null));
    const chosen =
      real.length > 0
        ? real
        : nonDemo.filter((row) => !String(row.source ?? "").toLowerCase().startsWith("mock:"));
    excluded += engineRows.length - chosen.length;
    out.push(...chosen);
  }
  return { rows: out, excluded };
}

export function isDemoComplianceHit(row: {
  hitSource?: string | null;
  importedBy?: string | null;
  rawMetadataSafe?: unknown;
  rawPayload?: unknown;
}): boolean {
  if (row.hitSource === "MOCK") return true;
  if ((row.importedBy ?? "").startsWith("mock:")) return true;
  const safe = readMeta(row.rawMetadataSafe ?? row.rawPayload);
  return safe.demo === true;
}

export function filterComplianceForReport<T>(
  rows: T[],
  isDemo: (row: T) => boolean,
  policy: ReportDataPolicy
): { rows: T[]; excluded: number } {
  if (policy.includeDemoData) return { rows, excluded: 0 };
  const filtered = rows.filter((row) => !isDemo(row));
  return { rows: filtered, excluded: rows.length - filtered.length };
}

export function isDemoFinding(row: { title?: string | null; demo?: boolean | null }): boolean {
  if (row.demo === true) return true;
  const title = row.title ?? "";
  if (/^\[DEMO\]/i.test(title)) return true;
  if (/\bdemo finding\b/i.test(title)) return true;
  return false;
}

export function isDemoSurface(row: {
  source?: string | null;
  title?: string | null;
  rawMetadata?: unknown;
}): boolean {
  if ((row.source ?? "").toUpperCase() === "MOCK") return true;
  const meta = readMeta(row.rawMetadata);
  if (meta.demo === true || meta.mock === true) return true;
  if (/^\[DEMO\]/i.test(row.title ?? "")) return true;
  return false;
}

export function providersQueriedFromCompliance(
  rows: Array<{ provider: string; hitSource?: string | null }>
): string[] {
  return Array.from(
    new Set(
      rows
        .filter((r) => r.hitSource === "MANUAL" || r.hitSource === "OFFICIAL_API")
        .map((r) => r.provider)
    )
  );
}

export type ReportWarningAudience = "internal" | "client_safe" | "all";
export type ReportWarningCategory =
  | "DATA_HYGIENE"
  | "PROVIDER_STATUS"
  | "RENDER"
  | "GENERAL";

export interface ReportWarning {
  text: string;
  audience: ReportWarningAudience;
  category: ReportWarningCategory;
}

export const REPORT_WARNING_DEMO_SEARCH_EXCLUDED = {
  en: "Demo/mock search rows were excluded from production report metrics.",
  ru: "Demo/mock строки поиска исключены из метрик production-отчёта.",
} as const;

export const REPORT_WARNING_DEMO_COMPLIANCE_EXCLUDED = {
  en: "Demo/mock compliance hits were excluded from production report metrics.",
  ru: "Demo/mock compliance-записи исключены из метрик production-отчёта.",
} as const;

export function createInternalHygieneWarning(
  text: string,
  category: ReportWarningCategory = "DATA_HYGIENE"
): ReportWarning {
  return { text, audience: "internal", category };
}

/** Normalize legacy string[] or structured ReportWarning[] from stored report_json. */
export function normalizeReportWarnings(
  raw: unknown
): ReportWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportWarning[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({
        text: item,
        audience: isInternalHygieneText(item) ? "internal" : "all",
        category: isInternalHygieneText(item) ? "DATA_HYGIENE" : "GENERAL",
      });
    } else if (item && typeof item === "object" && typeof (item as ReportWarning).text === "string") {
      const w = item as ReportWarning;
      out.push({
        text: w.text,
        audience: w.audience ?? "all",
        category: w.category ?? "GENERAL",
      });
    }
  }
  return out;
}

const INTERNAL_HYGIENE_PATTERNS = [
  /demo\s*\/\s*mock/i,
  /mock rows/i,
  /excluded from production report metrics/i,
  /исключены из метрик production/i,
  /data hygiene/i,
  /fixture/i,
  /sourcemode/i,
  /provideradapter/i,
  /raw metadata/i,
] as const;

export function isInternalHygieneText(text: string): boolean {
  return INTERNAL_HYGIENE_PATTERNS.some((p) => p.test(text));
}

/** Warnings visible for the given render audience (internal vs client). */
export function filterReportWarningsForAudience(
  warnings: ReportWarning[],
  audience: "internal" | "client"
): ReportWarning[] {
  if (audience === "internal") return warnings;
  return warnings.filter((w) => w.audience !== "internal");
}

export function reportWarningTexts(warnings: ReportWarning[]): string[] {
  return warnings.map((w) => w.text);
}
