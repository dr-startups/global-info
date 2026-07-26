/**
 * Step 05.2(b) — factual statements with verbatim, code-verified quotes.
 *
 * Claims used to be assembled by a template that concatenated headlines
 * ("Найдены публикации, в том числе «Title» — источник X"), so no fact from
 * inside a material ever reached the report and the model downstream could only
 * paraphrase a list of titles.
 *
 * Here the model does what models are good at — reading a material and stating
 * what it says — while every statement must be anchored to a quote that this
 * module then finds **verbatim** in the material's own text. A statement whose
 * quote cannot be located is dropped, not softened. The project charter holds:
 * the LLM formulates, deterministic code verifies.
 *
 * Attribution (domain, URL, date, evidence ref) is never taken from the model:
 * it is resolved from our own record for the referenced material, so a
 * hallucinated source is structurally impossible.
 */

import { z } from "zod";

export const FACT_EXTRACTION_VERSION = "fact-extraction-v1" as const;
export const FACT_EXTRACTION_PROMPT_VERSION = "fact-extraction-prompt-v1" as const;

/**
 * A quote must be long enough to carry a fact rather than echo the subject's
 * name, and short enough that the model is quoting rather than dumping the
 * whole snippet as "evidence".
 */
export const FACT_QUOTE_MIN_CHARS = 24;
export const FACT_QUOTE_MAX_CHARS = 320;
export const FACT_QUOTE_MIN_WORDS = 4;

