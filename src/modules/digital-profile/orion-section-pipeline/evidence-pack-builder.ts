import type {
  OrionEvidencePack,
  OrionExcludedEvidence,
  OrionMicroStage,
  OrionNormalizedEvidence,
  OrionRawEvidence,
  OrionSelectedEvidence,
} from "./types";

export interface BuildEvidencePackInput {
  microStage: OrionMicroStage;
  subject: { fullName: string; aliases?: string[] };
  locale: "ru" | "en";
  region: string;
  rawEvidence: OrionRawEvidence[];
  sourceAvailability?: {
    used: string[];
    unavailable: string[];
  };
  sourceProvidersUsed?: string[];
  queryVariants?: string[];
  resultCounts?: Record<string, number>;
  maxItems?: number;
}

function normalizeDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const noScheme = value.replace(/^https?:\/\//i, "").trim().toLowerCase();
  if (!noScheme) return undefined;
  const host = noScheme.split("/")[0]?.replace(/^www\./i, "");
  return host && host.includes(".") ? host : undefined;
}

function classify(raw: OrionRawEvidence): OrionNormalizedEvidence["status"] {
  const cls = String(raw.classification ?? "").toLowerCase();
  if (cls.includes("excluded") || cls.includes("noise")) return "excluded_noise";
  if (cls.includes("wrong_subject")) return "wrong_subject";
  if (cls.includes("absent")) return "absent";
  if (cls.includes("requires_review") || cls.includes("review")) return "requires_review";
  if (cls.includes("potential")) return "potential";
  if (cls.includes("undesirable") || cls.includes("adverse") || cls.includes("negative")) return "undesirable";
  if (cls.includes("confirmed")) return "confirmed";
  return "potential";
}

function normalizeEvidence(raw: OrionRawEvidence[]): OrionNormalizedEvidence[] {
  return raw.map((item, idx) => {
    const status = classify(item);
    const normalizedDomain = normalizeDomain(item.domain ?? item.url);
    return {
      ...item,
      safeEvidenceId: item.evidenceId || `evidence-${idx + 1}`,
      normalizedDomain,
      subjectMatched: status !== "wrong_subject" && status !== "excluded_noise",
      status,
    };
  });
}

function sanitizeEvidence(rows: OrionRawEvidence[]): OrionRawEvidence[] {
  return rows.map((row) => {
    const safe: OrionRawEvidence = { ...row };
    if (typeof safe.url === "string" && (/storage\/digital-profile/i.test(safe.url) || /^https?:\/\/[^ ]*x-amz-/i.test(safe.url))) {
      safe.url = undefined;
    }
    if (typeof safe.domain === "string" && /c:\\|\/mnt\//i.test(safe.domain)) {
      safe.domain = "";
    }
    if (typeof safe.snippet === "string") {
      safe.snippet = safe.snippet
        .replace(/openai[_-]?api[_-]?key/gi, "")
        .replace(/sk-[A-Za-z0-9]{12,}/g, "")
        .replace(/storage\/digital-profile\/[^\s]+/gi, "")
        .replace(/c:\\[^\s]+/gi, "")
        .trim();
    }
    if (safe.metadata && typeof safe.metadata === "object") {
      const md = { ...safe.metadata };
      for (const key of Object.keys(md)) {
        if (/key|token|secret|signed|storage|path/i.test(key)) {
          delete md[key];
        }
      }
      safe.metadata = md;
    }
    return safe;
  });
}

function selectEvidence(
  rows: OrionNormalizedEvidence[],
  maxItems: number
): { selected: OrionSelectedEvidence; excluded: OrionExcludedEvidence } {
  const selectedRows = rows
    .filter((x) => x.status !== "excluded_noise")
    .slice(0, Math.max(1, maxItems));
  const excludedRows = rows.filter((x) => x.status === "excluded_noise");

  const summary = {
    total: selectedRows.length,
    confirmed: selectedRows.filter((x) => x.status === "confirmed").length,
    undesirable: selectedRows.filter((x) => x.status === "undesirable").length,
    potential: selectedRows.filter((x) => x.status === "potential").length,
    requiresReview: selectedRows.filter((x) => x.status === "requires_review").length,
    excludedNoise: excludedRows.length,
  };

  const reasonMap = new Map<string, number>();
  for (const row of excludedRows) {
    const key = row.reasonLabel ?? "noise";
    reasonMap.set(key, (reasonMap.get(key) ?? 0) + 1);
  }
  const reasons = [...reasonMap.entries()].map(([reason, count]) => ({ reason, count }));

  return {
    selected: { items: selectedRows, summary },
    excluded: { items: excludedRows, reasons },
  };
}

