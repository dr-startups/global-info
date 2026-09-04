/**
 * Признаки субъекта из карточки, которую оператор подтвердил глазами.
 *
 * Шаг 0054 сделал разметку строгой для всех: материал подтверждается признаком
 * сверх ФИО. Малоизвестному субъекту признаки называет клиент, а известному их
 * называть незачем — о нём уже есть подтверждённый источник: карточка
 * Википедии или панели знаний, на которой оператор нажал «Это он».
 *
 * Это **не** та круговая порука, которую шаг 0054 запретил: признак берётся не
 * из размечаемого корпуса, а из отдельного источника, выбранного человеком.
 * Риск назван прямо: оператор выбрал карточку тёзки — его слова станут
 * якорями; поэтому фразы видны в форме признаков и снимаются одним щелчком.
 *
 * Берутся **имена собственные, а не пересказ прозы**. Оборот «основатель
 * компании» многословен, то есть по общему правилу силён, а стоит в тексте о
 * любом основателе с той же фамилией. Кавычки в лиде почти всегда стоят вокруг
 * названия организации, и оно действительно различает людей; заглавная буква —
 * признак ненадёжный (под неё попадают «Россия» и «Москва», а регион якорем не
 * является), поэтому такие фразы слабые.
 */

import {
  anchorPhraseStems,
  type SubjectAnchorPhrase,
} from "../orion-golden/analytics/subject-anchors";
import type { SubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile";
import type { PersonaCard } from "./subject-persona-check";
import {
  getSubjectProfileForEdit,
  saveSubjectProfileEdits,
  type SubjectProfileStore,
} from "./subject-profile-admin";

/** Больше четырёх признаков карточка не даёт: дальше идёт шум лида. */
const MAX_CARD_PHRASES = 4;
const MAX_PHRASE_LENGTH = 60;

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е").trim();
}

/** Описательная часть карточки; у санкционной записи её нет вовсе. */
function describableText(card: PersonaCard): string {
  if (card.source === "wikipedia") return card.lead?.trim() || card.snippet || "";
  if (card.source === "knowledge_graph") return card.description ?? "";
  /*
   * Санкционная запись не описывает человека: `topicLabels` — категории
   * («PEP», «санкции»), они стоят у тысяч людей и признаком не являются, а
   * структурная дата рождения уже проверяется своим правилом.
   */
  return "";
}

/** Токены имени субъекта: фраза с ними подтверждала бы страницу тёзки сама собой. */
function nameTokens(variants: readonly string[]): string[] {
  const out = new Set<string>();
  for (const variant of variants) {
    for (const token of norm(variant).split(/[^\p{L}\p{N}]+/u)) {
      if (token.length >= 3) out.add(token);
    }
  }
  return [...out];
}

function mentionsSubjectName(phrase: string, tokens: readonly string[]): boolean {
  const words = norm(phrase).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => tokens.some((t) => w === t || w.startsWith(t) || t.startsWith(w)));
}

/**
 * Имена с заглавной буквы, кроме первого слова предложения.
 *
 * Первое слово предложения написано с заглавной по правилам письма, а не
 * потому, что оно имя: «Российский предприниматель…» дало бы признак
 * «Российский», который стоит в каждом втором тексте.
 */
function capitalizedSequences(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?]+/u)) {
    const words = sentence.split(/\s+/u).filter(Boolean);
    let current: string[] = [];
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const isName = index > 0 && /^[\p{Lu}]/u.test(word);
      if (isName) {
        current.push(word);
        // Знак препинания внутри предложения обрывает последовательность:
        // «основатель РУСАЛа, выпускник МГУ» — два имени, а не одно.
        if (/[^\p{L}\p{N}]$/u.test(raw)) {
          out.push(current.join(" "));
          current = [];
        }
        return;
      }
      if (current.length > 0) out.push(current.join(" "));
      current = [];
    });
    if (current.length > 0) out.push(current.join(" "));
  }
  return out;
}

/** Фразы-признаки из карточки; пустой список — карточка ничего не дала. */
export function anchorPhrasesFromCard(
  card: PersonaCard,
  subjectNameVariants: readonly string[]
): SubjectAnchorPhrase[] {
  // Скобки вырезаются целиком: «(род. 2 января 1968, Дзержинск)» — дата и место
  // рождения, у них свои правила, и разбирать их из прозы запрещено.
  const text = describableText(card).replace(/\([^)]*\)/gu, " ");
  if (!text.trim()) return [];

  const tokens = nameTokens(subjectNameVariants);
  const seen = new Set<string>();
  const phrases: SubjectAnchorPhrase[] = [];

  const push = (raw: string, strong: boolean): void => {
    const value = raw.replace(/\s+/gu, " ").trim();
    if (!value || value.length > MAX_PHRASE_LENGTH) return;
    if (anchorPhraseStems(value).length === 0) return;
    if (mentionsSubjectName(value, tokens)) return;
    const key = norm(value);
    if (seen.has(key)) return;
    seen.add(key);
    phrases.push({ kind: "fact", text: value, strong });
  };

  // Имена в кавычках — сильные: это название организации или бренда, а не
  // слово вроде «судья», и рядом с полным ФИО оно действительно различает людей.
  const quoted = /[«"„]([^»"“„]{2,60})[»"“]/gu;
  let match: RegExpExecArray | null;
  const withoutQuotes = text.replace(quoted, " ");
  quoted.lastIndex = 0;
  while ((match = quoted.exec(text)) !== null) push(match[1]!, true);

  for (const name of capitalizedSequences(withoutQuotes)) push(name, false);

  return phrases.slice(0, MAX_CARD_PHRASES);
}

/**
 * Слить признаки выбранной карточки в профиль кейса.
 *
 * `null` — карточка не дала ни одной фразы. Фразы оператора не трогаются
 * никогда: карточка дополняет, а не переписывает; повторное решение по той же
 * карточке файл не переписывает.
 */
export function applyCardAnchorsToProfile(input: {
  caseId: string;
  subjectName: string;
  subjectAliases?: string[];
  subjectDateOfBirth?: string | null;
  card: PersonaCard;
  store?: SubjectProfileStore;
}): SubjectIdentityProfile | null {
  const { profile } = getSubjectProfileForEdit(input);
  const variants = [
    input.subjectName,
    profile.displayName,
    ...(input.subjectAliases ?? []),
    ...(profile.aliases ?? []),
    ...(profile.transliterations ?? []),
    ...(profile.fullNameRu
      ? [profile.fullNameRu.lastName, profile.fullNameRu.firstName, profile.fullNameRu.patronymic ?? ""]
      : []),
  ].filter(Boolean);

  const fromCard = anchorPhrasesFromCard(input.card, variants);
  if (fromCard.length === 0) return null;

  const existing = profile.anchors?.phrases ?? [];
  const known = new Set(existing.map((p) => norm(p.text)));
  const fresh = fromCard.filter((p) => !known.has(norm(p.text)));
  if (fresh.length === 0) return profile;

  return saveSubjectProfileEdits({
    ...input,
    edits: {
      anchors: {
        birthDate: profile.anchors?.birthDate ?? null,
        phrases: [...existing, ...fresh],
        inn: profile.anchors?.inn ?? [],
        domains: profile.anchors?.domains ?? [],
      },
    },
  }).profile;
}
