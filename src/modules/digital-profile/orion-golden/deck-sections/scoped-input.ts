/**
 * Scoped inputs for independent section/surface builders.
 *
 * Allowed shared read-only inputs: SubjectProfile, VerifiedFindingBundle,
 * MetricSnapshot, ThemeSet, TemplateRegistry. Every fragment builder receives
 * ONLY a scoped slice filtered by region / surface / subjectMatch / findingId
 * — never UAE findings inside an RU builder, never the raw observation
 * dataset, never the whole executive summary.
 */

import { createHash } from "node:crypto";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";

export type SubjectProfileInput = {
  displayName: string;
  aliases: string[];
};

export type MetricSnapshot = {
  metricSnapshotId: string;
  datasetId: string;
  reportRunId: string;
  baseCount: number;
  enrichmentCount: number;
  compositeCount: number;
  /**
   * Предмет аудита: сколько материалов вошло в анализ — ТОП-20 выдачи плюс
   * международные базы (`analysis-scope.json`). Это не то же самое, что
   * `compositeCount`: собрано всегда шире, чем видно в выдаче, и страница
   * обязана называть оба числа своими словами, а не выдавать одно за другое.
   */
  analyzedCount?: number;
  /** Глубина выдачи, объявленная клиенту (обычно 20). */
  analysisTopN?: number;
  /**
   * Разрезы «движок × регион», давшие материал в аудит. Отчёт называет
   * поисковики и страны по этому списку, а не по заготовленной фразе: если
   * выдачу по региону собрать не удалось, обещать её проверку нельзя.
   */
  analysisLanes?: Array<{ engine: string; region: string; analyzed: number }>;
  subjectMatchCount: number;
  /** Surname+context / shared domain — visible but not KPI (§2.1). */
  likelySubjectCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  adverseFindingCount: number;
  perRegionCounts: Record<string, number>;
  /** «Вероятно о субъекте» в разрезе региона — глобальное число здесь врёт. */
  perRegionLikelyCounts?: Record<string, number>;
};

export type FragmentScope = {
  regions: string[] | null; // null = all regions (executive)
  surfaces: SurfaceKind[] | null; // null = all surfaces
  /**
   * Optional override for surface-unit filtering when it must differ from the
   * finding filter (e.g. regional summary: all regional findings + url_audit
   * units only). When omitted, `surfaces` governs both.
   */
  unitSurfaces?: SurfaceKind[] | null;
  subjectMatch: Array<Finding["subjectMatch"]> | null;
  findingIds: string[] | null;
};

/** Point lookup for scoped evidence refs only — never the raw dataset. */
export type ScopedEvidenceIndex = Record<
  string,
  {
    url?: string;
    domain?: string;
    title?: string;
    adverse?: boolean;
    kind?: string;
    region?: string;
    /** Search engine the observation was captured from (YANDEX/GOOGLE). */
    engine?: string;
    /** Compliance databases: human-readable provider name (Dow Jones, ...). */
    providerLabel?: string;
    /** Compliance databases: match category (PEP / ADVERSE_MEDIA / SANCTIONS). */
    matchCategory?: string;
    /** Compliance databases: match score 0–100. */
    matchScore?: number;
    /** Compliance databases: review status (e.g. PENDING). */
    reviewStatus?: string;
    /** WikipediaCheck.exists — factual check, not SERP domain inference. */
    wikipediaExists?: boolean;
    /** WikipediaCheck.language (ru / en / …). */
    language?: string;
    /** Subject-resolution decision for this evidence ref (§2.1). */
    subjectDecision?: string;
    /**
     * Позиция материала в выдаче — то, что сообщил поисковик. Нужна там, где
     * страница говорит о видимости: таблица выдачи начинается с того, что
     * проверяющий увидит первым, а не с того, что первым собралось.
     */
    rank?: number;
  }
>;

/**
 * REMEDIATION §7.4 — why a surface page is empty.
 * - MEASURED_EMPTY: collection ran, zero materials (honest «проверено, пусто»)
 * - NOT_COLLECTED: surface was not gathered in this run
 * - COLLECTION_FAILED: agent/provider failed (client-safe reasonLabel only)
 */
