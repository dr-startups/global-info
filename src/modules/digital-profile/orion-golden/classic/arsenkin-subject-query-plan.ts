/**
 * Universal subject → Arsenkin RU/UAE query plan (pure, no network).
 * Shared by classic render enrich, preflight, and canonical live runner.
 */

import { transliterateRuToEn } from "../../search-surfaces/orion-query-plan";
import { parseSubjectName } from "../../risk-classifier/entity-disambiguation";

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
 * The parts come from parseSubjectName, never from string indexes: the input
 * order is not known in advance, and "Умар Назарович Кремлев" is written
 * given-first. While this function cut the string by index, the paid provider
 * was sent "Назарович Умар" — the subject's name without his surname.
 *
 * The list used to carry the fully reversed order as well, and that string was
 * sent to the paid provider too: a live run bought 10 organic rows for "юрьевич
 * олег тиньков" and printed that query to the client as the SERP caption.
 * Human orders are these three: the full name as written, "First Patronymic
 * Surname" and the most common "First Surname".
 */
function permutationsOfName(fullName: string): string[] {
  const { surname, givenName, patronymic } = parseSubjectName(fullName);
  if (!surname || !givenName) return [fullName];
  const firstLast = `${givenName} ${surname}`;
  if (!patronymic) {
    /*
     * Двухсловное имя человек набирает в обоих порядках, и оба встречались в
     * живом корпусе — «oleg tinkov» и «tinkov oleg». Пока порядок определялся
     * позицией, второй порядок получался сам собой; теперь его надо назвать.
     */
    return [fullName, firstLast, `${surname} ${givenName}`];
  }
  /*
   * Длинная форма переносит фамилию в конец, **не теряя остального**: у имени
   * «Иванов Иван Иванович Оглы» уходит «Иван Иванович Оглы Иванов», а не
   * «Иван Иванович Иванов» — имя другого человека (пункт BF). Хвост берётся из
   * самой строки: в разобранных полях лежит по одному токену.
   *
   * Короткая форма «Имя Фамилия» рядом остаётся: это законное сокращение, а
   * не огрызок — так человек и печатает.
   */
  const rest = fullName.split(/\s+/).filter(Boolean);
  const surnameAt = rest.indexOf(surname);
  if (surnameAt >= 0) rest.splice(surnameAt, 1);
  return [fullName, `${rest.join(" ")} ${surname}`, firstLast];
}

/**
 * Latin spellings follow the decision already recorded for enBaseVariants:
 * full spelling plus "First Surname". The patronymic is not typed outside the
 * Russian-speaking world, and the reversed order is not a spelling of a name
 * at all — "Filippovich Viktor Rashnikov" went to the UAE contour for money.
 *
 * Only ever called on our own Cyrillic FIO: that is the single name whose part
 * order we can resolve. Rearranging any other one invents a query — "Mohammed
 * bin Rashid Al Maktoum" would give "bin Mohammed", and an analyst-supplied
 * alias is already in the order a human types.
 */
function transliteratedFioVariants(ownFio: string, latin: string): string[] {
  const { surname, givenName, patronymic } = parseSubjectName(ownFio);
  if (!surname || !givenName) return [latin];
  const first = transliterateRuToEn(givenName);
  const last = transliterateRuToEn(surname);
  // У двухсловного имени оба порядка человеческие — как и в кириллице.
  return patronymic ? [latin, `${first} ${last}`] : [latin, `${first} ${last}`, `${last} ${first}`];
}

/**
 * Обрезка набора по пределу, не выбрасывающая обязательную строку.
 *
 * Пределы платного сбора считаются в запросах, поэтому набор режется. Но
 * собственное написание субъекта резать нельзя: без него в регионе не ищется
 * настоящее имя человека, о котором пишут отчёт. Если оно не влезло, место ему
 * освобождает последний из подтверждённых алиасов — их несколько, а имя одно.
 */
function capKeeping(list: string[], required: string, max: number): string[] {
  if (list.length <= max) return list;
  const head = list.slice(0, max);
  if (!required || head.includes(required)) return head;
  return [...list.slice(0, max - 1), required];
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
  /*
   * Латинское имя ищется латиницей и в русском контуре.
   *
   * У субъекта с латинским именем и без кириллических алиасов набор оставался
   * пуст, и заявка уходила с единственной строкой `"subject"` — платный
   * `check-top` по английскому слову: блокер `empty-queries-ru` не спасает,
   * план блокируется только при **обоих** пустых наборах (пункт BH).
   *
   * Решение владельца 19.08: искать латинское имя. Русскоязычные источники
   * часто пишут имя латиницей, риск нулевой — ищем то, что точно существует.
   * Транслитерация в кириллицу отвергнута: она неоднозначна, и можно заплатить
   * за написание, которым его никто не называет.
   *
   * Порядок частей при этом не трогается — правило модуля: переставлять можно
   * только собственное ФИО, чей порядок мы знаем.
   */
  const ruBase = hasCyrillic(name)
    ? [name, ...(ownFio ? permutationsOfName(ownFio) : []), ...cyrAliases]
    : [name, ...cyrAliases];
  const queriesRu = dedupePreserve(ruBase).slice(0, 5);

  // UAE plan: confirmed Latin aliases go as the analyst wrote them; with no
  // alias the plan is built from our own FIO, and only that string may be
  // rearranged. Anything else — a Latin fullName, a name taken from an alias —
  // goes as it is, transliterated when Cyrillic: changing the alphabet keeps
  // the order, guessing the order does not.
  const latinFromOwnFio = ownFio ? transliterateRuToEn(ownFio) : "";
  /*
   * Собственное написание субъекта латиницей ищется **рядом** с алиасом.
   *
   * Пока набор ОАЭ был ровно алиасами, настоящее имя субъекта в регионе не
   * искалось вовсе: у `Mohammed bin Rashid Al Maktoum` с алиасом
   * `Sheikh Mohammed` контур искал только алиас. В живом корпусе Тинькова то
   * же самое — `oleg tinkov`, `tinkov oleg`, `oleg tinkoff` и ни одной строки
   * `Tinkov Oleg Yurevich` (пункт BI).
   *
   * Решение владельца 19.08: добавлять собственное написание. Плюс один запрос
   * на прогон; взамен исчезает дыра, о которой отчёт нигде не говорил.
   *
   * Первым остаётся алиас: его подтвердил аналитик, и он же печатается
   * клиенту как `primaryIdentityUae`.
   */
  const ownLatin = latinFromOwnFio || (hasCyrillic(name) ? transliterateRuToEn(name) : name);
  const uaeBase =
    latinAliases.length > 0
      ? [...latinAliases, ...(ownLatin ? [ownLatin] : [])]
      : latinFromOwnFio
        ? transliteratedFioVariants(ownFio, latinFromOwnFio)
        : [ownLatin];
  const queriesUae = capKeeping(dedupePreserve(uaeBase), ownLatin, 4);

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
