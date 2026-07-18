/**
 * Automatic subject-context derivation (no manual input required).
 *
 * Pass 1 classifies every observation with the supplied profile. Context terms
 * are then mined ONLY from conflict-free SUBJECT_MATCH items (full-name /
 * strong-identifier evidence), so a namesake's vocabulary can never leak in.
 * Pass 2 re-classifies with the enriched contextIdentifiers, upgrading matched
 * items to full_name_with_context confidence. Deterministic and offline;
 * subject-supplied context always stays and mined terms are only additive.
 */

import type { RawInventoryItem } from "../types";
import type { SubjectResolution } from "../contracts/subject-resolution";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "./subject-resolution-classifier";

const MAX_MINED_TERMS = 12;
const MIN_DISTINCT_DOCS = 2;
const MIN_TOKEN_LENGTH = 4;
const MAX_TOKEN_LENGTH = 24;

/** Generic RU/EN web + SERP vocabulary that carries no subject context. */
const STOPWORDS = new Set(
  (
    "этот это эта также если чтобы когда быть есть был была были будет более менее очень " +
    "который которая которые котором после перед около через между против почему зачем " +
    "года году годах лет день дней сегодня вчера завтра сейчас всего один одна первый второй " +
    "новости новость статья статьи материал материалы читать читайте подробнее источник сайт " +
    "фото видео смотреть смотрите онлайн скачать сообщает сообщили пишет заявил заявила рассказал " +
    "россия россии российский российская российское русский москва рублей рубля миллиона миллиард " +
    "человек люди жизнь время место история вопрос вопросы ответ данные информация результат " +
    "результаты поиск запрос страница сообщение комментарии мнение биография википедия wikipedia " +
    "news article read more about with from that this have been will what when where their your " +
    "также однако поэтому потому например является являются может могут стал стала стали " +
    "compromat dzen yandex google search результатов найдено показать ещё еще"
  ).split(/\s+/)
);

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е");
}

/** All subject-name tokens (with stems) that must never be mined as context. */
function subjectNameTokens(subject: SubjectIdentity): Set<string> {
  const raw = [
    subject.displayName,
    subject.lastName,
    ...subject.lastNameVariants,
    ...subject.firstNames,
    ...subject.patronymics,
    ...subject.aliases,
  ]
    .flatMap((v) => norm(v ?? "").split(/[^a-zа-я-]+/u))
    .filter((t) => t.length >= 3);
  const out = new Set<string>();
  for (const t of raw) {
    out.add(t);
    if (t.length >= 5) out.add(t.slice(0, -1));
  }
  return out;
}

function isNameToken(token: string, nameTokens: Set<string>): boolean {
  if (nameTokens.has(token)) return true;
  for (const n of nameTokens) {
    if (n.length >= 4 && (token.startsWith(n) || n.startsWith(token))) return true;
  }
  return false;
}

function tokensOf(item: RawInventoryItem): Set<string> {
  const text = norm([item.title, item.snippet].filter(Boolean).join(" "));
  const out = new Set<string>();
  for (const raw of text.split(/[^a-zа-я-]+/u)) {
    const t = raw.replace(/^-+|-+$/g, "");
    if (t.length < MIN_TOKEN_LENGTH || t.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export type MinedSubjectContext = {
  /** Additive mined terms, ordered by document frequency then alphabetically. */
  minedTerms: string[];
  /** Distinct conflict-free SUBJECT_MATCH items the terms were mined from. */
  matchedItemCount: number;
};

/**
 * Mine context terms from conflict-free SUBJECT_MATCH items of a resolution.
 * A term qualifies when it appears in >= MIN_DISTINCT_DOCS distinct matched
 * items, is not generic vocabulary and is not a subject-name token.
 */
export function mineSubjectContextTerms(input: {
  items: RawInventoryItem[];
  resolution: SubjectResolution;
  subject: SubjectIdentity;
  maxTerms?: number;
  minDistinctDocs?: number;
}): MinedSubjectContext {
  const maxTerms = input.maxTerms ?? MAX_MINED_TERMS;
  const minDocs = input.minDistinctDocs ?? MIN_DISTINCT_DOCS;

  const matchedRefs = new Set(
    input.resolution.items
      .filter((r) => r.decision === "SUBJECT_MATCH" && r.conflictingIdentifiers.length === 0)
      .map((r) => r.evidenceRef)
  );
  const matchedItems = input.items.filter((i) => matchedRefs.has(`inventory:${i.inventoryId}`));

  const nameTokens = subjectNameTokens(input.subject);
  const supplied = new Set(input.subject.contextIdentifiers.map(norm));
  const df = new Map<string, number>();
  for (const item of matchedItems) {
    for (const token of tokensOf(item)) {
      if (supplied.has(token)) continue;
      if (isNameToken(token, nameTokens)) continue;
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const minedTerms = [...df.entries()]
    .filter(([, count]) => count >= minDocs)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, maxTerms)
    .map(([term]) => term);

  return { minedTerms, matchedItemCount: matchedItems.length };
}

export type DerivedContextResolution = {
  resolution: SubjectResolution;
  /** Context the subject/operator supplied (profile). */
  suppliedContext: string[];
  /** Context mined automatically from confirmed matches. */
  minedContext: string[];
  /** Full context used for the final classification pass. */
  effectiveContext: string[];
  matchedItemCount: number;
};

/**
 * Two-pass subject resolution with automatically derived context.
 * Falls back to the single-pass result when nothing useful is mined.
 */
export function resolveSubjectWithDerivedContext(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  items: RawInventoryItem[];
  sourceHashes: string[];
}): DerivedContextResolution {
  const pass1 = buildSubjectResolution({
    caseId: input.caseId,
    datasetId: input.datasetId,
    subject: input.subject,
    items: input.items,
    sourceHashes: input.sourceHashes,
  });

  const { minedTerms, matchedItemCount } = mineSubjectContextTerms({
    items: input.items,
    resolution: pass1,
    subject: input.subject,
  });

  const suppliedContext = [...input.subject.contextIdentifiers];
  if (minedTerms.length === 0) {
    return {
      resolution: pass1,
      suppliedContext,
      minedContext: [],
      effectiveContext: suppliedContext,
      matchedItemCount,
    };
  }

  const effectiveContext = [...new Set([...suppliedContext, ...minedTerms])];
  const pass2 = buildSubjectResolution({
    caseId: input.caseId,
    datasetId: input.datasetId,
    subject: { ...input.subject, contextIdentifiers: effectiveContext },
    items: input.items,
    sourceHashes: input.sourceHashes,
  });

  return {
    resolution: pass2,
    suppliedContext,
    minedContext: minedTerms,
    effectiveContext,
    matchedItemCount,
  };
}
