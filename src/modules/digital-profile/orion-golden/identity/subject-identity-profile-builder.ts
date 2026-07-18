/**
 * R10.7b — Build SubjectIdentityProfile from case + inventory (generic extraction).
 */

import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../types";
import type { SubjectFullNameRu, SubjectIdentityProfile } from "./subject-identity-profile";
import {
  isSelfConflictingNegativeSignal,
  ownNameTextOfVariants,
} from "../analytics/subject-resolution-classifier";

const INN_RE = /\b(?:инн[:\s]*)?(\d{12}|\d{10})\b/gi;
const OGRNIP_RE = /\b(?:огрнип[:\s]*)?(\d{15})\b/gi;
const OGRN_RE = /\b(?:огрн[:\s]*)?(\d{13})\b/gi;

const RU_PATRONYMIC_SUFFIX = /(ович|евич|ич|овна|евна|ична)$/i;

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/** Parse RU FIO: "Фамилия Имя Отчество" or "Имя Фамилия". */
export function parseRuFullName(displayName: string): SubjectFullNameRu | undefined {
  const parts = normalizeSpace(displayName).split(" ").filter(Boolean);
  if (parts.length < 2) return undefined;

  // Prefer "Last First Patronymic" when last token looks like patronymic
  if (parts.length >= 3 && RU_PATRONYMIC_SUFFIX.test(parts[parts.length - 1]!)) {
    return {
      lastName: parts[0]!,
      firstName: parts[1]!,
      patronymic: parts.slice(2).join(" "),
    };
  }

  // "First Last" western-ish order with 2 tokens
  if (parts.length === 2) {
    // Heuristic: if first token ends with -ов/-ев/-ин/-ский treat as last name first
    if (/(ов|ев|ин|ын|ский|цкая|ова|ева|ина)$/i.test(parts[0]!)) {
      return { lastName: parts[0]!, firstName: parts[1]! };
    }
    return { lastName: parts[1]!, firstName: parts[0]! };
  }

  // 3+ without clear patronymic: assume Last First Rest
  return {
    lastName: parts[0]!,
    firstName: parts[1]!,
    patronymic: parts.slice(2).join(" ") || undefined,
  };
}

