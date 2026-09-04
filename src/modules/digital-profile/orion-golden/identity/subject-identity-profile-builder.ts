/**
 * R10.7b — Build SubjectIdentityProfile from case + inventory (generic extraction).
 */

import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../types";
import type {
  DiscoveredInn,
  SubjectFullNameRu,
  SubjectIdentityProfile,
} from "./subject-identity-profile";
import { innsInText } from "../analytics/subject-anchors";
import { transliterateRuToLat } from "./transliterate-ru";
import {
  isSelfConflictingNegativeSignal,
  ownNameTextOfVariants,
} from "../analytics/subject-resolution-classifier";
import { parseSubjectName } from "../../risk-classifier/entity-disambiguation";

const INN_RE = /\b(?:инн[:\s]*)?(\d{12}|\d{10})\b/gi;
const OGRNIP_RE = /\b(?:огрнип[:\s]*)?(\d{15})\b/gi;
const OGRN_RE = /\b(?:огрн[:\s]*)?(\d{13})\b/gi;

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/**
 * Parse RU FIO in whichever order it was written.
 *
 * A thin wrapper on purpose: "where is the surname here" is answered once, by
 * parseSubjectName. While this file had its own positional answer, the profile
 * of a live run recorded lastName "Умар" for "Умар Назарович Кремлев".
 */
export function parseRuFullName(displayName: string): SubjectFullNameRu | undefined {
  const parsed = parseSubjectName(displayName);
  if (!parsed.surname || !parsed.givenName) return undefined;
  return {
    lastName: parsed.surname,
    firstName: parsed.givenName,
    patronymic: parsed.patronymic ?? undefined,
  };
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

/**
 * ИНН, встреченные рядом с точным ФИО, — **предложения оператору**.
 *
 * Раньше три верхних по частоте уезжали в `knownIdentifiers.inn` и работали как
 * идентификаторы субъекта: на прогоне DPA-2026-0049 два из трёх принадлежали
 * рязанскому и московскому однофамильцам, и 44 материала чужих людей получили
 * `strong_identifier_match` 0.98. Совпадение ФИО — единственное, что связывало
 * эти ИНН с субъектом, то есть корпус подтверждал сам себя.
 *
 * Теперь результат едет с адресами, по которым его видно, и идентификатором
 * становится только после того, как оператор назовёт его сам.
 */
function discoverInnsLinkedToSubject(
  items: RawInventoryItem[],
  full?: SubjectFullNameRu,
  displayName?: string
): DiscoveredInn[] {
  /** Count INN co-occurrence only with exact subject FIO (incl. patronymic when known). */
  const counts = new Map<string, number>();
  const urls = new Map<string, string[]>();
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

    // Контрольная сумма отсекает то, что ИНН не является: хвост дроби
    // «11398.600000000002» на странице реестра давал «ИНН 600000000002».
    for (const inn of innsInText(text)) {
      const weight = inn.length === 12 ? 2 : 1;
      counts.set(inn, (counts.get(inn) ?? 0) + weight);
      const url = String(item.sourceUrl ?? "").trim();
      if (url) {
        const list = urls.get(inn) ?? [];
        if (!list.includes(url)) list.push(url);
        urls.set(inn, list);
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([inn]) => ({ inn, regionCode: inn.slice(0, 2), urls: (urls.get(inn) ?? []).slice(0, 5) }));
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

  /*
   * Запросы по добытому ИНН не строятся: искать по чужому идентификатору
   * значит покупать материалы о другом человеке за деньги клиента.
   */
  const queryVariants = uniq([
    ...nameVariants,
    ...transliterations,
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
    ...(inns.length ? { discovered: { inn: inns } } : {}),
    /*
     * Города из корпуса больше не добываются. `discoverLocations` собирал их по
     * словарю («тверск|москв|краснодар|осташков|дубай») и клал в
     * `knownIdentifiers.locations`, откуда они уезжали в контекст
     * классификации: корпус подтверждался тем, что система сама из него
     * достала. Вдобавок регэксп стоял на `\b` и на кириллице не срабатывал
     * вовсе — то есть поле годами было пустым, а читатели кода считали иначе.
     * Регион признаком субъекта не является и по решению владельца (0054, №7).
     */
    knownIdentifiers: {
      ogrn: ogrn.length ? ogrn : undefined,
      ogrnip: ogrnip.length ? ogrnip : undefined,
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
