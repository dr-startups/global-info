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
  primaryIdentityRu: string | null;
  primaryIdentityUae: string | null;
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

/**
 * A plan line is a query a human would actually type.
 *
 * Input order is the FIO one — "Surname First Patronymic" (see parseSubjectName).
 * The list used to carry the fully reversed order as well, and that string was
 * sent to the paid provider: a live run bought 10 organic rows for "юрьевич
 * олег тиньков" and printed that query to the client as the SERP caption.
 * Human orders are these three: full FIO, "First Patronymic Surname" and the
 * most common "First Surname".
 */
function permutationsOfName(fullName: string): string[] {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [fullName];
  const firstLast = `${parts[1]} ${parts[0]}`;
  if (parts.length === 2) return [fullName, firstLast];
  return [fullName, `${parts[1]} ${parts[2]} ${parts[0]}`, firstLast];
}

/**
 * Latin spellings follow the decision already recorded for enBaseVariants:
 * full spelling plus "First Surname". The patronymic is not typed outside the
 * Russian-speaking world, and the reversed order is not a spelling of a name
 * at all — "Filippovich Viktor Rashnikov" went to the UAE contour for money.
 *
 * Only ever called on the transliteration of our own Cyrillic FIO: that is the
 * single Latin string whose part order we know. Rearranging any other one
 * invents a query — "Mohammed bin Rashid Al Maktoum" would give "bin
 * Mohammed", and an analyst-supplied alias is already in the order a human
 * types.
 */
function transliteratedFioVariants(input: string): string[] {
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [input];
  return [input, `${parts[1]} ${parts[0]}`];
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
      primaryIdentityRu: null,
      primaryIdentityUae: null,
      blockers: ["empty-subject-name"],
    };
  }

  const name = fullName || aliases[0]!;
  const cyrAliases = aliases.filter((a) => hasCyrillic(a));
  const latinAliases = aliases.filter((a) => !hasCyrillic(a));

  // Rearranging is allowed for our own FIO only. With an empty fullName the
  // subject name is an alias, and its part order was set by whoever wrote it:
  // "Олег Юрьевич Тиньков" would give "Юрьевич Тиньков Олег" and "Юрьевич Олег".
  const ownFio = fullName && hasCyrillic(fullName) ? fullName : "";
  const ruBase = hasCyrillic(name)
    ? [name, ...(ownFio ? permutationsOfName(ownFio) : []), ...cyrAliases]
    : [...cyrAliases];
  const queriesRu = dedupePreserve(ruBase).slice(0, 5);

  // UAE plan: confirmed Latin aliases go as the analyst wrote them; with no
  // alias the plan is built from our own FIO, and only that string may be
  // rearranged. Anything else — a Latin fullName, a name taken from an alias —
  // goes as it is, transliterated when Cyrillic: changing the alphabet keeps
  // the order, guessing the order does not.
  const latinFromOwnFio = ownFio ? transliterateRuToEn(ownFio) : "";
  const uaeBase =
    latinAliases.length > 0
      ? latinAliases
      : latinFromOwnFio
        ? transliteratedFioVariants(latinFromOwnFio)
        : [hasCyrillic(name) ? transliterateRuToEn(name) : name];
  const queriesUae = dedupePreserve(uaeBase).slice(0, 4);

  const blockers: string[] = [];
  if (queriesRu.length === 0) blockers.push("empty-queries-ru");
  if (queriesUae.length === 0) blockers.push("empty-queries-uae");

  return {
    fullName: name,
    queriesRu,
    queriesUae,
    primaryIdentityRu: queriesRu[0] ?? null,
    primaryIdentityUae: queriesUae[0] ?? null,
    blockers,
  };
}