function transliterateRuToLat(input: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "kh",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "shch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  return lower(input)
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeSpace(v);
    if (!n) continue;
    const key = lower(n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function extractIds(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function hayItem(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.sourceUrl, item.provider].filter(Boolean).join(" ");
}

function buildNameVariants(full: SubjectFullNameRu, displayName: string, aliases: string[]): string[] {
  const { lastName, firstName, patronymic } = full;
  const variants = [
    displayName,
    ...aliases,
    `${lastName} ${firstName}`,
    `${firstName} ${lastName}`,
    patronymic ? `${lastName} ${firstName} ${patronymic}` : "",
    patronymic ? `${firstName} ${patronymic} ${lastName}` : "",
    patronymic ? `${lastName} ${firstName[0]}. ${patronymic[0]}.` : "",
    `${lastName} ${firstName[0]}.`,
  ];
  return uniq(variants);
}

function discoverWrongPatronymics(
  items: RawInventoryItem[],
  full?: SubjectFullNameRu
): string[] {
  if (!full?.patronymic || !full.lastName || !full.firstName) return [];
  const last = lower(full.lastName);
  const first = lower(full.firstName);
  const ownPat = lower(full.patronymic);
  const found = new Set<string>();

  for (const item of items) {
    const text = lower(hayItem(item));
    if (!text.includes(last) || !text.includes(first)) continue;
    // Capture "Фамилия Имя Отчество" with different patronymic
    const re = new RegExp(
      `${escapeRe(last)}\\s+${escapeRe(first)}\\s+([а-яё-]{4,20}(?:ович|евич|ич|овна|евна|ична))`,
      "gi"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const pat = lower(m[1] ?? "");
      if (pat && pat !== ownPat) found.add(normalizeSpace(m[1]!));
    }
  }
  return [...found];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverInnsLinkedToSubject(
  items: RawInventoryItem[],
  full?: SubjectFullNameRu,
  displayName?: string
): string[] {
  /** Count INN co-occurrence only with exact subject FIO (incl. patronymic when known). */
  const counts = new Map<string, number>();
  const exactHints = uniq([
    full?.patronymic
      ? `${full.lastName} ${full.firstName} ${full.patronymic}`
      : "",
    full?.patronymic
      ? `${full.firstName} ${full.patronymic} ${full.lastName}`
      : "",
    displayName ?? "",
  ])
    .map(lower)
    .filter((n) => n.length > 8);

  const last = full ? lower(full.lastName) : "";
  const first = full ? lower(full.firstName) : "";
  const ownPat = full?.patronymic ? lower(full.patronymic) : "";

  for (const item of items) {
    const text = hayItem(item);
    const low = lower(text);
    const hasExactFio = exactHints.some((n) => low.includes(n));
    if (!hasExactFio) continue;

    // Skip pages whose primary FIO uses a different patronymic
    if (last && first && ownPat) {
      const wrongPatRe = new RegExp(
        `${escapeRe(last)}\\s+${escapeRe(first)}\\s+([а-яё-]{4,20}(?:ович|евич|ич|овна|евна|ична))`,
        "gi"
      );
      let m: RegExpExecArray | null;
      let sawWrong = false;
      let sawOwn = false;
      while ((m = wrongPatRe.exec(low)) !== null) {
        const pat = lower(m[1] ?? "");
        if (pat === ownPat) sawOwn = true;
        else if (pat) sawWrong = true;
      }
      if (sawWrong && !sawOwn) continue;
    }

    for (const inn of extractIds(text, INN_RE)) {
      // Prefer personal 12-digit INN; allow 10-digit only with exact FIO + registry context
      if (inn.length === 12) {
        counts.set(inn, (counts.get(inn) ?? 0) + 2);
      } else if (inn.length === 10 && /\b(инн|огрн|егрюл|контрагент|ип\b)/i.test(text)) {
        counts.set(inn, (counts.get(inn) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([inn]) => inn);
}

function discoverOgrn(items: RawInventoryItem[], nameHints: string[]): { ogrn: string[]; ogrnip: string[] } {
  const ogrn = new Set<string>();
  const ogrnip = new Set<string>();
  const hints = nameHints.map(lower).filter((n) => n.length > 4);
  for (const item of items) {
    const text = hayItem(item);
    const low = lower(text);
    if (!hints.some((h) => low.includes(h))) continue;
    for (const id of extractIds(text, OGRNIP_RE)) ogrnip.add(id);
    for (const id of extractIds(text, OGRN_RE)) {
      if (id.length === 13) ogrn.add(id);
    }
  }
  return { ogrn: [...ogrn], ogrnip: [...ogrnip] };
}

function discoverLocations(items: RawInventoryItem[], nameHints: string[]): string[] {
  const locs = new Set<string>();
  const regionRe =
    /\b(тверск\w*|москв\w*|санкт[- ]петербург\w*|ленинград\w*|краснодар\w*|осташков\w*|дубай|оаэ|uae|abu dhabi)\b/gi;
  const hints = nameHints.map(lower).filter((n) => n.length > 4);
  for (const item of items.slice(0, 400)) {
    const text = hayItem(item);
    const low = lower(text);
    if (!hints.some((h) => low.includes(h))) continue;
    let m: RegExpExecArray | null;
    const r = new RegExp(regionRe.source, regionRe.flags);
    while ((m = r.exec(text)) !== null) {
      if (m[1]) locs.add(normalizeSpace(m[1]));
    }
  }
  return [...locs].slice(0, 20);
}

export function buildSubjectIdentityProfile(input: {
  caseId: string;
  subjectName: string;
  aliases?: string[];
  regionHints?: string[];
  /**
   * Case-supplied disambiguation names (known homonyms / unrelated well-known
   * persons for THIS subject). Never defaulted to any baseline subject — a
   * generic profile carries no subject-specific wrong-person literals.
   */
  unrelatedKnownPersons?: string[];
  inventory?: FullEvidenceInventory | { items: RawInventoryItem[] };
}): SubjectIdentityProfile {
  const aliases = uniq(input.aliases ?? []);
  const items = input.inventory?.items ?? [];
  const fullNameRu = parseRuFullName(input.subjectName);
  const nameVariants = fullNameRu
    ? buildNameVariants(fullNameRu, input.subjectName, aliases)
    : uniq([input.subjectName, ...aliases]);

  const transliterations = uniq([
    ...nameVariants.map(transliterateRuToLat),
    ...(fullNameRu
      ? [
          `${transliterateRuToLat(fullNameRu.lastName)} ${transliterateRuToLat(fullNameRu.firstName)}`,
          `${transliterateRuToLat(fullNameRu.firstName)} ${transliterateRuToLat(fullNameRu.lastName)}`,
        ]
      : []),
  ]);

  // Negative identity signals must describe OTHER people. Drop any supplied
  // entry that matches the subject's own name/transliteration/alias — such an
  // entry would poison classification of every genuine subject mention.
  const ownNameText = ownNameTextOfVariants([...nameVariants, ...transliterations]);
  const unrelatedKnownPersons = uniq(input.unrelatedKnownPersons ?? []).filter(
    (w) => !isSelfConflictingNegativeSignal(ownNameText, w)
  );

  const inns = discoverInnsLinkedToSubject(items, fullNameRu, input.subjectName);
  const { ogrn, ogrnip } = discoverOgrn(items, nameVariants);
  const wrongPatronymics = discoverWrongPatronymics(items, fullNameRu);
  const locations = discoverLocations(items, nameVariants);

  const queryVariants = uniq([
    ...nameVariants,
    ...transliterations,
    ...inns.map((inn) => `ИНН ${inn}`),
    ...(fullNameRu ? [`ИП ${fullNameRu.lastName} ${fullNameRu.firstName}`] : []),
  ]);

  return {
    version: "r10-7b-subject-identity-profile-v1",
    caseId: input.caseId,
    displayName: input.subjectName,
    fullNameRu,
    aliases,
    transliterations,
    queryVariants,
    knownIdentifiers: {
      inn: inns.length ? inns : undefined,
      ogrn: ogrn.length ? ogrn : undefined,
      ogrnip: ogrnip.length ? ogrnip : undefined,
      locations: locations.length ? locations : undefined,
    },
    negativeIdentitySignals: {
      wrongPatronymics,
      wrongNames: unrelatedKnownPersons,
      wrongBirthDates: [],
      unrelatedKnownPersons,
    },
    regionHints: uniq(input.regionHints ?? []),
    languageHints: ["ru", "en"],
  };
}