function topDomains(rows: OrionNormalizedEvidence[]): string[] {
  const m = new Map<string, number>();
  for (const row of rows) {
    const d = row.normalizedDomain;
    if (!d) continue;
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain]) => domain);
}

function topThemes(rows: OrionNormalizedEvidence[]): Array<{ label: string; count: number }> {
  const m = new Map<string, number>();
  for (const row of rows) {
    const t = String(row.themeLabel ?? "").trim();
    if (!t) continue;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, count]) => ({ label, count }));
}

export function buildMicroStageEvidencePack(input: BuildEvidencePackInput): {
  normalized: OrionNormalizedEvidence[];
  selected: OrionSelectedEvidence;
  excluded: OrionExcludedEvidence;
  evidencePack: OrionEvidencePack;
} {
  const normalized = normalizeEvidence(sanitizeEvidence(input.rawEvidence));
  const { selected, excluded } = selectEvidence(normalized, input.maxItems ?? 40);
  const keyDomains = topDomains(selected.items);
  const themeGroups = topThemes(selected.items);
  const queryVariants = [
    input.subject.fullName,
    ...(input.subject.aliases ?? []),
    ...(input.queryVariants ?? []),
    ...selected.items.map((x) => String(x.query ?? "").trim()).filter(Boolean),
  ].slice(0, 12);
  const sourceProvidersUsed = [
    ...(input.sourceProvidersUsed ?? []),
    ...selected.items.map((x) => String(x.source ?? "")).filter(Boolean),
  ];
  const dedupProviders = [...new Set(sourceProvidersUsed)];
  const reviewRequiredEvidence = selected.items
    .filter((x) => x.status === "requires_review")
    .slice(0, 12)
    .map((x) => ({
      safeEvidenceId: x.safeEvidenceId,
      source: x.source,
      title: x.title,
      snippet: x.snippet,
      themeLabel: x.themeLabel,
    }));
  const lexisParsedSafeSignals = selected.items
    .filter((x) => x.type === "lexis_signal" || x.type === "lexis_import_status")
    .slice(0, 20)
    .map((x) => ({
      title: String(x.title ?? "LexisNexis signal"),
      reason: String(x.snippet ?? ""),
      reviewRequired: x.status !== "confirmed",
    }));
  const lexisVisualPageRefs = selected.items
    .filter((x) => x.type === "lexis_visual_page")
    .map((x) => String(x.visualRef ?? x.screenshotRef ?? ""))
    .filter(Boolean);

  const evidencePack: OrionEvidencePack = {
    microStageKey: input.microStage.microStageKey,
    macroSectionKey: input.microStage.macroSectionKey,
    subject: {
      fullName: input.subject.fullName,
      aliases: input.subject.aliases ?? [],
    },
    locale: input.locale,
    region: input.region,
    sourceProvidersUsed: dedupProviders,
    sourceAvailability: input.sourceAvailability,
    queryVariants,
    resultCounts: input.resultCounts,
    topResults: selected.items.map((item) => ({
      safeEvidenceId: item.safeEvidenceId,
      source: item.source,
      provider: item.source,
      domain: item.normalizedDomain,
      title: item.title,
      snippet: item.snippet,
      classification: item.status,
      themeLabel: item.themeLabel,
      screenshotRef: item.screenshotRef,
      visualRef: item.visualRef,
    })),
    counts: selected.summary,
    themeGroups,
    keyDomains,
    reviewRequiredEvidence,
    lexisParsedSafeSignals,
    lexisVisualPageRefs,
    exclusionSummary: excluded.reasons,
  };

  return { normalized, selected, excluded, evidencePack };
}

