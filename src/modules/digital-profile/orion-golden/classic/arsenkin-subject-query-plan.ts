/**
 * Universal subject → Arsenkin RU/UAE query plan (pure, no network).
 * Shared by classic render enrich, preflight, and canonical live runner.
 */

import { transliterateRuToEn } from "../../search-surfaces/orion-query-plan";

export type ArsenkinSubjectQueryInput = {
  fullName: string | null | undefined;
  aliases?: readonly string[] | null;
};

export type ArsenkinSubjectQueryPlan = {
  fullName: string;
  queriesRu: string[];
  queriesUae: string[];
  blockers: string[];
};

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/i.test(value);
}

function dedupePreserve(order: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of order) {
    const q = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!q) continue;
    const key = q.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function permutationsOfName(fullName: string): string[] {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [fullName];
  const reversed = [...parts].reverse().join(" ");
  // FIO classic: Surname First Patronymic → First Surname (common search)
  const firstLast =
    parts.length >= 2 ? `${parts[1]} ${parts[0]}` : fullName;
  return [fullName, reversed, firstLast];
}

/** Build deterministic Arsenkin RU/UAE query lists from subject identity. */
export function buildArsenkinSubjectQueryPlan(
  input: ArsenkinSubjectQueryInput
): ArsenkinSubjectQueryPlan {
  const fullName = String(input.fullName ?? "").trim().replace(/\s+/g, " ");
  const aliases = (input.aliases ?? [])
    .map((a) => String(a ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (!fullName && aliases.length === 0) {
    return {
      fullName: "",
      queriesRu: [],
      queriesUae: [],
      blockers: ["empty-subject-name"],
    };
  }

  const name = fullName || aliases[0]!;
  const cyrAliases = aliases.filter((a) => hasCyrillic(a));
  const latinAliases = aliases.filter((a) => !hasCyrillic(a));

  const ruBase = hasCyrillic(name)
    ? [name, ...permutationsOfName(name), ...cyrAliases]
    : [...cyrAliases, name];
  const queriesRu = dedupePreserve(ruBase).slice(0, 5);

  const latinFull = hasCyrillic(name) ? transliterateRuToEn(name) : name;
  const uaeBase = [
    latinFull,
    ...permutationsOfName(latinFull),
    ...latinAliases,
  ];
  const queriesUae = dedupePreserve(uaeBase).slice(0, 4);

  const blockers: string[] = [];
  if (queriesRu.length === 0) blockers.push("empty-queries-ru");

  return { fullName: name, queriesRu, queriesUae, blockers };
}
