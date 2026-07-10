import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import {
  clientSourceLabel,
  extractDomain,
  mapReviewStatus,
  mapRiskTheme,
  reviewStatusLabel,
  riskThemeLabel,
  stableEvidenceRef,
  stripProtocol,
  type EvidenceLocale,
  type EvidenceProvider,
  type NormalizedEvidenceV1,
} from "./normalized-evidence";

function asObj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hasRuRegion(rawMetadata: unknown): boolean {
  const rm = asObj(rawMetadata);
  const region = String(rm.orionRegion ?? rm.region ?? "").toUpperCase();
  return !region || region === "RU";
}

function hasUaeRegion(rawMetadata: unknown): boolean {
  const rm = asObj(rawMetadata);
  const region = String(rm.orionRegion ?? rm.region ?? "").toUpperCase();
  return region === "UAE" || region === "AE" || region === "INTL";
}

function isUaeSurface(region: string | null | undefined): boolean {
  const r = String(region ?? "").toUpperCase();
  return r === "UAE" || r === "AE" || r === "INTL";
}

function engineProvider(engine: string, source: string | null): EvidenceProvider | undefined {
  const src = String(source ?? "").toLowerCase();
  if (src.includes("yandex") || engine.toUpperCase() === "YANDEX") return "yandex";
  if (src.includes("google") || engine.toUpperCase() === "GOOGLE") return "google";
  return undefined;
}

function surfaceProvider(row: { provider: string | null; source: string }): EvidenceProvider | undefined {
  const p = String(row.provider ?? "").toLowerCase();
  if (p.includes("yandex")) return "yandex";
  if (p.includes("google")) return "google";
  return engineProvider("", row.source);
}

function toLocale(raw: unknown): EvidenceLocale | undefined {
  const val = String(raw ?? "").toLowerCase();
  if (val === "ru" || val.startsWith("ru")) return "ru";
  if (val === "en" || val.startsWith("en")) return "en";
  if (val === "uae") return "uae";
  if (val === "intl" || val === "international") return "intl";
  return undefined;
}

function notAvailableItem(sectionKey: string, label: string, summary: string): NormalizedEvidenceV1 {
  return {
    evidenceRef: stableEvidenceRef(sectionKey, "not-available"),
    sectionKey,
    sourceKind: "manual",
    reviewStatus: "not_available",
    sourceLabel: label,
    clientSafeSummary: summary,
    title: label,
    snippet: summary,
    riskTheme: "unknown",
  };
}

function searchResultToNormalized(
  sectionKey: string,
  row: OrionRealCaseContext["searchResults"][number],
  idx: number
): NormalizedEvidenceV1 {
  const rm = asObj(row.rawMetadata);
  const provider = engineProvider(row.engine, row.source);
  const riskTheme = mapRiskTheme(rm.riskTheme ?? rm.themeLabel ?? row.classification);
  const reviewStatus = mapReviewStatus({
    classification: row.classification,
    reviewStatus: row.reviewStatus,
    sourceKind: "search_result",
  });
  const domain = extractDomain(row.url);
  return {
    evidenceRef: stableEvidenceRef(sectionKey, `sr-${row.id || idx + 1}`),
    sectionKey,
    sourceKind: "search_result",
    provider,
    title: String(row.title ?? "").trim() || domain || "Результат поиска",
    domain,
    url: row.url,
    displayUrl: stripProtocol(row.url),
    snippet: String(row.snippet ?? "").trim(),
    query: String(rm.query ?? rm.orionQuery ?? "").trim() || undefined,
    locale: toLocale(rm.language ?? "ru"),
    riskTheme,
    reviewStatus,
    sourceLabel: clientSourceLabel(provider, "search_result"),
    clientSafeSummary: `${clientSourceLabel(provider, "search_result")}: ${String(row.title ?? domain).slice(0, 120)} — ${reviewStatusLabel(reviewStatus)}`,
    createdAt: undefined,
  };
}

