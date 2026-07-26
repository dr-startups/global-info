/**
 * Stage O1/R5.2 — deterministic ORION query plan with explicit purpose/provider assignment.
 * No LLM, no network calls. Pure string composition and stable ordering.
 *
 * Правило, определяющее состав плана (шаг 10 переработки):
 * **строка плана — это запрос, который набрал бы человек.** Подсказки, похожие
 * запросы, изображения и видео — не запросы, а поля ответа провайдера; их читает
 * `serperAllSurfacesForQuery` из ответа на обычный запрос. Раньше они
 * запрашивались текстом («Павел Дуров похожие запросы», «Pavel Durov image»),
 * что тратило платные вызовы и заносило в корпус доказательств выдачу по
 * бессмысленной строке. Поэтому план не порождает строк с назначениями
 * `suggestion_lookup`, `related_lookup`, `image_lookup`, `video_lookup` — они
 * остаются в словаре назначений только для разметки уже собранных поверхностей.
 */

import { parseSubjectName } from "../risk-classifier/entity-disambiguation";
import type { QuerySubject } from "../providers/query-builder";

export type OrionRegionCode = "RU" | "UAE" | "INTERNATIONAL";
export type QueryPriority = "primary" | "risk_probe";
export type QueryIdentityStrictness = "strict" | "balanced" | "broad" | "exploratory";
export type QueryProviderId = "yandex" | "google" | "serper" | "wikipedia" | "compliance";
export type OrionQueryPurpose =
  | "subject_lookup"
  | "adverse_lookup"
  | "business_lookup"
  | "media_lookup"
  | "image_lookup"
  | "video_lookup"
  | "suggestion_lookup"
  | "related_lookup"
  | "wikipedia_lookup"
  | "compliance_lookup"
  | "unknown";

export interface OrionQuerySubjectProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  patronymic: string;
  latinVariants: string[];
  cyrillicVariants: string[];
  strictTokens: string[];
  weakTokens: string[];
  regionHints: string[];
  knownAliases: string[];
}

export interface OrionQuerySpec {
  queryPlanId: string;
  queryId: string;
  query: string;
  normalizedQuery: string;
  language: string;
  region: OrionRegionCode;
  priority: QueryPriority;
  purpose: OrionQueryPurpose;
  providerPreference: QueryProviderId[];
  requiredTokens: string[];
  optionalTokens: string[];
  forbiddenWeakOnlyReason?: string;
  identityStrictness: QueryIdentityStrictness;
  maxResultsHint: number;
  clientVisible: boolean;
  internalReason: string;
  /** Stable order within the plan (1-based). */
  planRank: number;
}

export interface OrionQueryPlanOptions {
  /**
   * Cap on identity variants of the name per region (`subject_lookup` rows).
   * Business, media and wikipedia anchors are added on top of this cap.
   */
  maxPrimaryPerRegion?: number;
  includeRiskProbes?: boolean;
  regions?: OrionRegionCode[];
}

export interface OrionQueryPlanBuildResult {
  queryPlanId: string;
  plan: OrionQuerySpec[];
  weakQuerySuppressedCount: number;
  transliterationVariantCount: number;
  regionHintCount: number;
  warnings: string[];
}

const DEFAULT_MAX_PRIMARY = 5;
const RU_RISK_TERMS = ["суд", "арбитраж", "банкротство", "уголовное", "розыск", "санкции"] as const;
const EN_RISK_TERMS = ["litigation", "court", "bankruptcy", "sanctions", "fraud"] as const;
const RU_BUSINESS_TERMS = ["инн", "огрн", "ип", "компания", "реестр"] as const;
const EN_BUSINESS_TERMS = ["company", "registry", "business"] as const;
const RU_MEDIA_TERMS = ["интервью", "новости"] as const;
const EN_MEDIA_TERMS = ["news", "profile", "interview"] as const;

