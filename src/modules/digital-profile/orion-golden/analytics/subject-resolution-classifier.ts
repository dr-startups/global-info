/**
 * Prompt 2 — subject resolution classifier.
 * Classifies every composite observation as SUBJECT_MATCH / LIKELY_SUBJECT /
 * AMBIGUOUS / OTHER_SUBJECT / INSUFFICIENT_IDENTIFIERS.
 *
 * Surname-only never becomes SUBJECT_MATCH. Surname + context (or shared
 * confirmed domain / soft-surface full-name phrase / subject-query signal §2.2)
 * may become LIKELY_SUBJECT (confidence 0.6–0.7) — visible in SERP/appendix/
 * matrix «Требует подтверждения» but never in KPI «О субъекте».
 * Only SUBJECT_MATCH may affect KPI.
 *
 * §2.2 methodology: the SERP query is operator intent, not content evidence.
 * When we searched the subject's full name and the hit still only shows the
 * surname in title/snippet, that is a weak positive prior → LIKELY_SUBJECT
 * (`surname_with_subject_query`), never SUBJECT_MATCH. Namesake conflicts and
 * mixed identity signals remain stronger and are not upgraded by the query.
 *
 * §2.3 morphology: token match uses deterministic Russian case-form generation
 * (ending tables, no stem libraries) plus Unicode letter-boundary matching.
 * The old «drop last letter» heuristic is gone — it false-fired on longer
 * derivatives (Петров ⊂ Петровский). Latin/translit tokens keep exact
 * boundary match only.
 */

import { createHash } from "node:crypto";
import {
  conflictingPatronymics,
  foreignGivenNamesInTriple,
  foreignPatronymicsInQueryLine,
} from "./patronymic-conflict";
import { transliterateRuToLat } from "../identity/transliterate-ru";
import { transliterateRuToEn } from "../../search-surfaces/orion-query-plan";
import { publicDomainOf } from "./public-domain";
import {
  anchorHitsInText,
  foreignBirthDates,
  hasSubjectAnchors,
  innsInText,
  type SubjectAnchors,
} from "./subject-anchors";
import type { RawInventoryItem } from "../types";
import {
  SUBJECT_RESOLUTION_SCHEMA_VERSION,
  SubjectResolutionSchema,
  type SubjectResolution,
  type SubjectResolutionItem,
} from "../contracts/subject-resolution";
import type { SubjectRelevanceDecision } from "../contracts/common";

/** A specific homonym/namesake of the subject and its disambiguating noise. */
export type NamesakeProfile = {
  /** Client-facing label for the OTHER person, e.g. "Иван Петров (актёр)". */
  label: string;
  /** Lowercased tokens whose presence indicates this OTHER subject. */
  noiseTerms: string[];
};

export type SubjectIdentity = {
  displayName: string;
  lastName: string;
  /** Surname variants incl. transliterations (subject-supplied, not hardcoded). */
  lastNameVariants: string[];
  firstNames: string[]; // ru + translit
  patronymics: string[];
  aliases: string[];
  strongIdentifiers: string[]; // e.g. INN
  contextIdentifiers: string[]; // business context words strengthening a match
  wrongFirstNames: string[];
  wrongPatronymics: string[];
  unrelatedKnownPersons: string[];
  /** Namesake noise (per homonym) — entirely subject-supplied, never hardcoded. */
  namesakeProfiles: NamesakeProfile[];
  /** Flattened noise terms across all namesakes (convenience for matching). */
  namesakeNoise: string[];
  /**
   * Признаки субъекта сверх имени, названные оператором до сбора.
   *
   * Их наличие переключает лестницу решений: полное совпадение ФИО без якоря
   * перестаёт быть подтверждением принадлежности. Режим выводится из данных, а
   * не из слова-флага — у профилей прежних кейсов якорей нет, и они судятся
   * прежней лестницей слово в слово.
   */
  anchors?: SubjectAnchors;
};

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

/**
 * Слово без различий, которые для написания имени различиями не являются:
 * регистр, «ё»/«е» и диакритика («Holmström» = «Holmstrom»).
 *
 * Раньше формы фамилии сравнивались первыми четырьмя буквами. Это догадка, и
 * она била по своим: у субъекта, чья фамилия произведена от его же имени
 * («Иванов Иван Иванович»), собственное латинское имя признавалось формой
 * фамилии и выпадало из имён, а материал о самом клиенте становился «одной
 * фамилией».
 */
