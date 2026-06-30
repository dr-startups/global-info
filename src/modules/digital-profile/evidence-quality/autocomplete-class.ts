/**
 * O5.3 — autocomplete / suggestion exposure classification (not subject evidence).
 */

import { isLikelyNamesake, parseSubjectName } from "../risk-classifier/entity-disambiguation";
import {
  buildSubjectFingerprint,
  evaluateIdentityDecision,
  type SubjectFingerprint,
} from "./subject-fingerprint";

export type AutocompleteClass =
  | "EXACT_SUBJECT_QUERY"
  | "SUBJECT_BROAD_QUERY"
  | "ADJACENT_PERSON_QUERY"
  | "NAMESAKE_QUERY"
  | "TYPO_OR_SIMILAR_QUERY"
  | "GENERIC_QUERY"
  | "IRRELEVANT_QUERY"
  | "RISK_QUERY";

const RISK_TERMS =
  /суд|уголов|арест|санкц|sanction|criminal|arrest|fraud|corrupt|terror|extradit|приговор|мошен/i;

const TYPO_PAIRS: Array<[RegExp, RegExp]> = [
  [/томин\b/i, /томилин/i],
  [/томас\b/i, /томилин|константин/i],
  [/tomlin\b/i, /tomilin/i],
  [/tomas\b/i, /tomilin|konstantin/i],
  [/romensky|роменский/i, /томилин|tomilin/i],
];

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "e").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isTypoOrSimilar(query: string, fp: SubjectFingerprint): boolean {
  const q = norm(query);
  for (const [typoRe, anchorRe] of TYPO_PAIRS) {
    if (typoRe.test(q) && fp.surnameTokens.some((t) => anchorRe.test(t) || anchorRe.test(q))) {
      return true;
    }
  }
  for (const token of [...fp.surnameTokens, ...fp.givenTokens]) {
    if (token.length < 4) continue;
    const words = q.split(/\s+/);
    for (const w of words) {
      if (w.length < 4 || w === token) continue;
      const dist = levenshtein(w, token);
      if (dist === 1 || dist === 2) return true;
    }
  }
  return false;
}

export function classifyAutocompleteQuery(
  query: string,
  subjectFullName: string | null | undefined
): AutocompleteClass {
  const text = (query ?? "").trim();
  if (!text) return "IRRELEVANT_QUERY";
  if (RISK_TERMS.test(text)) return "RISK_QUERY";

  if (!subjectFullName?.trim()) return "GENERIC_QUERY";

  const fp = buildSubjectFingerprint({ fullName: subjectFullName });
  const subject = parseSubjectName(subjectFullName);

  if (isTypoOrSimilar(text, fp)) return "TYPO_OR_SIMILAR_QUERY";

  const id = evaluateIdentityDecision(text, fp);
  if (id.decision === "EXACT_SUBJECT") {
    return /биограф|biograph|linkedin|wikipedia|инн|огрн/i.test(text)
      ? "SUBJECT_BROAD_QUERY"
      : "EXACT_SUBJECT_QUERY";
  }
  if (id.decision === "LIKELY_SUBJECT" || id.decision === "POSSIBLE_SUBJECT") {
    return "SUBJECT_BROAD_QUERY";
  }
  if (id.decision === "NAMESAKE" || isLikelyNamesake(text, subject)) {
    return "NAMESAKE_QUERY";
  }
  if (id.decision === "ENTITY_MISMATCH" || id.decision === "INSUFFICIENT_MATCH") {
    if (fp.surnameTokens.some((t) => norm(text).includes(t))) {
      return "ADJACENT_PERSON_QUERY";
    }
    return "IRRELEVANT_QUERY";
  }
  return "GENERIC_QUERY";
}

export const AUTOCOMPLETE_EXPOSURE_GROUPS: Record<
  AutocompleteClass,
  "exact" | "adjacent" | "typo" | "other"
> = {
  EXACT_SUBJECT_QUERY: "exact",
  SUBJECT_BROAD_QUERY: "exact",
  ADJACENT_PERSON_QUERY: "adjacent",
  NAMESAKE_QUERY: "adjacent",
  TYPO_OR_SIMILAR_QUERY: "typo",
  GENERIC_QUERY: "other",
  IRRELEVANT_QUERY: "other",
  RISK_QUERY: "other",
};

export function autocompleteGroupLabel(
  group: "exact" | "adjacent" | "typo" | "other",
  lang: "ru" | "en"
): string {
  const ru: Record<string, string> = {
    exact: "Точные / близкие к субъекту",
    adjacent: "Смежные / однофамильные подсказки",
    typo: "Похожие / ошибочные варианты",
    other: "Прочие подсказки",
  };
  const en: Record<string, string> = {
    exact: "Exact / subject-close queries",
    adjacent: "Adjacent / namesake suggestions",
    typo: "Similar / typo variants",
    other: "Other suggestions",
  };
  return (lang === "en" ? en : ru)[group];
}