export type EmptySurfaceCollectionKind =
  | "MEASURED_EMPTY"
  | "NOT_COLLECTED"
  | "COLLECTION_FAILED";

export type SurfaceCollectionHint = {
  surface: string;
  region?: string;
  /** Raw coverage status (OK / NO_RESULTS / ERROR / …) — never shown to client. */
  status: string;
  errorCode?: string | null;
  provider?: string;
};

export type EmptySurfaceCollectionStatus = {
  kind: EmptySurfaceCollectionKind;
  /** Human-readable cause for NOT_COLLECTED / FAILED; never internal codes. */
  reasonLabel?: string;
};

export type ScopedFragmentInput = {
  subject: SubjectProfileInput;
  findings: Finding[];
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  /** Evidence details restricted to refs reachable from the scoped slice. */
  evidenceIndex: ScopedEvidenceIndex;
  /** Optional coverage/provider hints for empty-state copy (§7.4). */
  surfaceCollectionHints?: SurfaceCollectionHint[];
};

const REGION_ALIASES: Record<string, string[]> = {
  RU: ["RU"],
  UAE: ["UAE", "INTERNATIONAL", "GLOBAL"],
};

/**
 * Normalize evidence refs so a run's asset refs (`serp_observation:<id>`,
 * `ru_search_results-sf-<id>`) and finding refs (`inventory:serp-obs-<id>`,
 * `inventory:ss-<id>`) compare by the underlying observation/result id.
 */
export function normalizeEvidenceRef(ref: string): string {
  return ref
    .replace(/^serp_observation:/u, "")
    .replace(/^inventory:serp-obs-/u, "")
    .replace(/^inventory:ss-/u, "")
    .replace(/^[a-z]+_search_results-sf-/u, "");
}

export function regionMatches(scopeRegion: string, value: string | undefined): boolean {
  if (!value) return false;
  const aliases = REGION_ALIASES[scopeRegion] ?? [scopeRegion];
  return aliases.includes(value.toUpperCase());
}

export function scopeFindings(bundle: VerifiedFindingBundle, scope: FragmentScope): Finding[] {
  return bundle.findings.filter((f) => {
    if (scope.findingIds && !scope.findingIds.includes(f.findingId)) return false;
    if (scope.subjectMatch && !scope.subjectMatch.includes(f.subjectMatch)) return false;
    if (scope.regions) {
      const hit = scope.regions.some((r) => (f.regions ?? []).some((fr) => regionMatches(r, fr)));
      if (!hit) return false;
    }
    // Empty surfaces array means "no surface units, but findings unfiltered"
    // (summary/executive scopes depend on findings, not per-surface claims).
    if (scope.surfaces && scope.surfaces.length > 0) {
      const kinds = (f.surfaceKinds ?? []) as string[];
      // Findings without surface tags stay visible to summary-level scopes only.
      if (kinds.length > 0 && !kinds.some((k) => (scope.surfaces as string[]).includes(k))) {
        return false;
      }
    }
    return true;
  });
}

export function scopeSurfaceUnits(
  units: SurfaceAnalysisUnit[],
  scope: FragmentScope
): SurfaceAnalysisUnit[] {
  const unitFilter = scope.unitSurfaces !== undefined ? scope.unitSurfaces : scope.surfaces;
  return units.filter((u) => {
    if (unitFilter && !unitFilter.includes(u.surface)) return false;
    if (scope.regions && !scope.regions.some((r) => regionMatches(r, u.region))) return false;
    return true;
  });
}

/** Map Arsenkin/coverage surface tokens onto SurfaceKind keys. */
export function normalizeCoverageSurface(raw: string): string {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return s;
  if (s === "paa" || s === "related" || s === "paa_related") return "paa_related";
  if (s === "ai_answer" || s === "ai" || s === "ai_answers" || s === "knowledge") return "ai_answers";
  if (s === "autocomplete" || s === "suggest" || s === "suggestions") return "suggestions";
  if (s === "indexation" || s === "page_meta" || s === "url_audit") return "url_audit";
  if (s === "wiki" || s === "wikipedia") return "wikipedia";
  if (s === "image" || s === "images") return "images";
  if (s === "organic" || s === "serp" || s === "search") return "organic";
  if (s === "compliance" || s === "databases") return "compliance";
  return s;
}