function surfaceToNormalized(
  sectionKey: string,
  row: OrionRealCaseContext["searchSurfaces"][number],
  idx: number,
  sourceKind: NormalizedEvidenceV1["sourceKind"]
): NormalizedEvidenceV1 {
  const rm = asObj(row.rawMetadata);
  const provider = surfaceProvider(row);
  const riskTheme = mapRiskTheme(row.riskTheme ?? rm.riskTheme ?? row.classification);
  const reviewStatus = mapReviewStatus({
    classification: row.classification,
    reviewStatus: row.reviewStatus,
    sourceKind,
  });
  const domain = extractDomain(row.url, row.domain);
  return {
    evidenceRef: stableEvidenceRef(sectionKey, `sf-${row.id || idx + 1}`),
    sectionKey,
    sourceKind,
    provider,
    title: String(row.title ?? row.query ?? "").trim() || domain || "Элемент выдачи",
    domain,
    url: row.url ?? undefined,
    displayUrl: stripProtocol(row.url),
    snippet: String(row.snippet ?? "").trim(),
    imageUrl: row.imageUrl ?? row.thumbnailUrl ?? undefined,
    query: row.query ?? undefined,
    locale: toLocale(row.language ?? row.region),
    riskTheme,
    reviewStatus,
    sourceLabel: clientSourceLabel(provider, sourceKind),
    clientSafeSummary: `${riskThemeLabel(riskTheme)} — ${String(row.title ?? row.query ?? domain).slice(0, 100)}`,
  };
}

function complianceToNormalized(
  sectionKey: string,
  row: OrionRealCaseContext["databaseProfiles"][number],
  idx: number
): NormalizedEvidenceV1 {
  const riskTypes = Array.isArray(row.riskTypes) ? row.riskTypes.map((x) => String(x)) : [];
  const riskTheme = mapRiskTheme(riskTypes[0] ?? row.matchType);
  const reviewStatus = mapReviewStatus({
    classification: row.matchType,
    reviewStatus: row.reviewStatus,
    sourceKind: "compliance",
  });
  return {
    evidenceRef: stableEvidenceRef(sectionKey, `db-${row.id || idx + 1}`),
    sectionKey,
    sourceKind: "compliance",
    provider: "manual",
    title: String(row.matchedName ?? row.summary ?? "Совпадение в базе").trim(),
    snippet: String(row.summary ?? "").trim(),
    riskTheme,
    reviewStatus,
    confidence: typeof row.matchScore === "number" ? row.matchScore : undefined,
    sourceLabel: "База комплаенс-проверки",
    clientSafeSummary: `Официальная запись базы: ${String(row.matchedName ?? "совпадение").slice(0, 100)} — ${reviewStatusLabel(reviewStatus)}`,
    createdAt: row.importedAt.toISOString(),
  };
}

function findingToNormalized(
  sectionKey: string,
  row: OrionRealCaseContext["riskFindings"][number],
  idx: number
): NormalizedEvidenceV1 {
  const riskTheme = mapRiskTheme(row.category);
  const reviewStatus = mapReviewStatus({
    classification: row.category,
    reviewStatus: row.reviewStatus,
    sourceKind: "manual",
  });
  return {
    evidenceRef: stableEvidenceRef(sectionKey, `rf-${row.id || idx + 1}`),
    sectionKey,
    sourceKind: "manual",
    title: row.title,
    snippet: String(row.summary ?? "").trim(),
    riskTheme,
    reviewStatus,
    sourceLabel: "Аналитическая оценка риска",
    clientSafeSummary: `${row.title} — ${reviewStatusLabel(reviewStatus)}`,
  };
}

function lexisContextEvidence(sectionKey: string, ctx: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const doc = (ctx.lexis.latestReady ?? ctx.lexis.latestAny) as Record<string, unknown> | null;
  if (!doc) {
    return [
      notAvailableItem(
        sectionKey,
        "LexisNexis",
        "Документ LexisNexis не загружен; контекст для executive summary недоступен."
      ),
    ];
  }
  const parsed = (doc.parsedAnalytics as Record<string, unknown> | undefined) ?? {};
  const signals = Array.isArray(parsed.signals) ? (parsed.signals as Array<Record<string, unknown>>) : [];
  if (signals.length === 0) {
    return [
      {
        evidenceRef: stableEvidenceRef(sectionKey, "lexis-status"),
        sectionKey,
        sourceKind: "lexisnexis",
        provider: "lexisnexis",
        title: "LexisNexis: документ загружен",
        snippet: "Структурированные сигналы LexisNexis доступны для контекста executive summary.",
        reviewStatus: "requires_review",
        riskTheme: "unknown",
        sourceLabel: "LexisNexis",
        clientSafeSummary: "LexisNexis документ загружен; детальный разбор — в отдельном разделе.",
      },
    ];
  }
  return signals.slice(0, 8).map((sig, idx) => ({
    evidenceRef: stableEvidenceRef(sectionKey, `lexis-${idx + 1}`),
    sectionKey,
    sourceKind: "lexisnexis" as const,
    provider: "lexisnexis" as const,
    title: String(sig.title ?? sig.label ?? `Сигнал Lexis ${idx + 1}`).trim(),
    snippet: String(sig.summary ?? sig.description ?? "").trim(),
    riskTheme: mapRiskTheme(sig.theme ?? sig.category),
    reviewStatus: mapReviewStatus({
      classification: String(sig.classification ?? sig.severity ?? ""),
      reviewStatus: String(sig.reviewStatus ?? "PENDING"),
      sourceKind: "lexisnexis",
    }),
    sourceLabel: "LexisNexis",
    clientSafeSummary: `LexisNexis: ${String(sig.title ?? sig.label ?? "сигнал").slice(0, 100)}`,
  }));
}