export const FactStatusSchema = z.enum([
  /** Registry/official record or an uncontested biographical datum. */
  "established_fact",
  /** The source alleges it; publication is not proof. */
  "source_allegation",
  /** The material merely mentions the subject in this context. */
  "mention",
  /** Background that frames other findings. */
  "context",
]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const ExtractedFactSchema = z.object({
  /** One sentence, in the report language, of what the material says. */
  statement: z.string().min(1),
  /** Verbatim fragment of the material that carries the statement. */
  quote: z.string().min(1),
  /** Positional handle of the material in the payload (`e1`..`eN`). */
  ref: z.string().min(1),
  status: FactStatusSchema,
  /**
   * Theme this statement itself belongs to (step 06.2).
   *
   * Themes used to be inherited from the claim, which aggregates many
   * materials, so a fact about founding a company was published under
   * «Регуляторные расследования». The fact carries its own theme now; an
   * unrecognised or absent value falls back to the theme the call was made for.
   */
  theme: z.string().optional(),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export const ExtractedFactsResponseSchema = z.object({
  facts: z.array(ExtractedFactSchema),
});

/** Material as this module needs to see it — attribution comes from here. */
export type FactSourceMaterial = {
  ref: string;
  evidenceRef: string;
  title: string;
  snippet?: string;
  domain?: string;
  url?: string;
  publishedAt?: string;
};

export type FactRejectionReason =
  | "empty-statement"
  | "unknown-ref"
  | "quote-too-short"
  | "quote-too-long"
  | "quote-not-in-material"
  | "duplicate-quote";

export type VerifiedFact = {
  statement: string;
  quote: string;
  status: FactStatus;
  /** Canonical theme of this statement; absent when the model gave none valid. */
  themeId?: string;
  /** Resolved by code from the referenced material, never from the model. */
  evidenceRef: string;
  sourceDomain?: string;
  sourceUrl?: string;
  publishedAt?: string;
};

export type FactVerification =
  | { accepted: true; fact: VerifiedFact }
  | { accepted: false; reason: FactRejectionReason; statement: string; ref: string };

/**
 * Folds away the differences that survive copy-editing but not string equality:
 * typographic quotes and dashes, non-breaking spaces, ellipsis, case and
 * whitespace runs. Deliberately does NOT strip letters or punctuation that
 * carry meaning — a quote still has to be the source's words.
 */
export function normalizeForQuoteMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[«»“”„‟"']/gu, '"')
    // Includes U+2010 hyphen and U+2011 non-breaking hyphen: both survive
    // copy-paste from a rendered page and would otherwise fail exact matching.
    .replace(/[—–‒−‐‑]/gu, "-")
    .replace(/…/gu, "...")
    .replace(/ /gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Full searchable text of a material: what the model was shown. */
function materialText(material: FactSourceMaterial): string {
  return [material.title, material.snippet].filter(Boolean).join(" ");
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

/**
 * Verifies one extracted fact against the material it claims to quote.
 *
 * `seenQuotes` is mutated on acceptance so the same fragment cannot be sold as
 * two separate findings — the duplicate-headline padding of the old builder is
 * exactly what this prevents.
 */
export function verifyExtractedFact(input: {
  fact: ExtractedFact;
  materialsByRef: Map<string, FactSourceMaterial>;
  seenQuotes: Set<string>;
  /** Canonical theme ids the model may choose from. */
  allowedThemes?: ReadonlySet<string>;
}): FactVerification {
  const statement = String(input.fact.statement ?? "").trim();
  const ref = String(input.fact.ref ?? "").trim();
  const quote = String(input.fact.quote ?? "").trim();

  if (!statement) return { accepted: false, reason: "empty-statement", statement, ref };

  const material = input.materialsByRef.get(ref);
  if (!material) return { accepted: false, reason: "unknown-ref", statement, ref };

  if (quote.length < FACT_QUOTE_MIN_CHARS || wordCount(quote) < FACT_QUOTE_MIN_WORDS) {
    return { accepted: false, reason: "quote-too-short", statement, ref };
  }
  if (quote.length > FACT_QUOTE_MAX_CHARS) {
    return { accepted: false, reason: "quote-too-long", statement, ref };
  }

  const haystack = normalizeForQuoteMatch(materialText(material));
  const needle = normalizeForQuoteMatch(quote);
  if (!needle || !haystack.includes(needle)) {
    return { accepted: false, reason: "quote-not-in-material", statement, ref };
  }

  const dedupeKey = `${material.evidenceRef}::${needle}`;
  if (input.seenQuotes.has(dedupeKey)) {
    return { accepted: false, reason: "duplicate-quote", statement, ref };
  }
  input.seenQuotes.add(dedupeKey);

  const theme = String(input.fact.theme ?? "").trim();
  const themeId = input.allowedThemes?.has(theme) ? theme : undefined;

  return {
    accepted: true,
    fact: {
      statement,
      quote,
      status: input.fact.status,
      ...(themeId ? { themeId } : {}),
      evidenceRef: material.evidenceRef,
      ...(material.domain ? { sourceDomain: material.domain } : {}),
      ...(material.url ? { sourceUrl: material.url } : {}),
      ...(material.publishedAt ? { publishedAt: material.publishedAt } : {}),
    },
  };
}

export type FactExtractionOutcome = {
  accepted: VerifiedFact[];
  rejected: Array<{ statement: string; ref: string; reason: FactRejectionReason }>;
  /** Counts per reason — surfaced in diagnostics so silent loss is visible. */
  rejectedByReason: Record<string, number>;
};

/** Verifies a batch, preserving model order for the accepted facts. */
export function verifyExtractedFacts(input: {
  facts: ExtractedFact[];
  materials: FactSourceMaterial[];
  allowedThemes?: ReadonlySet<string>;
}): FactExtractionOutcome {
  const materialsByRef = new Map(input.materials.map((m) => [m.ref, m]));
  const seenQuotes = new Set<string>();
  const accepted: VerifiedFact[] = [];
  const rejected: FactExtractionOutcome["rejected"] = [];
  const rejectedByReason: Record<string, number> = {};

  for (const fact of input.facts) {
    const result = verifyExtractedFact({
      fact,
      materialsByRef,
      seenQuotes,
      ...(input.allowedThemes ? { allowedThemes: input.allowedThemes } : {}),
    });
    if (result.accepted) {
      accepted.push(result.fact);
      continue;
    }
    rejected.push({ statement: result.statement, ref: result.ref, reason: result.reason });
    rejectedByReason[result.reason] = (rejectedByReason[result.reason] ?? 0) + 1;
  }

  return { accepted, rejected, rejectedByReason };
}

export const FACT_EXTRACTION_SYSTEM_PROMPT = [
  "Ты аналитик due diligence. Тебе даны материалы поисковой выдачи о проверяемом лице.",
  "Задача: извлечь конкретные утверждения о лице, каждое — с дословной цитатой из материала.",
  "",
  "Правила:",
  "1. statement — одно предложение по-русски о том, что сообщает материал. Конкретика:",
  "   кто, что, где, когда, какая организация, какая сумма. Общие рассуждения о том,",
  "   что обычно делают банки или комплаенс, запрещены.",
  "2. quote — фрагмент, скопированный из title или snippet материала ДОСЛОВНО, без",
  "   перефразирования, склейки кусков и многоточий вместо пропущенного текста.",
  "   Цитата, которой нет в материале буквально, будет отброшена проверкой.",
  "3. ref — идентификатор материала (e1, e2, ...), из которого взята цитата.",
  "4. status: established_fact — реестровая/официальная запись либо неоспариваемый",
  "   биографический факт; source_allegation — источник утверждает, но это не",
  "   доказано; mention — лицо просто упомянуто; context — фон.",
  "5. Не выдумывай фактов, которых нет в материалах. Лучше меньше утверждений.",
  "6. Одно утверждение — одна цитата. Не повторяй одну цитату в разных утверждениях.",
  "7. Домен, ссылку и дату НЕ указывай: они берутся из наших записей.",
  "8. theme — тема, к которой относится САМО утверждение, из списка allowedThemes.",
  "   Не подстраивайся под тему запроса: факт о создании компании относится к",
  "   деловым связям, даже если запрошена тема о регуляторных расследованиях.",
  "   Если ни одна тема не подходит — поле theme не указывай вовсе.",
  "9. Материал, не относящийся к проверяемому лицу по существу (реклама, чужой",
  "   контент, случайное упоминание имени), пропускай: лучше ноль утверждений,",
  "   чем утверждение ни о чём.",
  "",
  "Верни ТОЛЬКО JSON: {\"facts\": [{\"statement\": \"...\", \"quote\": \"...\", \"ref\": \"e1\", \"status\": \"...\", \"theme\": \"...\"}]}",
].join("\n");