/** Client-safe failure cause — internal status/errorCode never leak. */
export function clientCollectionFailureLabel(
  status: string,
  errorCode?: string | null
): string {
  const code = String(errorCode ?? "").toUpperCase();
  const st = String(status ?? "").toUpperCase();
  if (/DISABLED|SKIPPED|UNAVAILABLE|NOT_ENABLED/i.test(code) || /DISABLED|SKIPPED|UNAVAILABLE/i.test(st)) {
    return "агент отключён в этом прогоне";
  }
  if (/NOT_SUPPORTED/i.test(st) || /NOT_SUPPORTED/i.test(code)) {
    return "поверхность не поддерживается выбранным провайдером";
  }
  if (/FAILED_PARSE|PARSE/i.test(st) || /FAILED_PARSE|PARSE/i.test(code)) {
    return "ответ провайдера не удалось разобрать";
  }
  if (/RESULT_FETCH_FAILED|FETCH/i.test(st) || /FETCH/i.test(code)) {
    return "не удалось получить результат у провайдера";
  }
  if (/HTTP_?5|TIMEOUT|ERROR|FAIL/i.test(st) || /HTTP_?5|TIMEOUT|ERROR/i.test(code)) {
    return "ошибка при сборе данных";
  }
  return "сбор по поверхности завершился с ошибкой";
}

/**
 * Decide empty-state kind for a surface from unit metrics + coverage hints.
 * Prefer MEASURED (incl. empty markers / NO_RESULTS) over NOT_COLLECTED.
 */
export function resolveEmptySurfaceCollection(
  scoped: Pick<ScopedFragmentInput, "surfaceUnits" | "scope" | "surfaceCollectionHints">,
  surface: string
): EmptySurfaceCollectionStatus {
  const surfaceKey = normalizeCoverageSurface(surface);
  const units = scoped.surfaceUnits.filter((u) => u.surface === surfaceKey);
  const regionScope = scoped.scope.regions;

  const hints = (scoped.surfaceCollectionHints ?? []).filter((h) => {
    if (normalizeCoverageSurface(h.surface) !== surfaceKey) return false;
    if (!regionScope || !h.region) return true;
    return regionScope.some((r) => regionMatches(r, h.region));
  });

  const failedHint = hints.find((h) => {
    const st = String(h.status ?? "").toUpperCase();
    return (
      st.length > 0 &&
      !["OK", "NO_RESULTS", "EMPTY_VALID", "SUCCESS", "MEASURED"].includes(st) &&
      !/^N\/?A$/i.test(st)
    );
  });
  if (failedHint) {
    return {
      kind: "COLLECTION_FAILED",
      reasonLabel: clientCollectionFailureLabel(failedHint.status, failedHint.errorCode),
    };
  }

  const measuredHint = hints.some((h) =>
    /^(OK|NO_RESULTS|EMPTY_VALID|SUCCESS|MEASURED)$/i.test(String(h.status ?? ""))
  );

  let anyMeasured = measuredHint;
  let anyNotCollected = false;
  for (const u of units) {
    for (const m of u.metrics) {
      if (m.sampleStatus === "MEASURED") anyMeasured = true;
      if (m.sampleStatus === "NOT_COLLECTED") anyNotCollected = true;
    }
  }

  if (anyMeasured || units.some((u) => u.evidenceRefs.length > 0)) {
    return { kind: "MEASURED_EMPTY" };
  }

  // B.4 — «сбор не запускался» и «сбор выполнен, для региона данных нет» —
  // разные состояния. Если по этой же поверхности в прогоне есть измеренный
  // сбор за пределами регионального скоупа, страница региона честно говорит
  // «выполнено, по региону пусто», а не «не собиралась».
  const measuredElsewhere = (scoped.surfaceCollectionHints ?? []).some(
    (h) =>
      normalizeCoverageSurface(h.surface) === surfaceKey &&
      /^(OK|NO_RESULTS|EMPTY_VALID|SUCCESS|MEASURED)$/i.test(String(h.status ?? ""))
  );
  if (measuredElsewhere) {
    return {
      kind: "MEASURED_EMPTY",
      reasonLabel: "сбор по поверхности выполнен; материалов по данному региону не получено",
    };
  }

  if (units.length === 0 && hints.length === 0) {
    return {
      kind: "NOT_COLLECTED",
      reasonLabel: "поверхность не собиралась в этом прогоне",
    };
  }
  if (anyNotCollected || hints.length > 0 || units.length === 0) {
    return {
      kind: "NOT_COLLECTED",
      reasonLabel: "поверхность не собиралась в этом прогоне",
    };
  }
  return { kind: "MEASURED_EMPTY" };
}