function wikiEvidence(sectionKey: string, ctx: OrionRealCaseContext): NormalizedEvidenceV1[] {
  if (ctx.wikiChecks.length === 0) {
    return [notAvailableItem(sectionKey, "Wikipedia", "Проверка Wikipedia не выполнялась.")];
  }
  return ctx.wikiChecks.map((w, idx) => ({
    evidenceRef: stableEvidenceRef(sectionKey, `wiki-${idx + 1}`),
    sectionKey,
    sourceKind: "wikipedia" as const,
    provider: "wikipedia" as const,
    title: w.pageTitle ?? "Wikipedia",
    domain: w.url ? extractDomain(w.url) : "wikipedia.org",
    url: w.url ?? undefined,
    displayUrl: stripProtocol(w.url),
    snippet: w.exists ? "Публичная страница найдена." : "Публичная страница не найдена.",
    locale: toLocale(w.language),
    riskTheme: w.exists ? "identity_profile" : "neutral_profile",
    reviewStatus: w.exists ? "requires_review" : "confirmed_low_risk",
    sourceLabel: "Wikipedia",
    clientSafeSummary: w.exists ? "Wikipedia: страница найдена." : "Wikipedia: страница не найдена.",
  }));
}

function auditSummaryFromReportJson(ctx: OrionRealCaseContext, sectionKey: string): NormalizedEvidenceV1[] {
  const audit = asObj((ctx.reportJson as unknown as Record<string, unknown>).auditSummary);
  const bullets = Array.isArray(audit.keyFindings)
    ? (audit.keyFindings as unknown[]).map((x) => String(x))
    : [];
  if (bullets.length === 0 && !audit.headline && !audit.summary) {
    return [notAvailableItem(sectionKey, "Сводка аудита", "Сводка аудита по России недоступна в reportJson.")];
  }
  const items: NormalizedEvidenceV1[] = [];
  if (audit.headline || audit.summary) {
    items.push({
      evidenceRef: stableEvidenceRef(sectionKey, "audit-headline"),
      sectionKey,
      sourceKind: "manual",
      title: String(audit.headline ?? "Сводка аудита"),
      snippet: String(audit.summary ?? "").trim(),
      reviewStatus: "requires_review",
      riskTheme: "unknown",
      sourceLabel: "Сводка аудита",
      clientSafeSummary: String(audit.summary ?? audit.headline ?? "").slice(0, 200),
    });
  }
  bullets.slice(0, 12).forEach((text, idx) => {
    items.push({
      evidenceRef: stableEvidenceRef(sectionKey, `audit-finding-${idx + 1}`),
      sectionKey,
      sourceKind: "manual",
      title: text.slice(0, 120),
      snippet: text,
      reviewStatus: "requires_review",
      riskTheme: mapRiskTheme(text),
      sourceLabel: "Сводка аудита",
      clientSafeSummary: text.slice(0, 200),
    });
  });
  return items;
}

export function buildExecutiveEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "executive_summary";
  const ruResults = caseContext.searchResults.filter((r) => hasRuRegion(r.rawMetadata)).slice(0, 12);
  const findings = caseContext.riskFindings.slice(0, 10).map((r, idx) => findingToNormalized(sectionKey, r, idx));
  const compliance = caseContext.databaseProfiles.slice(0, 8).map((r, idx) => complianceToNormalized(sectionKey, r, idx));
  const search = ruResults.map((r, idx) => searchResultToNormalized(sectionKey, r, idx));
  const lexis = lexisContextEvidence(sectionKey, caseContext);
  const wiki = wikiEvidence(sectionKey, caseContext);
  return [...findings, ...compliance, ...search, ...lexis, ...wiki];
}