function foldWord(word: string): string {
  return norm(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Склейка написаний: регистр и «ё»/«е» различиями не считаются. */
function uniqByNorm(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = norm(v);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Латинские написания части имени — вывод из неё самой, обеими школами.
 *
 * Школы в проекте две, и расходятся они на «ё»: `transliterateRuToLat`
 * порождает транслитерации профиля (Кремлёв → kremlev), `transliterateRuToEn`
 * строит поисковые запросы (Кремлёв → Kremlyov). В собранных материалах
 * встречаются обе, и собственная статья субъекта
 * (`en.wikipedia.org/wiki/Umar_Kremlyov`) написана как раз по второй. Взять
 * одну — значит оставить половину материалов субъекта без фамилии; взять обе
 * второго ответа не заводит: обе становятся формами фамилии, а не именами.
 *
 * Оговорка, названная ревью 02.09.2026 и намеренно оставленная: на нынешнем
 * входе `transliterateRuToLat` **избыточна**. Сюда подаются и падежные формы
 * (`generateRussianNameForms`), а таблица падежей приводит «ё» к «е» до
 * склонения, поэтому `transliterateRuToEn` от нормализованного именительного
 * даёт ровно то, что дала бы `transliterateRuToLat` от исходного. Мутация
 * «убрать `transliterateRuToLat`» не красит ни одного теста — поймать её
 * нечем, и это сказано вслух, чтобы следующий читатель не удалил её как дубль
 * вслепую: она перестанет быть избыточной ровно в тот день, когда падежную
 * ветку сузят. Убрать её вместе с этой оговоркой — отдельный шаг (опись).
 */
function latinFormsOfNameParts(parts: string[]): string[] {
  return uniqByNorm(
    parts
      .flatMap((p) => [transliterateRuToLat(p), transliterateRuToEn(p).toLowerCase()])
      .map((f) => f.trim())
      .filter((f) => f.length > 2)
  );
}

function itemText(item: RawInventoryItem): string {
  // item.query is what WE searched for, not what the content says —
  // including it would turn every result of a subject query into a match.
  // Exception: query-является-контентом surfaces (suggestions/PAA) store the
  // line in title, so title/snippet/sourceUrl are sufficient.
  return norm([item.title, item.snippet, item.sourceUrl].filter(Boolean).join(" "));
}

/** Search query that produced this hit (operator intent — not content). */
function itemQueryText(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return norm(String(item.query ?? meta.queryText ?? meta.query ?? ""));
}

/**
 * True when the query carries surname + given name of the subject.
 * Used only as a LIKELY upgrade prior (§2.2), never as content evidence.
 */
export function queryContainsSubjectFullName(
  query: string,
  subject: SubjectIdentity
): boolean {
  const q = norm(query);
  if (q.length < 5) return false;
  const hasLast =
    matchesToken(q, subject.lastName) ||
    subject.lastNameVariants.some((v) => matchesToken(q, v));
  const hasFirst = subject.firstNames.some((n) => matchesToken(q, n));
  if (hasLast && hasFirst) return true;
  const display = norm(subject.displayName);
  return display.length >= 6 && q.includes(display);
}

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return String(meta.surface ?? item.evidenceType ?? "").toLowerCase();
}

/** Soft SERP lines where a full-name phrase is suggestive, not confirmatory. */
function isSuggestionOrPaaSurface(surface: string): boolean {
  return /suggest|paa|people_also|related/.test(surface);
}

/**
 * Поверхности, где строка запроса и есть весь материал.
 *
 * Список свой, а не общий с `isSuggestionOrPaaSurface`: тот управляет
 * повышением до LIKELY_SUBJECT, а живые подсказки приходят с
 * `surface: "autocomplete"`, которого он не знает, — расширять его здесь
 * значило бы менять решения шире задачи.
 */
function isQueryLineSurface(surface: string): boolean {
  return /autocomplete|suggest|paa|people_also|related/.test(surface);
}

/** Домен публикации; служебные схемы доменом не считаются (шаг 13, C2). */
const domainOfUrl = publicDomainOf;

/** Display-name or first+last phrase present in text (upgrade path for soft surfaces). */
function hasFullNamePhrase(text: string, subject: SubjectIdentity): boolean {
  const display = norm(subject.displayName);
  if (display.length >= 6 && text.includes(display)) return true;
  const first = subject.firstNames.find((n) => matchesToken(text, n));
  const last =
    matchesToken(text, subject.lastName) ||
    subject.lastNameVariants.some((v) => matchesToken(text, v));
  return Boolean(first && last);
}

/** True when the token is primarily Cyrillic (Russian inflection applies). */
function isPrimarilyCyrillic(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const cyr = letters.replace(/[^а-я]/gu, "").length;
  return cyr >= letters.length / 2;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary presence of `form` in `text`. JS `\b` is ASCII-centric, so
 * boundaries are expressed via `\p{L}` / `\p{N}` lookarounds (Unicode-aware).
 */
function hasBoundedForm(text: string, form: string): boolean {
  if (!form || form.length < 2) return false;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(form)}(?![\\p{L}\\p{N}_])`,
    "u"
  );
  return re.test(text);
}

/**
 * Deterministic Russian case-form set for a nominative person-name token.
 * Ending tables only — no morphological libraries, no «trim last letter».
 * Covers common surname/given-name/patronymic patterns used in SERP text.
 */
export function generateRussianNameForms(lemma: string): string[] {
  const n = norm(lemma);
  if (n.length < 3) return n ? [n] : [];
  const forms = new Set<string>([n]);

  // Masculine surnames -ов/-ев/-ин/-ын (Петров → Петрова/Петрову/Петровым/Петровой).
  if (n.length >= 4 && /(ов|ев|ин|ын)$/u.test(n)) {
    for (const suf of ["а", "у", "ым", "е", "ой", "ых", "ыми", "ам", "ами", "ы"]) {
      forms.add(n + suf);
    }
    return [...forms];
  }

  // Adjectival surnames -ский/-цкий/-ской/-цкой.
  if (n.length >= 6 && /(ский|цкий|ской|цкой)$/u.test(n)) {
    const base = n.replace(/(ий|ой)$/u, "");
    for (const suf of [
      "ий",
      "ой",
      "ого",
      "ому",
      "им",
      "ом",
      "ая",
      "ую",
      "ое",
      "ие",
      "их",
      "ими",
      "ым",
      "ем",
    ]) {
      forms.add(base + suf);
    }
    return [...forms];
  }

  // Given names -ей/-ай (Сергей, Николай, Алексей).
  if (n.length >= 4 && /[аеоуыэюя]й$/u.test(n)) {
    const stem = n.slice(0, -1);
    for (const suf of ["й", "я", "ю", "ем", "е", "и"]) {
      forms.add(stem + suf);
    }
    return [...forms];
  }

  // Soft-sign names (Игорь, Юрий is -ий handled below via consonant? Юрий → ий).
  if (n.length >= 4 && n.endsWith("ь")) {
    const stem = n.slice(0, -1);
    for (const suf of ["ь", "я", "ю", "ем", "е"]) {
      forms.add(stem + suf);
    }
    return [...forms];
  }

  // -ий adjectival / given (Юрий, Василий) — not -ский (handled above).
  if (n.length >= 4 && n.endsWith("ий") && !/(ский|цкий)$/u.test(n)) {
    const stem = n.slice(0, -2);
    for (const suf of ["ий", "ия", "ию", "ием", "ии", "ья", "ью", "ьем", "ье"]) {
      forms.add(stem + suf);
    }
    return [...forms];
  }

  // Feminine -а/-я (Глинка, Анна, Мария; also -овна/-евна patronymics).
  if (n.length >= 4 && /[ая]$/u.test(n)) {
    const stem = n.slice(0, -1);
    if (n.endsWith("я")) {
      for (const suf of ["я", "и", "ю", "ей", "ею"]) forms.add(stem + suf);
    } else {
      for (const suf of ["а", "ы", "е", "у", "ой", "ою"]) forms.add(stem + suf);
      // After velars/hushers genitive uses -и (Глинки, Ольги).
      if (/[кгхшщжч]$/u.test(stem)) forms.add(stem + "и");
    }
    return [...forms];
  }

  // Consonant-final lemmas (Олег, Пётр→петр, Михайлович): add core oblique endings.
  if (n.length >= 3 && /[бвгджзклмнпрстфхцчшщ]$/u.test(n)) {
    for (const suf of ["а", "у", "ом", "е", "ы", "ов", "ам", "ами", "ах", "ем"]) {
      forms.add(n + suf);
    }
    return [...forms];
  }

  return [...forms];
}

/**
 * Morphology-tolerant token match (§2.3): Cyrillic names expand to an explicit
 * case-form set; Latin/translit keeps exact form. Matching is always
 * letter-boundary — never bare substring / never «stem −1».
 */
export function matchesToken(text: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 3) return false;
  const forms = isPrimarilyCyrillic(n) ? generateRussianNameForms(n) : [n];
  return forms.some((f) => hasBoundedForm(text, f));
}

/**
 * True when a negative identity signal would fire on the subject's OWN name
 * text (same bounded morphology matching the classifier uses). Such an entry is
 * self-conflicting: it marks every genuine mention of the subject as a
 * namesake conflict. Negative signals must describe OTHER people only
 * (e.g. a homonym's distinct patronymic), never the subject's own name,
 * transliteration or alias.
 */
export function isSelfConflictingNegativeSignal(
  ownNameText: string,
  entry: string
): boolean {
  const n = norm(entry);
  if (n.length < 3) return false;
  return matchesToken(ownNameText, entry) || ownNameText.includes(n);
}

/** Normalized own-name haystack (one variant per line) for self-conflict checks. */
export function ownNameTextOfVariants(variants: Array<string | undefined | null>): string {
  return variants
    .filter((v): v is string => Boolean(v && v.trim()))
    .map(norm)
    .join("\n");
}

export function classifySubjectRelevance(
  item: RawInventoryItem,
  subject: SubjectIdentity
): SubjectResolutionItem {
  const text = itemText(item);
  const evidenceRef = `inventory:${item.inventoryId}`;
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;

  // Compliance hits: decision comes from DatabaseProfile.reviewStatus.
  // Surname/token F1 must not reclassify LexisNexis / Dow Jones rows.
  if (meta.skipTextClassifier === true || meta.identityFromReview === true) {
    const reviewStatus = String(meta.reviewStatus ?? item.classification ?? "").toUpperCase();
    const confirmed = reviewStatus === "MATCH_CONFIRMED" || reviewStatus === "CONFIRMED";
    return {
      evidenceRef,
      decision: confirmed ? "SUBJECT_MATCH" : "AMBIGUOUS",
      confidence: confirmed ? 0.95 : 0.55,
      matchedIdentifiers: confirmed ? ["compliance_review_confirmed"] : [],
      conflictingIdentifiers: [],
      reasonCode: confirmed ? "compliance_match_confirmed" : "compliance_review_pending",
    };
  }

  const hasSurname =
    [subject.lastName, ...subject.lastNameVariants].some((s) => matchesToken(text, s)) ||
    subject.aliases.some((a) => norm(a).length > 4 && text.includes(norm(a)));

  const matchedIdentifiers: string[] = [];
  const conflictingIdentifiers: string[] = [];

  if (hasSurname) matchedIdentifiers.push(subject.lastName);

  const matchedFirstName = subject.firstNames.find((n) => matchesToken(text, n));
  if (matchedFirstName) matchedIdentifiers.push(matchedFirstName);

  const matchedPatronymic = subject.patronymics.find(
    (p) => norm(p).length > 3 && matchesToken(text, p)
  );
  if (matchedPatronymic) matchedIdentifiers.push(matchedPatronymic);

  const matchedStrong = subject.strongIdentifiers.find(
    (s) => s.length > 4 && text.includes(norm(s))
  );
  if (matchedStrong) matchedIdentifiers.push(matchedStrong);

  const matchedContext = subject.contextIdentifiers.filter(
    (c) => norm(c).length > 3 && text.includes(norm(c))
  );
  matchedIdentifiers.push(...matchedContext);

  for (const w of [...subject.wrongFirstNames, ...subject.unrelatedKnownPersons]) {
    if (norm(w).length > 3 && matchesToken(text, w)) conflictingIdentifiers.push(w);
  }
  for (const w of subject.wrongPatronymics) {
    if (norm(w).length > 3 && matchesToken(text, w)) conflictingIdentifiers.push(w);
  }
  // Чужое отчество рядом с фамилией субъекта выводится, а не заполняется
  // оператором вручную: «Дуров Павел Юрьевич» — другой человек, и на свежем
  // кейсе, где отрицательные признаки не заполнены, защиты не было (шаг 13, C9).
  const derivedPatronymicConflicts = conflictingPatronymics(text, subject);
  conflictingIdentifiers.push(...derivedPatronymicConflicts);
  /*
   * На поверхностях-строках чужое отчество распознаётся в обоих алфавитах.
   *
   * «viktor feliksovich vekselberg ofac» — санкционная подсказка о другом
   * человеке — получала «недостаточно признаков» (совпало одно имя) и уходила
   * в негативный профиль субъекта: вывод о чужом отчестве работал только
   * кириллицей и только рядом с фамилией субъекта, которой в строке нет.
   * В короткой строке запроса ловушки «биография называет родню» нет по
   * построению, поэтому связки «имя субъекта + чужое отчество» здесь
   * достаточно.
   */
  const queryLinePatronymicConflicts = isQueryLineSurface(surfaceOf(item))
    ? foreignPatronymicsInQueryLine(text, subject)
    : [];
  conflictingIdentifiers.push(...queryLinePatronymicConflicts);
  /*
   * Чужое имя в именной тройке — и область, в которой его читают.
   *
   * Прогон DPA-2026-0046 привёл в отчёт три записи ИП посторонних людей с их
   * ИНН: фамилия и отчество совпали с субъектом, а имя («Ivan», «Oleg»,
   * «Andrei») не проверял никто.
   *
   * Область — решение шага, а не деталь. Строка-подсказка читается целиком:
   * она и есть весь материал. У страницы читается **только заголовок**:
   * сниппет и биография называют родню и партнёров («брат — Иван Анатольевич
   * Борисов»), и на этой ловушке 14.08.2026 статья о самом субъекте была
   * объявлена чужой, уведя за собой 26 материалов.
   */
  const givenNameScope = isQueryLineSurface(surfaceOf(item)) ? text : norm(item.title ?? "");
  const derivedGivenNameConflicts = foreignGivenNamesInTriple(givenNameScope, subject);
  conflictingIdentifiers.push(...derivedGivenNameConflicts);
  for (const n of subject.namesakeNoise) {
    if (n.length > 2 && text.includes(norm(n))) conflictingIdentifiers.push(n);
  }

  /*
   * Якоря субъекта: признаки сверх имени, названные оператором.
   *
   * Прогон DPA-2026-0049 показал цену их отсутствия: полное ФИО без якоря
   * считалось подтверждением, и в отчёт о судье попали офтальмолог, депутат и
   * четыре ИП — все полные тёзки, у которых по построению нет ни чужого
   * отчества, ни чужого имени, то есть конфликта, которым их можно отличить.
   */
  const anchors = subject.anchors;
  const anchorMode = hasSubjectAnchors(anchors);
  const anchorHits = anchors
    ? anchorHitsInText({ text, url: item.sourceUrl ?? null, anchors })
    : [];
  const strongAnchor = anchorHits.find((h) => h.strong) ?? null;
  const weakAnchor = anchorHits.find((h) => !h.strong) ?? null;
  for (const hit of anchorHits) matchedIdentifiers.push(hit.value);

  /*
   * Чужая дата рождения — конфликт во всех режимах, а не только под якорями.
   *
   * Она приходит из карточки кейса, оператор вводил её и раньше, и своей
   * стороне решения она ничего не стоит: у депутата гордумы Краснодара в
   * сниппете стоит «Родился: 10 августа 1983 года» — этого достаточно, чтобы
   * не приписывать его материалы судье, родившемуся 30.11.1977.
   */
  const foreignDates = foreignBirthDates(text, anchors?.birthDate ?? null);
  conflictingIdentifiers.push(...foreignDates);

  /*
   * ИНН читается из текста только со словом, которое так его и называет, и
   * сверяется с ИНН оператора. Свой ИНН на странице сильнее чужого: карточка
   * организации называет и соучредителей.
   */
  const ownInnHit = anchorHits.some((h) => h.kind === "inn");
  const innsOnPage = anchors ? innsInText(text) : [];
  const foreignInns =
    anchors && anchors.inn.length > 0 && !ownInnHit
      ? innsOnPage.filter((i) => !anchors.inn.includes(i))
      : [];
  conflictingIdentifiers.push(...foreignInns);
  /** Реестровая страница с чужим ИНН при неизвестном своём — не проверить. */
  const unverifiedRegistryInn =
    anchorMode && (anchors?.inn.length ?? 0) === 0 && innsOnPage.length > 0;

  let decision: SubjectRelevanceDecision;
  let reasonCode: string;
  let confidence: number;

  const hasGivenName = Boolean(matchedFirstName || matchedPatronymic || matchedStrong);
  const hasConflict = conflictingIdentifiers.length > 0;

  if (!hasSurname && !hasGivenName) {
    if (hasConflict) {
      decision = "OTHER_SUBJECT";
      reasonCode = "conflicting_identity_no_subject_tokens";
      confidence = 0.9;
    } else {
      decision = "INSUFFICIENT_IDENTIFIERS";
      reasonCode = "no_subject_tokens";
      confidence = 0.85;
    }
  } else if (
    (derivedPatronymicConflicts.length > 0 ||
      queryLinePatronymicConflicts.length > 0 ||
      derivedGivenNameConflicts.length > 0) &&
    !matchedStrong &&
    !strongAnchor
  ) {
    /*
     * Именная тройка названа целиком, и чужой в ней — отчество или имя.
     *
     * В русской системе имён это решающий признак другого человека, а не повод
     * для сомнений. Сильный идентификатор (ИНН) такой вывод перебивает.
     *
     * Ветка стоит **выше** общей «фамилия плюс чужой контекст»
     * (`namesake_conflict`): выведенное правило знает, что именно сработало, и
     * называет это в артефактах — иначе латинская тройка получала бы код
     * «однофамилец», по которому не видно, отчество разошлось или имя.
     */
    decision = "OTHER_SUBJECT";
    reasonCode =
      derivedPatronymicConflicts.length > 0
        ? "patronymic_conflict"
        : queryLinePatronymicConflicts.length > 0
          ? "suggestion_foreign_patronymic"
          : "given_name_conflict";
    confidence = 0.9;
  } else if ((foreignDates.length > 0 || foreignInns.length > 0) && !strongAnchor && !matchedStrong) {
    /*
     * Чужой различитель на странице и ни одного своего: это другой человек.
     *
     * Ветка стоит выше общей «оба сигнала сразу», потому что называет, что
     * именно разошлось, — дата рождения или ИНН. Свой якорь её перебивает:
     * страница, где найдены и свой признак, и чужой, — страница о двух людях,
     * и она уходит в неоднозначные ниже.
     */
    decision = "OTHER_SUBJECT";
    reasonCode = foreignDates.length > 0 ? "foreign_birth_date" : "foreign_inn";
    confidence = 0.9;
  } else if (hasConflict && !hasGivenName) {
    // Surname + composer/wrong-person context → other subject.
    decision = "OTHER_SUBJECT";
    reasonCode = "namesake_conflict";
    confidence = 0.9;
  } else if (hasConflict && hasGivenName) {
    // Both subject identifiers and conflicting identity — ambiguous, review.
    decision = "AMBIGUOUS";
    reasonCode = "mixed_identity_signals";
    confidence = 0.5;
  } else if (hasSurname && hasGivenName && anchorMode) {
    /*
     * Строгая ветка: имя названо, и решает признак сверх имени.
     *
     * Полное ФИО без якоря — гипотеза, а не факт: она печатается как
     * «принадлежность не подтверждена», не входит ни в темы, ни в уровень
     * риска, ни в счёт «о субъекте». Это и есть правка, ради которой шаг
     * заведён.
     */
    if (strongAnchor) {
      decision = "SUBJECT_MATCH";
      reasonCode = `full_name_with_anchor:${strongAnchor.kind}`;
      confidence = strongAnchor.kind === "inn" ? 0.98 : 0.92;
    } else if (weakAnchor) {
      decision = "LIKELY_SUBJECT";
      reasonCode = "full_name_with_weak_anchor";
      confidence = 0.7;
    } else if (unverifiedRegistryInn) {
      decision = "AMBIGUOUS";
      reasonCode = "registry_inn_unverified";
      confidence = 0.45;
    } else {
      decision = "AMBIGUOUS";
      reasonCode = "full_name_no_anchor";
      confidence = 0.5;
    }
  } else if (hasSurname && hasGivenName) {
    decision = "SUBJECT_MATCH";
    reasonCode = matchedStrong
      ? "strong_identifier_match"
      : matchedContext.length > 0
        ? "full_name_with_context"
        : "full_name_match";
    confidence = matchedStrong ? 0.98 : matchedContext.length > 0 ? 0.92 : 0.85;
  } else if (hasSurname && !hasGivenName && anchorMode) {
    /*
     * Под якорями принадлежность подтверждает признак, а не запрос.
     *
     * Правило §2.2 («искали полное имя — значит, одна фамилия в заголовке всё
     * же о субъекте») старше якорей, и на прогоне DPA-2026-0053 оно дало 201
     * решение «вероятно о субъекте»: боксёр, тенор, дизайнер, officer из ICIJ,
     * PDF списка Навального, статья SSRN, юрфирма Egorov Puginsky. Все семь
     * чужих записей исполнительного резюме пришли ровно оттуда. Запрос — это
     * намерение оператора, а не свойство материала, и там, где признаки
     * названы, отвечать на принадлежность должны они.
     *
     * Домен в подъёме не участвует: он говорит, **где** опубликовано, а не о
     * ком. С полным именем он подтверждает (`full_name_with_anchor:domain`), с
     * одной фамилией — нет: на портале о судьях пишут не только о субъекте.
     */
    const ownStrongAnchor = anchorHits.find((h) => h.strong && h.kind !== "domain") ?? null;
    if (ownStrongAnchor) {
      decision = "LIKELY_SUBJECT";
      reasonCode = "surname_with_anchor";
      confidence = 0.68;
    } else if (queryContainsSubjectFullName(itemQueryText(item), subject)) {
      decision = "AMBIGUOUS";
      reasonCode = "surname_query_no_anchor";
      confidence = 0.45;
    } else {
      decision = "AMBIGUOUS";
      reasonCode = "surname_only";
      confidence = 0.4;
    }
  } else if (hasSurname && !hasGivenName) {
    // Surname without given name: never SUBJECT_MATCH. Strong context, a
    // soft-surface full-name phrase, or a subject full-name query (§2.2) →
    // LIKELY_SUBJECT; otherwise AMBIGUOUS.
    if (matchedContext.length > 0) {
      decision = "LIKELY_SUBJECT";
      reasonCode = "surname_with_context";
      confidence = 0.65;
    } else if (
      isSuggestionOrPaaSurface(surfaceOf(item)) &&
      hasFullNamePhrase(text, subject)
    ) {
      decision = "LIKELY_SUBJECT";
      reasonCode = /paa|people_also|related/.test(surfaceOf(item))
        ? "paa_full_name"
        : "suggestion_full_name";
      confidence = 0.68;
    } else if (queryContainsSubjectFullName(itemQueryText(item), subject)) {
      decision = "LIKELY_SUBJECT";
      reasonCode = "surname_with_subject_query";
      confidence = 0.62;
      matchedIdentifiers.push("subject_query");
    } else {
      decision = "AMBIGUOUS";
      reasonCode = "surname_only";
      confidence = 0.4;
    }
  } else {
    // Given name without surname (rare) — insufficient.
    decision = "INSUFFICIENT_IDENTIFIERS";
    reasonCode = "partial_name_without_surname";
    confidence = 0.5;
  }

  return {
    evidenceRef,
    decision,
    confidence,
    matchedIdentifiers: [...new Set(matchedIdentifiers)],
    conflictingIdentifiers: [...new Set(conflictingIdentifiers)],
    reasonCode,
  };
}

/**
 * Pass after text classification: surname_only AMBIGUOUS on a domain that
 * already hosts conflict-free SUBJECT_MATCH evidence → LIKELY_SUBJECT.
 * Never promotes to SUBJECT_MATCH; conflicts stay untouched.
 */
export function promoteLikelyBySharedDomain(input: {
  items: RawInventoryItem[];
  resolution: SubjectResolution;
}): SubjectResolution {
  const byRef = new Map(input.resolution.items.map((r) => [r.evidenceRef, r]));
  const matchDomains = new Set<string>();
  for (const item of input.items) {
    const ref = `inventory:${item.inventoryId}`;
    const r = byRef.get(ref);
    if (r?.decision !== "SUBJECT_MATCH" || r.conflictingIdentifiers.length > 0) continue;
    const domain = domainOfUrl(item.sourceUrl);
    if (domain) matchDomains.add(domain);
  }
  if (matchDomains.size === 0) return input.resolution;

  const items = input.resolution.items.map((r) => {
    if (r.decision !== "AMBIGUOUS" || r.reasonCode !== "surname_only") return r;
    if (r.conflictingIdentifiers.length > 0) return r;
    const item = input.items.find((i) => `inventory:${i.inventoryId}` === r.evidenceRef);
    const domain = domainOfUrl(item?.sourceUrl);
    if (!domain || !matchDomains.has(domain)) return r;
    return {
      ...r,
      decision: "LIKELY_SUBJECT" as const,
      reasonCode: "surname_with_confirmed_domain",
      confidence: 0.62,
    };
  });

  return SubjectResolutionSchema.parse({
    ...input.resolution,
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    items,
    evidenceRefs: items.map((i) => i.evidenceRef),
  });
}

/**
 * Статья, найденная по межъязыковой ссылке, наследует решение статьи-источника.
 *
 * Это одна сущность Викиданных, а не две: у латинского заголовка «Alexei
 * Mordashov» токенная классификация узнаёт фамилию, но не имя (наша
 * транслитерация даёт «Aleksey», в статье стоит «Alexei»), и повторная
 * классификация дала бы «одна фамилия» — «не подтверждено» рядом с
 * подтверждённой ru-статьёй, две записи об одном разошлись бы. Направление
 * наследования безопасно по построению: тёзка-источник передаёт сестре свою
 * неподтверждённость, а не наоборот.
 */
export function inheritLanglinkDecisions(input: {
  items: RawInventoryItem[];
  resolution: SubjectResolution;
}): SubjectResolution {
  const byRef = new Map(input.resolution.items.map((r) => [r.evidenceRef, r]));
  const languageOf = (item: RawInventoryItem): string =>
    String(((item.rawMetadata ?? {}) as Record<string, unknown>).language ?? "")
      .toLowerCase()
      .split(/[-_]/u)[0] ?? "";
  const sourceOf = (sourceLanguage: string, self: RawInventoryItem): RawInventoryItem | undefined =>
    input.items.find((i) => {
      if (i === self) return false;
      const meta = (i.rawMetadata ?? {}) as Record<string, unknown>;
      return (
        meta.surface === "wikipedia" &&
        meta.wikipediaExists === true &&
        languageOf(i) === sourceLanguage
      );
    });

  let changed = false;
  const items = input.resolution.items.map((r) => {
    const item = input.items.find((i) => `inventory:${i.inventoryId}` === r.evidenceRef);
    const meta = (item?.rawMetadata ?? {}) as Record<string, unknown>;
    const from = (meta.identityFromLanglink as { sourceLanguage?: string } | undefined)
      ?.sourceLanguage;
    if (!item || !from) return r;
    const source = sourceOf(String(from).toLowerCase(), item);
    const inherited = source ? byRef.get(`inventory:${source.inventoryId}`) : undefined;
    if (!inherited) return r;
    changed = true;
    return {
      ...r,
      decision: inherited.decision,
      confidence: inherited.confidence,
      matchedIdentifiers: inherited.matchedIdentifiers,
      conflictingIdentifiers: inherited.conflictingIdentifiers,
      reasonCode: "langlink_inherited",
    };
  });
  if (!changed) return input.resolution;

  return SubjectResolutionSchema.parse({
    ...input.resolution,
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    items,
    evidenceRefs: items.map((i) => i.evidenceRef),
  });
}

export function buildSubjectResolution(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  items: RawInventoryItem[];
  sourceHashes: string[];
}): SubjectResolution {
  const classified = input.items.map((i) => classifySubjectRelevance(i, input.subject));
  const base = SubjectResolutionSchema.parse({
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: classified.map((i) => i.evidenceRef),
    subjectDisplayName: input.subject.displayName,
    items: classified,
  });
  /*
   * Под якорями домен ничего не подтверждает.
   *
   * `promoteLikelyBySharedDomain` поднимает строку до «вероятно» за то, что на
   * том же домене уже есть подтверждённый материал. В строгом режиме это
   * означало бы: страница судьи на rusprofile.ru поднимает страницы четырёх
   * чужих ИП на том же rusprofile.ru. Признак принадлежности — якорь, а не
   * сосед по домену.
   */
  const anchored = hasSubjectAnchors(input.subject.anchors);
  const promoted = anchored
    ? base
    : promoteLikelyBySharedDomain({ items: input.items, resolution: base });
  // Наследование по межъязыковой ссылке — последним: сестра получает
  // окончательное решение источника, а не промежуточное.
  return inheritLanglinkDecisions({
    items: input.items,
    resolution: anchored
      ? inheritAnchoredDecisionByUrl({ items: input.items, resolution: promoted })
      : promoted,
  });
}

/**
 * Адрес страницы, приведённый к виду, в котором две её строки узнают друг друга.
 *
 * Наблюдения одной страницы различаются запросом и сниппетом: по запросу
 * «ФИО инн» сниппет может не нести якоря, который стоит в сниппете той же
 * страницы по запросу «ФИО». Решение принадлежит странице, а не строке.
 */
export function normalizeUrlForIdentity(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    const params = [...url.searchParams.entries()].filter(
      ([k]) => !/^(utm_|yclid$|gclid$|fbclid$|from$|ref$)/i.test(k)
    );
    const query = params.length
      ? `?${params.map(([k, v]) => `${k}=${v}`).sort().join("&")}`
      : "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}${query}`;
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

/**
 * Пост-проход строгого режима: бесконфликтная строка наследует подтверждение
 * заякоренной строки того же адреса.
 *
 * Конфликтная не наследует никогда: страница, где найден чужой различитель,
 * решается сама.
 */
export function inheritAnchoredDecisionByUrl(input: {
  items: RawInventoryItem[];
  resolution: SubjectResolution;
}): SubjectResolution {
  const urlByRef = new Map<string, string>();
  for (const item of input.items) {
    const url = normalizeUrlForIdentity(item.sourceUrl);
    if (url) urlByRef.set(`inventory:${item.inventoryId}`, url);
  }
  const anchoredUrls = new Set<string>();
  for (const row of input.resolution.items) {
    const url = urlByRef.get(row.evidenceRef);
    if (!url) continue;
    if (row.decision === "SUBJECT_MATCH" && row.conflictingIdentifiers.length === 0) {
      anchoredUrls.add(url);
    }
  }
  if (anchoredUrls.size === 0) return input.resolution;

  const items = input.resolution.items.map((row) => {
    if (row.decision === "SUBJECT_MATCH" || row.conflictingIdentifiers.length > 0) return row;
    const url = urlByRef.get(row.evidenceRef);
    if (!url || !anchoredUrls.has(url)) return row;
    return {
      ...row,
      decision: "SUBJECT_MATCH" as const,
      reasonCode: "url_inherited",
      confidence: Math.max(row.confidence, 0.9),
    };
  });
  return { ...input.resolution, items };
}

/** Profile shape consumed by the classifier (subset of SubjectIdentityProfile). */
export type ClassifierSubjectProfile = {
  displayName: string;
  /**
   * Positional Russian name. LOWER-CONFIDENCE backward-compat fallback ONLY:
   * used when the structured fields below are absent. It must not be assumed to
   * exist and does not imply a patronymic or Russian name order.
   */
  fullNameRu?: { lastName?: string; firstName?: string; patronymic?: string };
  /** Structured dynamic identity (preferred; subject-supplied). */
  givenNames?: string[];
  familyNames?: string[];
  patronymics?: string[];
  aliases?: string[];
  transliterations?: string[];
  contextIdentifiers?: string[];
  namesakeProfiles?: NamesakeProfile[];
  /** Признаки субъекта сверх имени, названные оператором (см. `subject-anchors`). */
  anchors?: SubjectAnchors;
  knownIdentifiers?: { inn?: string[] };
  negativeIdentitySignals?: {
    wrongPatronymics?: string[];
    wrongNames?: string[];
    unrelatedKnownPersons?: string[];
  };
};

/**
 * Adapter from a subject profile to the matcher's SubjectIdentity.
 *
 * Every subject-specific value comes from the profile — there are NO hardcoded
 * names, patronymics, business terms or namesake noise here. Structured fields
 * (givenNames/familyNames/patronymics/…) are preferred; positional `fullNameRu`
 * is only a lower-confidence fallback and never assumes Russian ordering or the
 * existence of a patronymic.
 */
/**
 * Прогон по якорям, не подтвердивший ни одного материала, дальше не идёт.
 *
 * Отчёт из нуля подтверждённых материалов — это лист «ничего не найдено» ценой
 * четырёх стадий модели. Причина почти всегда одна и чинится оператором: якорь
 * написан не теми словами, какими пишет выдача («Арбитражный суд Краснодарского
 * края» против «АС Краснодарского края»). Поэтому отказ здесь — гейт
 * подготовки: он говорит, что делать, и не предлагает повторить то же самое.
 *
 * Пустой корпус отказом не считается: о нём говорят другие ворота, и валить на
 * якоря чужую беду значило бы дать оператору неверный совет.
 */
export function assertAnchoredRunHasSubjectMatches(input: {
  anchors: SubjectAnchors | null | undefined;
  items: ReadonlyArray<{ decision: string }>;
}): void {
  if (!hasSubjectAnchors(input.anchors ?? null)) return;
  if (input.items.length === 0) return;
  const confirmed = input.items.filter(
    (i) => i.decision === "SUBJECT_MATCH" || i.decision === "LIKELY_SUBJECT"
  ).length;
  if (confirmed > 0) return;
  throw new Error(`SUBJECT_ANCHORS_NO_MATCH=${input.items.length}`);
}

export function subjectIdentityFromProfile(profile: ClassifierSubjectProfile): SubjectIdentity {
  const structuredFamily = (profile.familyNames ?? []).filter(Boolean);
  const structuredGiven = (profile.givenNames ?? []).filter(Boolean);
  const structuredPatr = (profile.patronymics ?? []).filter(Boolean);

  /*
   * Латиница фамилии выводится из самой фамилии.
   *
   * Прежняя догадка — «латиница фамилии это слово, общее для всех
   * транслитераций» — ломается на первом же субъекте с псевдонимом: в
   * `transliterations` лежат и транслитерации псевдонимов, общих слов не
   * остаётся вовсе, и фамилия уезжала в кандидаты в имена. Тогда одно слово
   * удовлетворяет сразу и «фамилия названа», и «имя названо», а однофамилец с
   * чужим именем получает SUBJECT_MATCH / full_name_match — так статья о чужом
   * человеке была подтверждена как статья о субъекте на живом прогоне.
   *
   * Инвариант узкий и другим быть не может: **написание фамилии, выводимое из
   * самой фамилии, кандидатом в имена не становится**. Написание, приехавшее в
   * профиль псевдонимом («Ivan Iakovlev» при фамилии «Яковлев»), ни одной
   * таблицей не выводится, и опознать его можно только новой догадкой — а
   * догадку здесь удаляют, а не заводят. Путь для такого написания есть и без
   * догадки: оператор добавляет его в `familyNames` панелью профиля.
   *
   * Фамилия профилю неизвестна — молчим, а не гадаем.
   */
  const familySources = [...structuredFamily, profile.fullNameRu?.lastName ?? ""].filter(Boolean);
  /*
   * Падежные формы фамилии — тоже формы фамилии, и на латинской стороне их
   * нужно называть явно. Кириллическую сторону это не задевало никогда:
   * `matchesToken` порождает формы сам. А псевдоним оператора несёт фамилию в
   * косвенном падеже («Фонд Борисова»), транслитерация псевдонима приносит
   * «borisova», и без этой строки слово становилось «именем» — однофамилица
   * Анна Борисова получала полное совпадение.
   *
   * Таблица падежей здесь та же, которой сверяется текст, а не новая догадка.
   * Зазор, который она оставляет: падежную форму она строит от написания, где
   * «ё» уже приведена к «е», поэтому «Kremlyova» (вторая школа, косвенный
   * падеж) формой фамилии не станет — именительный «Kremlyov» станет.
   */
  const surnameLatinForms = latinFormsOfNameParts([
    ...familySources,
    ...familySources.flatMap(generateRussianNameForms),
  ]);
  const familyTokenSet = new Set(
    [...familySources, ...surnameLatinForms]
      .flatMap((f) => norm(f).split(/\s+/))
      .filter((w) => w.length > 2)
      .map(foldWord)
  );
  const matchesFamily = (tok: string): boolean => familyTokenSet.has(foldWord(tok));
  // Остальные токены транслитераций — кандидаты в имена.
  const translits = (profile.transliterations ?? []).map((t) => t.toLowerCase());
  const translitFirsts = translits.flatMap((t) =>
    t.split(/\s+/).filter((w) => w.length > 2 && !matchesFamily(w))
  );

  // Backward-compat positional fallback (lower confidence): only used to seed
  // fields the structured profile did not provide.
  const positionalLast = profile.fullNameRu?.lastName ?? "";
  const positionalFirst = profile.fullNameRu?.firstName ?? "";
  const positionalPatr = profile.fullNameRu?.patronymic ?? "";

  const lastName =
    structuredFamily[0] ?? positionalLast ?? profile.displayName.split(/\s+/)[0] ?? "";
  const lastNameVariants = uniqByNorm([...structuredFamily.slice(1), ...surnameLatinForms]);
  const firstNames = [
    ...new Set([...structuredGiven, positionalFirst, ...translitFirsts].filter(Boolean)),
  ];
  const patronymics = [...new Set([...structuredPatr, positionalPatr].filter(Boolean))];

  // Guard against misconfigured profiles that list the subject's own name /
  // transliteration / alias among negative signals: dropping them here keeps
  // genuine subject mentions from being classified as namesake conflicts.
  const ownNameText = ownNameTextOfVariants([
    profile.displayName,
    lastName,
    ...lastNameVariants,
    ...firstNames,
    ...patronymics,
    ...(profile.aliases ?? []),
    ...(profile.transliterations ?? []),
    profile.fullNameRu
      ? [profile.fullNameRu.lastName, profile.fullNameRu.firstName, profile.fullNameRu.patronymic]
          .filter(Boolean)
          .join(" ")
      : "",
  ]);
  const notSelfConflicting = (w: string): boolean =>
    !isSelfConflictingNegativeSignal(ownNameText, w);

  const namesakeProfiles = (profile.namesakeProfiles ?? []).map((n) => ({
    label: n.label,
    noiseTerms: n.noiseTerms.map((t) => t.toLowerCase()).filter(notSelfConflicting),
  }));
  const namesakeNoise = [...new Set(namesakeProfiles.flatMap((n) => n.noiseTerms))];

  return {
    displayName: profile.displayName,
    lastName,
    lastNameVariants,
    firstNames,
    patronymics,
    aliases: [...new Set([...(profile.aliases ?? []), ...(profile.transliterations ?? [])])],
    strongIdentifiers: profile.knownIdentifiers?.inn ?? [],
    /*
     * У вопроса «чем материал подтверждается сверх имени» один владелец.
     *
     * Когда якоря есть, контекст-слова не читаются: иначе у профиля два
     * набора признаков с разной силой, и на прогоне 0049 победил бы тот, что
     * намайнен из смешанного корпуса.
     */
    contextIdentifiers: hasSubjectAnchors(profile.anchors)
      ? []
      : [...new Set(profile.contextIdentifiers ?? [])],
    ...(profile.anchors ? { anchors: profile.anchors } : {}),
    wrongFirstNames: (profile.negativeIdentitySignals?.wrongNames ?? []).filter(notSelfConflicting),
    wrongPatronymics: (profile.negativeIdentitySignals?.wrongPatronymics ?? []).filter(
      notSelfConflicting
    ),
    unrelatedKnownPersons: (profile.negativeIdentitySignals?.unrelatedKnownPersons ?? []).filter(
      notSelfConflicting
    ),
    namesakeProfiles,
    namesakeNoise,
  };
}

export function subjectResolutionDigest(resolution: SubjectResolution): string {
  return createHash("sha256")
    .update(JSON.stringify(resolution.items.map((i) => `${i.evidenceRef}:${i.decision}`)))
    .digest("hex")
    .slice(0, 16);
}