/**
 * Шаг 10 плана.
 *
 * Коды регионов — параметр запроса (`gl`/`hl` у Serper, региональный профиль у
 * Яндекса), а не слово в его тексте. «Pavel Durov UAE» смещает выдачу к
 * страницам, где буквально написано «UAE». Осмысленный географический контекст
 * («Abu Dhabi», «Тверская область») в запросе, наоборот, полезен и остаётся.
 */
const REGION_CODE_TOKENS = new Set([
  "ru",
  "rus",
  "russia",
  "uae",
  "ae",
  "international",
  "intl",
  "global",
  "eu",
  "us",
  "usa",
]);

function isRegionCode(hint: string): boolean {
  return REGION_CODE_TOKENS.has(hint.trim().toLowerCase());
}

const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function stableHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function transliterateRuToEn(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map((ch) => {
          const lower = ch.toLowerCase();
          const lat = CYR_TO_LAT[lower];
          if (lat !== undefined) return ch === lower ? lat : lat.charAt(0).toUpperCase() + lat.slice(1);
          return ch;
        })
        .join("")
    )
    .join(" ");
}

function resolveRegions(subject: QuerySubject, override?: OrionRegionCode[]): OrionRegionCode[] {
  if (override?.length) return [...override];
  const raw = (subject.targetRegions ?? []).map((r) => r.toUpperCase());
  const out = new Set<OrionRegionCode>();
  if (raw.includes("RU") || hasCyrillic(subject.fullName)) out.add("RU");
  if (raw.some((r) => ["UAE", "AE"].includes(r))) out.add("UAE");
  if (raw.length === 0 || raw.some((r) => ["GLOBAL", "INTERNATIONAL", "EU", "US", "INTL"].includes(r))) {
    out.add("INTERNATIONAL");
  }
  if (out.size === 0) out.add(hasCyrillic(subject.fullName) ? "RU" : "INTERNATIONAL");
  return [...out];
}