export function buildRuAuditSummaryEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "ru_audit_summary";
  const ruResults = caseContext.searchResults.filter((r) => hasRuRegion(r.rawMetadata));
  const search = ruResults.slice(0, 20).map((r, idx) => searchResultToNormalized(sectionKey, r, idx));
  const surfaces = caseContext.searchSurfaces
    .filter((s) => String(s.region ?? "").toUpperCase() !== "UAE")
    .slice(0, 10)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "search_surface"));
  const audit = auditSummaryFromReportJson(caseContext, sectionKey);
  const findings = caseContext.riskFindings.slice(0, 8).map((r, idx) => findingToNormalized(sectionKey, r, idx));
  if (search.length === 0 && surfaces.length === 0 && audit.length === 1 && audit[0]?.reviewStatus === "not_available") {
    return audit;
  }
  return [...audit, ...findings, ...search, ...surfaces];
}

export function buildRuSearchEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "ru_search_results";
  const ruResults = caseContext.searchResults.filter((r) => hasRuRegion(r.rawMetadata));
  const yandex = ruResults
    .filter((r) => engineProvider(r.engine, r.source) === "yandex")
    .slice(0, 12)
    .map((r, idx) => searchResultToNormalized(sectionKey, r, idx));
  const google = ruResults
    .filter((r) => engineProvider(r.engine, r.source) === "google")
    .slice(0, 12)
    .map((r, idx) => searchResultToNormalized(sectionKey, r, idx));
  const surfaces = caseContext.searchSurfaces.filter((s) => String(s.region ?? "").toUpperCase() !== "UAE");
  const suggestions = surfaces
    .filter((s) => s.type === "SUGGESTION")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "search_surface"));
  const related = surfaces
    .filter((s) => s.type === "RELATED_QUERY")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "search_surface"));
  const images = surfaces
    .filter((s) => s.type === "IMAGE_RESULT")
    .slice(0, 12)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "image_result"));
  const videos = surfaces
    .filter((s) => s.type === "VIDEO_RESULT")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "video_result"));
  const knowledge = surfaces
    .filter((s) => s.type === "KNOWLEDGE_BLOCK")
    .slice(0, 4)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "knowledge_panel"));

  const out = [...yandex, ...google, ...suggestions, ...related, ...images, ...videos, ...knowledge];
  if (out.length === 0) {
    return [
      notAvailableItem(
        sectionKey,
        "Поисковая выдача",
        "Сохранённые результаты поиска по России недоступны для этого кейса."
      ),
    ];
  }
  return out;
}

/** UAE media surfaces (images/videos/knowledge) for region-neutral composite assets. */
export function buildUaeSearchEvidence(caseContext: OrionRealCaseContext): NormalizedEvidenceV1[] {
  const sectionKey = "uae_search_results";
  const uaeResults = caseContext.searchResults.filter((r) => hasUaeRegion(r.rawMetadata));
  const google = uaeResults
    .filter((r) => engineProvider(r.engine, r.source) === "google")
    .slice(0, 12)
    .map((r, idx) => searchResultToNormalized(sectionKey, r, idx));
  const surfaces = caseContext.searchSurfaces.filter((s) => isUaeSurface(s.region));
  const suggestions = surfaces
    .filter((s) => s.type === "SUGGESTION")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "search_surface"));
  const related = surfaces
    .filter((s) => s.type === "RELATED_QUERY")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "search_surface"));
  const images = surfaces
    .filter((s) => s.type === "IMAGE_RESULT")
    .slice(0, 12)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "image_result"));
  const videos = surfaces
    .filter((s) => s.type === "VIDEO_RESULT")
    .slice(0, 8)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "video_result"));
  const knowledge = surfaces
    .filter((s) => s.type === "KNOWLEDGE_BLOCK")
    .slice(0, 4)
    .map((s, idx) => surfaceToNormalized(sectionKey, s, idx, "knowledge_panel"));

  return [...google, ...suggestions, ...related, ...images, ...videos, ...knowledge];
}