export function buildScopedInput(input: {
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  evidenceIndex?: ScopedEvidenceIndex;
  surfaceCollectionHints?: SurfaceCollectionHint[];
}): ScopedFragmentInput {
  const findings = scopeFindings(input.bundle, input.scope);
  const surfaceUnits = scopeSurfaceUnits(input.surfaceUnits, input.scope);
  // Restrict the evidence index to refs reachable from the scoped slice.
  const reachable = new Set<string>();
  for (const f of findings) for (const r of f.evidenceRefs) reachable.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) reachable.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) reachable.add(r);
  }
  const evidenceIndex: ScopedEvidenceIndex = {};
  const unitFilter =
    input.scope.unitSurfaces !== undefined ? input.scope.unitSurfaces : input.scope.surfaces;
  const wantsSurface = (s: string): boolean =>
    unitFilter == null || (unitFilter as string[]).includes(s);
  // Region+surface-scoped observation evidence not reachable through claims
  // (e.g. the exact observation rows a bound visual asset was built from).
  // `kind` carries the surface for composite observations; visual/structured
  // kinds map onto their owning surface explicitly.
  const KIND_TO_SURFACE: Record<string, string> = {
    serp_screenshot: "organic",
    knowledge_block: "ai_answers",
  };
  for (const [ref, entry] of Object.entries(input.evidenceIndex ?? {})) {
    if (reachable.has(ref)) {
      evidenceIndex[ref] = entry;
      continue;
    }
    // REMEDIATION §3.2 — themeless subject materials are not attached to
    // findings/units; admit them by region so regional summaries can cite them
    // without failing sidebar-scope QA.
    if (entry.kind === "uncategorized") {
      if (
        input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region))
      ) {
        evidenceIndex[ref] = entry;
      }
      continue;
    }
    const surfaceOfKind = entry.kind ? KIND_TO_SURFACE[entry.kind] ?? entry.kind : undefined;
    if (
      surfaceOfKind &&
      wantsSurface(surfaceOfKind) &&
      (input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region)))
    ) {
      evidenceIndex[ref] = entry;
    }
  }
  return {
    subject: input.subject,
    findings,
    surfaceUnits,
    metricSnapshot: input.metricSnapshot,
    scope: input.scope,
    evidenceIndex,
    surfaceCollectionHints: input.surfaceCollectionHints,
  };
}

/** Deterministic hash of the scoped input (cache key with promptVersion). */
export function scopedInputHash(scoped: ScopedFragmentInput): string {
  const payload = JSON.stringify({
    subject: scoped.subject,
    findings: scoped.findings.map((f) => ({
      id: f.findingId,
      claim: f.claim,
      risk: f.riskLevel,
      match: f.subjectMatch,
      refs: f.evidenceRefs,
      priority: f.promotionPriority,
    })),
    units: scoped.surfaceUnits.map((u) => ({
      surface: u.surface,
      region: u.region,
      metrics: u.metrics,
      claims: u.claims.map((c) => ({ id: c.claimId, text: c.text, match: c.subjectMatch })),
    })),
    snapshot: scoped.metricSnapshot,
    scope: scoped.scope,
    evidence: scoped.evidenceIndex,
    surfaceCollectionHints: scoped.surfaceCollectionHints ?? [],
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