function toSubjectProfile(subject: QuerySubject): OrionQuerySubjectProfile {
  const parsed = parseSubjectName(subject.fullName);
  const aliases = (subject.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const latinAliases = aliases.filter((a) => !hasCyrillic(a));
  const cyrAliases = aliases.filter((a) => hasCyrillic(a));
  const latinFull = hasCyrillic(subject.fullName) ? transliterateRuToEn(subject.fullName) : subject.fullName;
  const latinVariants = Array.from(new Set([latinFull, ...latinAliases].filter(Boolean)));
  const cyrillicVariants = Array.from(
    new Set([hasCyrillic(subject.fullName) ? subject.fullName.trim() : "", ...cyrAliases].filter(Boolean))
  );
  const firstName = (parsed.givenName ?? "").trim();
  const lastName = (parsed.surname ?? "").trim();
  const patronymic = (parsed.patronymic ?? "").trim();
  const strictTokens = Array.from(
    new Set([subject.fullName.trim(), firstName, lastName, `${lastName} ${firstName}`].filter(Boolean))
  );
  const weakTokens = Array.from(new Set([firstName, patronymic].filter(Boolean)));
  const regionHints = Array.from(
    new Set(
      [...(subject.targetRegions ?? []), ...(subject.location ? [subject.location] : [])]
        .map((h) => String(h ?? "").trim())
        .filter((h) => h && !isRegionCode(h))
    )
  );
  return {
    fullName: subject.fullName.trim(),
    firstName,
    lastName,
    patronymic,
    latinVariants,
    cyrillicVariants,
    strictTokens,
    weakTokens,
    regionHints,
    knownAliases: aliases,
  };
}

function hasStrongIdentityAnchor(query: string, profile: OrionQuerySubjectProfile): boolean {
  const q = normalizeQuery(query);
  const strong = [profile.fullName, profile.lastName, ...profile.latinVariants, ...profile.cyrillicVariants]
    .map(normalizeQuery)
    .filter(Boolean);
  return strong.some((t) => q.includes(t));
}

function mkRow(input: {
  queryPlanId: string;
  queryText: string;
  language: string;
  region: OrionRegionCode;
  priority: QueryPriority;
  purpose: OrionQueryPurpose;
  providerPreference: QueryProviderId[];
  requiredTokens?: string[];
  optionalTokens?: string[];
  identityStrictness: QueryIdentityStrictness;
  maxResultsHint: number;
  internalReason: string;
  profile: OrionQuerySubjectProfile;
}): OrionQuerySpec | null {
  const queryText = input.queryText.trim();
  if (!queryText) return null;
  const normalizedQuery = normalizeQuery(queryText);
  const weakOnly = !hasStrongIdentityAnchor(queryText, input.profile);
  if (weakOnly) {
    return {
      queryPlanId: input.queryPlanId,
      queryId: "",
      query: queryText,
      normalizedQuery,
      language: input.language,
      region: input.region,
      priority: input.priority,
      purpose: input.purpose,
      providerPreference: input.providerPreference,
      requiredTokens: input.requiredTokens ?? [],
      optionalTokens: input.optionalTokens ?? [],
      forbiddenWeakOnlyReason: "suppressed_weak_identity_context",
      identityStrictness: "exploratory",
      maxResultsHint: input.maxResultsHint,
      clientVisible: false,
      internalReason: input.internalReason,
      planRank: 0,
    };
  }
  const queryId = `qp-${stableHash(
    `${input.queryPlanId}|${input.region}|${input.language}|${input.purpose}|${normalizedQuery}`
  )}`;
  return {
    queryPlanId: input.queryPlanId,
    queryId,
    query: queryText,
    normalizedQuery,
    language: input.language,
    region: input.region,
    priority: input.priority,
    purpose: input.purpose,
    providerPreference: input.providerPreference,
    requiredTokens: input.requiredTokens ?? [],
    optionalTokens: input.optionalTokens ?? [],
    identityStrictness: input.identityStrictness,
    maxResultsHint: input.maxResultsHint,
    clientVisible: false,
    internalReason: input.internalReason,
    planRank: 0,
  };
}

function dedupeSpecs(specs: OrionQuerySpec[]): OrionQuerySpec[] {
  const seen = new Set<string>();
  const out: OrionQuerySpec[] = [];
  for (const spec of specs) {
    if (spec.forbiddenWeakOnlyReason) continue;
    const key = `${spec.region}|${spec.language}|${spec.purpose}|${spec.normalizedQuery}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out.map((row, idx) => ({ ...row, planRank: idx + 1 }));
}

function ruBaseVariants(profile: OrionQuerySubjectProfile): string[] {
  const out: string[] = [];
  const { firstName, lastName, patronymic, fullName } = profile;
  if (lastName && firstName && patronymic) out.push(`${lastName} ${firstName} ${patronymic}`);
  if (firstName && patronymic && lastName) out.push(`${firstName} ${patronymic} ${lastName}`);
  if (fullName) out.push(fullName);
  return Array.from(new Set(out.filter(Boolean)));
}

function enBaseVariants(profile: OrionQuerySubjectProfile): string[] {
  const out = new Set<string>();
  for (const v of profile.latinVariants) out.add(v);
  const p = (profile.latinVariants[0] ?? "").split(/\s+/).filter(Boolean);
  if (p.length >= 3) {
    out.add(`${p[0]} ${p[2]}`);
    out.add(`${p[0]} ${p[1]} ${p[2]}`);
    out.add(`${p[2]} ${p[0]} ${p[1]}`);
  } else if (p.length === 2) {
    out.add(`${p[0]} ${p[1]}`);
    out.add(`${p[1]} ${p[0]}`);
  }
  return [...out].filter(Boolean);
}

/**
 * Builds deterministic query plan rows for each region.
 */
export function buildOrionQueryPlanDetailed(
  subject: QuerySubject,
  options: OrionQueryPlanOptions = {}
): OrionQueryPlanBuildResult {
  const maxPrimary = options.maxPrimaryPerRegion ?? DEFAULT_MAX_PRIMARY;
  const regions = resolveRegions(subject, options.regions);
  const profile = toSubjectProfile(subject);
  const queryPlanId = `plan-${stableHash(
    `${profile.fullName}|${regions.join(",")}|${options.includeRiskProbes ? "risk1" : "risk0"}`
  )}`;
  const rows: OrionQuerySpec[] = [];

  for (const region of regions) {
    if (region === "RU") {
      const base = ruBaseVariants(profile).slice(0, maxPrimary);
      for (const b of base) {
        const subjectRow = mkRow({
          queryPlanId,
          queryText: b,
          language: "ru",
          region,
          priority: "primary",
          purpose: "subject_lookup",
          providerPreference: ["yandex", "google"],
          requiredTokens: [profile.lastName, profile.firstName].filter(Boolean),
          optionalTokens: [profile.patronymic].filter(Boolean),
          identityStrictness: "strict",
          maxResultsHint: 20,
          internalReason: "ru_fio_exact",
          profile,
        });
        if (subjectRow) rows.push(subjectRow);
      }
      for (const term of RU_BUSINESS_TERMS) {
        const q = `${profile.fullName} ${term}`.trim();
        const row = mkRow({
          queryPlanId,
          queryText: q,
          language: "ru",
          region,
          priority: "primary",
          purpose: "business_lookup",
          providerPreference: ["yandex", "google"],
          requiredTokens: [profile.lastName].filter(Boolean),
          identityStrictness: "balanced",
          maxResultsHint: 20,
          internalReason: "ru_business_anchor",
          profile,
        });
        if (row) rows.push(row);
      }
      if (options.includeRiskProbes) {
        for (const term of RU_RISK_TERMS) {
          const row = mkRow({
            queryPlanId,
            queryText: `${profile.fullName} ${term}`,
            language: "ru",
            region,
            priority: "risk_probe",
            purpose: "adverse_lookup",
            providerPreference: ["yandex", "google"],
            requiredTokens: [profile.lastName].filter(Boolean),
            identityStrictness: "balanced",
            maxResultsHint: 20,
            internalReason: "ru_adverse_probe",
            profile,
          });
          if (row) rows.push(row);
        }
      }
      for (const term of RU_MEDIA_TERMS) {
        const row = mkRow({
          queryPlanId,
          queryText: `${profile.fullName} ${term}`,
          language: "ru",
          region,
          priority: "primary",
          purpose: "media_lookup",
          providerPreference: ["serper", "google"],
          requiredTokens: [profile.lastName].filter(Boolean),
          identityStrictness: "balanced",
          maxResultsHint: 10,
          internalReason: "ru_media_variant",
          profile,
        });
        if (row) rows.push(row);
      }
      const ruWiki = mkRow({
        queryPlanId,
        queryText: `${profile.fullName} биография wikipedia`.trim(),
        language: "ru",
        region,
        priority: "primary",
        purpose: "wikipedia_lookup",
        providerPreference: ["wikipedia", "google"],
        requiredTokens: [profile.lastName].filter(Boolean),
        identityStrictness: "balanced",
        maxResultsHint: 10,
        internalReason: "ru_wikipedia_lookup",
        profile,
      });
      if (ruWiki) rows.push(ruWiki);
      continue;
    }

    const base = enBaseVariants(profile).slice(0, maxPrimary);
    const context = Array.from(new Set(profile.regionHints)).slice(0, 2);
    for (const b of base) {
      const row = mkRow({
        queryPlanId,
        queryText: b,
        language: "en",
        region,
        priority: "primary",
        purpose: "subject_lookup",
        providerPreference: ["google", "serper"],
        requiredTokens: [profile.lastName].filter(Boolean),
        optionalTokens: [profile.firstName, profile.patronymic].filter(Boolean),
        identityStrictness: b.split(/\s+/).length >= 3 ? "strict" : "balanced",
        maxResultsHint: 20,
        internalReason: "intl_transliteration_variant",
        profile,
      });
      if (row) rows.push(row);
      for (const hint of context) {
        const hinted = mkRow({
          queryPlanId,
          queryText: `${b} ${hint}`.trim(),
          language: "en",
          region,
          priority: "primary",
          purpose: "subject_lookup",
          providerPreference: ["google", "serper"],
          requiredTokens: [profile.lastName].filter(Boolean),
          identityStrictness: "balanced",
          maxResultsHint: 20,
          internalReason: "intl_region_hint_variant",
          profile,
        });
        if (hinted) rows.push(hinted);
      }
    }
    for (const term of EN_BUSINESS_TERMS) {
      const row = mkRow({
        queryPlanId,
        queryText: `${profile.latinVariants[0] ?? profile.fullName} ${term}`,
        language: "en",
        region,
        priority: "primary",
        purpose: "business_lookup",
        providerPreference: ["google", "serper"],
        requiredTokens: [profile.lastName].filter(Boolean),
        identityStrictness: "balanced",
        maxResultsHint: 20,
        internalReason: "intl_business_anchor",
        profile,
      });
      if (row) rows.push(row);
    }
    if (options.includeRiskProbes) {
      for (const term of EN_RISK_TERMS) {
        const row = mkRow({
          queryPlanId,
          queryText: `${profile.latinVariants[0] ?? profile.fullName} ${term}`,
          language: "en",
          region,
          priority: "risk_probe",
          purpose: "adverse_lookup",
          providerPreference: ["google", "serper"],
          requiredTokens: [profile.lastName].filter(Boolean),
          identityStrictness: "balanced",
          maxResultsHint: 20,
          internalReason: "intl_adverse_probe",
          profile,
        });
        if (row) rows.push(row);
      }
    }
    for (const term of EN_MEDIA_TERMS) {
      const row = mkRow({
        queryPlanId,
        queryText: `${profile.latinVariants[0] ?? profile.fullName} ${term}`,
        language: "en",
        region,
        priority: "primary",
        purpose: "media_lookup",
        providerPreference: ["serper", "google"],
        requiredTokens: [profile.lastName].filter(Boolean),
        identityStrictness: "balanced",
        maxResultsHint: 10,
        internalReason: "intl_media_variant",
        profile,
      });
      if (row) rows.push(row);
    }
    const intlWiki = mkRow({
      queryPlanId,
      queryText: `${profile.latinVariants[0] ?? profile.fullName} biography wikipedia`.trim(),
      language: "en",
      region,
      priority: "primary",
      purpose: "wikipedia_lookup",
      providerPreference: ["wikipedia", "google"],
      requiredTokens: [profile.lastName].filter(Boolean),
      identityStrictness: "balanced",
      maxResultsHint: 10,
      internalReason: "intl_wikipedia_lookup",
      profile,
    });
    if (intlWiki) rows.push(intlWiki);
  }

  const weakQuerySuppressedCount = rows.filter((r) => Boolean(r.forbiddenWeakOnlyReason)).length;
  const plan = dedupeSpecs(rows);
  const transliterationVariantCount = plan.filter(
    (r) =>
      r.language === "en" &&
      (r.internalReason.includes("transliteration") || r.internalReason.includes("intl_region_hint_variant"))
  ).length;
  const regionHintCount = profile.regionHints.length;
  const warnings: string[] = [];
  if (weakQuerySuppressedCount > 0) warnings.push("weak_identity_queries_suppressed");
  if (regionHintCount === 0) warnings.push("region_hints_missing");
  return {
    queryPlanId,
    plan,
    weakQuerySuppressedCount,
    transliterationVariantCount,
    regionHintCount,
    warnings,
  };
}

export function buildOrionQueryPlan(
  subject: QuerySubject,
  options: OrionQueryPlanOptions = {}
): OrionQuerySpec[] {
  return buildOrionQueryPlanDetailed(subject, options).plan;
}

export function primaryQueriesForRegion(plan: OrionQuerySpec[], region: OrionRegionCode): OrionQuerySpec[] {
  return plan.filter((q) => q.region === region && q.priority === "primary");
}

export function queriesForRegionPurpose(
  plan: OrionQuerySpec[],
  region: OrionRegionCode,
  purposes: OrionQueryPurpose[]
): OrionQuerySpec[] {
  const allow = new Set(purposes);
  return plan.filter((q) => q.region === region && allow.has(q.purpose));
}
