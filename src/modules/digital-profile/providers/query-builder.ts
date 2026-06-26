/**
 * Person search query generation for real SERP connectors.
 *
 * Produces a small, de-duplicated set of person-focused queries with an
 * appropriate language per target region. No scraping or suggestion APIs — just
 * deterministic query strings.
 */

export interface QuerySubject {
  fullName: string;
  aliases?: string[];
  targetRegions?: string[];
  /** Stage N1 — optional context terms for richer person queries. */
  company?: string | null;
  position?: string | null;
  location?: string | null;
}

export interface SearchQuerySpec {
  query: string;
  language: string;
  region?: string;
}

export interface BuildQueriesOptions {
  maxQueries?: number;
  /**
   * Stage N1 — append adverse-context queries (investigation / lawsuit / fraud /
   * sanctions). Only enable when the case lawful basis permits and never for
   * client-facing actors (gated by the caller, not here).
   */
  includeNegative?: boolean;
}

const DEFAULT_MAX_QUERIES = 6;

const NEGATIVE_TERMS: Record<string, string[]> = {
  ru: ["расследование", "суд", "мошенничество", "санкции"],
  en: ["investigation", "lawsuit", "fraud", "sanctions"],
};

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

/** "Ivan Petrov" -> "Petrov Ivan" (only for exactly two name parts). */
function reversedName(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  return `${parts[1]} ${parts[0]}`;
}

function bioTerm(language: string): string {
  return language === "ru" ? "биография" : "biography";
}

/**
 * Picks the languages to search for, based on regions and the name's script.
 * - RU region or a Cyrillic name -> include "ru".
 * - UAE / GLOBAL / international or empty regions -> include "en".
 */
function resolveLanguages(subject: QuerySubject): string[] {
  const regions = (subject.targetRegions ?? []).map((r) => r.toUpperCase());
  const langs = new Set<string>();
  if (regions.includes("RU") || hasCyrillic(subject.fullName)) langs.add("ru");
  if (
    regions.length === 0 ||
    regions.some((r) => ["UAE", "GLOBAL", "INTERNATIONAL", "EU", "US"].includes(r))
  ) {
    langs.add("en");
  }
  if (langs.size === 0) langs.add(hasCyrillic(subject.fullName) ? "ru" : "en");
  return [...langs];
}

export function buildPersonSearchQueries(
  subject: QuerySubject,
  options?: BuildQueriesOptions
): SearchQuerySpec[] {
  const max = options?.maxQueries ?? DEFAULT_MAX_QUERIES;
  const languages = resolveLanguages(subject);
  const primaryRegion = subject.targetRegions?.[0];
  const aliases = (subject.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const company = subject.company?.trim();
  const position = subject.position?.trim();
  const location = subject.location?.trim();

  const specs: SearchQuerySpec[] = [];
  const push = (query: string, language: string) => {
    const q = query.trim().replace(/\s+/g, " ");
    if (q) specs.push({ query: q, language, region: primaryRegion });
  };

  for (const language of languages) {
    push(subject.fullName, language);
    const rev = reversedName(subject.fullName);
    if (rev) push(rev, language);
    if (company) push(`${subject.fullName} ${company}`, language);
    if (position) push(`${subject.fullName} ${position}`, language);
    if (location) push(`${subject.fullName} ${location}`, language);
    push(`${subject.fullName} ${bioTerm(language)}`, language);
    push(`${subject.fullName} ${language === "ru" ? "бизнес" : "business"}`, language);
    for (const alias of aliases) {
      push(alias, language);
      push(`${alias} ${bioTerm(language)}`, language);
    }
    if (options?.includeNegative) {
      for (const term of NEGATIVE_TERMS[language] ?? NEGATIVE_TERMS.en) {
        push(`${subject.fullName} ${term}`, language);
      }
    }
  }

  // De-duplicate by language + normalized query, then cap.
  const seen = new Set<string>();
  const deduped: SearchQuerySpec[] = [];
  for (const spec of specs) {
    const key = `${spec.language}|${spec.query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(spec);
    if (deduped.length >= max) break;
  }
  return deduped;
}
