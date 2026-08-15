/**
 * Prompt 2 — cross-surface finding synthesizer.
 * Consumes composite items + subject resolution + surface analyses and
 * produces an actual VerifiedFindingBundle. Includes contradiction
 * detection, limitations, promotion priorities and exclusion reasons.
 * The same evidence never spawns multiple findings (theme assignment is
 * exclusive, priority-ordered).
 */

import { createHash } from "node:crypto";
import {
  clientSafeDomain,
  clientSafeDomains,
} from "../../services/composite-serp-merge";
import { pickDistinctTitles } from "./distinct-stories";
import type { RawInventoryItem } from "../types";
import type { RiskLevel } from "../contracts/common";
import {
  FINDING_SCHEMA_VERSION,
  FindingSchema,
  type Finding,
  type FindingContradiction,
  type PromotionPriority,
} from "../contracts/finding";
import {
  VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
  VerifiedFindingBundleSchema,
  type VerifiedFindingBundle,
} from "../contracts/verified-finding-bundle";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import {
  getAdversePatterns,
  getFindingThemes,
  resolveFindingThemesConfig,
  type ThemeDef,
} from "../../config/finding-themes";
import { domainOf } from "./composite-dataset-builder";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";
import {
  looksLikeMachineDump,
  looksLikeSearchQuery,
  looksLikeSurfaceBlockHeading,
} from "./client-quote-hygiene";
import { themeHitIsNegated } from "./negated-theme-hit";

export type { ThemeDef };

/**
 * Live view of configured themes (REMEDIATION §3.1). Prefer getFindingThemes().
 * Proxy keeps `.find` / `.filter` / indexing working for existing call sites.
 */
export const FINDING_THEMES: ThemeDef[] = new Proxy([] as ThemeDef[], {
  get(_target, prop, receiver) {
    const themes = getFindingThemes();
    if (prop === "length") return themes.length;
    if (typeof prop === "string" && /^\d+$/.test(prop)) return themes[Number(prop)];
    const value = Reflect.get(themes, prop, receiver);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(themes) : value;
  },
});

/** REMEDIATION §3.2 — SUBJECT_MATCH/LIKELY with no theme keyword hit. */
export type UncategorizedMaterial = {
  evidenceRef: string;
  title: string;
  domain: string;
  region: string;
  subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT";
};

export type UncategorizedMaterialsBlock = {
  version: "uncategorized-materials-v1";
  count: number;
  subjectMatchCount: number;
  likelySubjectCount: number;
  /** Global top-N examples (titles + refs) for operators / LLM theming (3.3). */
  topExamples: UncategorizedMaterial[];
  /** Full ref list (not capped) for §3.3 verification. */
  allEvidenceRefs: string[];
  byRegion: Record<string, { count: number; examples: UncategorizedMaterial[] }>;
};

export type FindingSynthesisResult = {
  bundle: VerifiedFindingBundle;
  ambiguousFindings: Finding[];
  /** evidenceRef -> all themeIds the evidence supports (shared provenance). */
  themeAssignments: Map<string, string[]>;
  /** Not a finding — visible in regional summary only (§3.2). */
  uncategorized: UncategorizedMaterialsBlock;
  stats: {
    subjectMatchEvidence: number;
    likelySubjectEvidence: number;
    ambiguousEvidence: number;
    otherSubjectEvidence: number;
    adverseFindingCount: number;
    uncategorizedCount: number;
  };
};

const UNCATEGORIZED_TOP_N = 12;
const UNCATEGORIZED_PER_REGION_N = 8;

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function itemText(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ");
}

function itemIsAdverse(item: RawInventoryItem): boolean {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  if (meta.analystNeutral === true) return false;
  if (meta.analystAdverse === true) return true;
  return getAdversePatterns().test(itemText(item));
}

/** Russian plural form: 1 публикация, 2 публикации, 5 публикаций. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * PDF-40 G.2b — short framing lead (what was found). The concrete meaning
 * comes from quoted headlines + domains, not from these templates alone.
 */
const CLIENT_THEME_FRAMING: Record<string, string> = {
  criminal_legal:
    "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами",
  pep_rca_watchlist:
    "Найдены материалы, связывающие субъекта с санкционными и мониторинговыми списками (PEP/RCA)",
  political_exposure:
    "Найдены материалы о политической и публичной экспозиции субъекта",
  offshore_corporate:
    "Найдены публикации об офшорных и корпоративных структурах владения",
  family_associates:
    "Найдены материалы о семейных и деловых связях субъекта",
  financial_claims:
    "Найдены публикации о финансовых претензиях и долговых спорах",
  business_profile: "Найдены материалы делового и биографического профиля",
  security_scrutiny:
    "Найдены материалы с акцентом на безопасность и оборонный контур",
};

/**
 * Пояснение «почему это важно» — шаблонная присказка темы.
 *
 * Экспортируется, потому что сборщик деки вычищает повторы только по объявленным
 * присказкам ([[boilerplate-commentary]]): всё, чего нет в таком списке,
 * неприкосновенно. Раньше вычистка сравнивала предложения вслепую и снимала
 * цитаты вместе с источниками.
 */
export const CLIENT_THEME_WHY: Record<string, string> = {
  criminal_legal:
    "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.",
  pep_rca_watchlist:
    "Банки и комплаенс-команды отрабатывают такие сигналы в первую очередь при KYC.",
  political_exposure:
    "Это усиливает вопросы к связям, влиянию и приемлемости контрагента для сделки.",
  offshore_corporate:
    "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.",
  family_associates:
    "Риск в том, что негатив вокруг связанных лиц переносится на профиль проверяемого.",
  financial_claims:
    "Банки и инвесторы обычно запрашивают статус обязательств и судебные справки.",
  business_profile:
    "Деловой фон важен для позиционирования, но сам по себе не перекрывает чувствительные темы риска.",
  security_scrutiny:
    "Для международных проверок это зона повышенного внимания.",
};

export type ClaimEvidenceExample = { title: string; domain: string };

/**
 * PDF-46 I.1 — JS `\b` does NOT treat Cyrillic as word chars, so «…Путина в»
 * / «…из-за» never matched. Use Unicode letter boundaries + multi-word tails.
 */
const DANGLING_TAIL_RE =
  /(?:^|[^\p{L}\p{N}_])(?:and|or|of|the|a|an|to|for|with|from|by|over|into|onto|in|on|at|due|и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|за|к|ко|у|от|до|про|при|после|перед)\s*$/iu;
const SERP_TRUNCATED_RE = /(?:\.\.\.|…)\s*$/u;
const BIO_SEO_RE = /биограф(?:ия|ии)?|личная жизнь|фото|новости|карьера|wiki(?:pedia)?/iu;
const ADVERSE_THEME_IDS = new Set([
  "criminal_legal",
  "pep_rca_watchlist",
  "political_exposure",
  "offshore_corporate",
  "family_associates",
  "financial_claims",
  "security_scrutiny",
]);
const STRONG_DOMAIN_RE =
  /reuters\.|nytimes\.|justice\.gov|treasury\.gov|ofac\.|europa\.eu|bbc\.|theguardian\.|kommersant\.|rbc\.ru|vedomosti\.|cnbc\.|ft\.com|wsj\.|bloomberg\./iu;

/** True for titles that are only a person name (no risk essence). */
function looksLikeBarePersonName(title: string): boolean {
  let t = title.replace(/^[«"]|[»"]$/gu, "").trim();
  // Topic / hub pages: «Given Family - The New York Times»
  t = t.replace(/\s*[-–—]\s*(?:The\s+)?New\s+York\s+Times\s*$/iu, "").trim();
  t = t.replace(/\s*[-–—]\s*[A-Za-z0-9.-]+\.[a-z]{2,}\s*$/iu, "").trim();
  // Инвертированная справочная форма: «Дуров, Павел Валерьевич» — то же голое
  // имя, что и «Павел Валерьевич Дуров», только с запятой (шаг 13, C3).
  t = t.replace(/^([А-ЯЁ][а-яё]+),\s+/u, "$1 ").trim();
  if (/[0-9:/]/u.test(t) || BIO_SEO_RE.test(t)) return false;
  // Latin: Given F. Family / Given Family
  if (/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){1,2}$/u.test(t)) return true;
  // Cyrillic FIO only: Имя Фамилия / Имя Отчество Фамилия
  if (/^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}$/u.test(t)) return true;
  return false;
}

/**
 * Определительная фраза: «<Имя> — <кто это>».
 *
 * Энциклопедический зачин отвечает на вопрос «кто это», а не «что произошло»:
 *
 *     «Павел Валерьевич Дуров — российский предприниматель в сфере
 *      информационных технологий, основатель социальной сети "ВКонтакте"»
 *
 * На живом прогоне эта фраза стояла доказательством темы «Офшоры и финансовая
 * прозрачность» под утверждением «Найдены публикации об офшорных и
 * корпоративных структурах владения». Утверждение ложное и опасное: клиент
 * показывает такой отчёт банку (шаг 15, E6).
 *
 * Признак — именно **зачин**: до тире стоит голое имя. Суффикс источника
 * («… — WSJ», «… - The Moscow Times») под правило не подпадает, потому что до
 * тире там целый заголовок, а не имя.
 */
export function looksLikeEncyclopedicLead(title: string): boolean {
  const t = String(title ?? "").replace(/^[«"]|[»"]$/gu, "").trim();
  const m = /^(.{3,80}?)\s+[—–]\s+(.{10,})$/u.exec(t);
  if (!m) return false;
  const [, head, tail] = m;
  // До тире — голое имя; после — описание, а не событие.
  return looksLikeBarePersonName(head!) && /[а-яёa-z]/u.test(tail!);
}

/** True when a cleaned quote/title ends on a hanging preposition/conjunction. */
export function hasDanglingTail(text: string): boolean {
  return DANGLING_TAIL_RE.test(String(text ?? "").trim());
}

/**
 * PDF-48 — reject client quotes that are clearly mid-cut:
 * «…Фамилии,», unbalanced `"…`, subordinate clause without an end.
 */
export function isIncompleteClientQuote(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length < 12) return true;
  if (/[,;:]$/u.test(t)) return true;
  if (hasDanglingTail(t)) return true;
  if (((t.match(/"/g) ?? []).length) % 2 === 1) return true;
  // Leading subordinate clause that never finishes (provider-truncated snippet).
  if (
    /^(После|Before|After|When|While|During|Согласно|По данным)\b/iu.test(t) &&
    !/[.!?]$/u.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Turn a provider-truncated snippet into a closed headline (no trailing comma/…).
 * e.g. «После публикации расследования ФБК … Фамилии, ...» →
 * «Расследование ФБК об отдыхе … Фамилии».
 */
export function snippetToClientHeadline(snippet: string): string {
  let s = String(snippet ?? "").replace(/\s+/gu, " ").trim();
  s = s.replace(/\s*(?:\.\.\.|…)\s*$/u, "").trim();
  s = s.replace(/[,;:]\s*$/u, "").trim();
  s = s.replace(/^После публикации\s+/iu, "").trim();
  s = s.replace(/^After (?:the )?publication of\s+/iu, "").trim();
  // JS `\b` is ASCII-only — use Unicode letter lookahead for Cyrillic stems.
  s = s.replace(/^расследования(?=$|[^\p{L}])/iu, "Расследование");
  s = s.replace(/^расследование(?=$|[^\p{L}])/iu, "Расследование");
  if (!s) return "";
  s = s.charAt(0).toLocaleUpperCase("ru-RU") + s.slice(1);
  if (s.length < 24 || hasDanglingTail(s) || /[,;:]$/u.test(s)) return "";
  // Headline noun-phrases are allowed; unfinished «После…» clauses are not.
  if (/^(После|Before|After|When|While)\b/iu.test(s) && !/[.!?]$/u.test(s)) return "";
  return s;
}

/**
 * Cap a quote for a bullet line. PDF-45/46/48: prefer the WHOLE title;
 * if over budget or incomplete / dangling / SERP-truncated, return "".
 * Never publish «…visa over» / «…из-за» / «…Фамилии,».
 */
export function quoteForClaim(title: string, budget = 220): string {
  const raw = String(title ?? "").trim();
  const t = cleanExampleTitle(raw);
  if (!t || t.length < 12 || hasDanglingTail(t) || isIncompleteClientQuote(t)) return "";
  // Идентификаторы наборов данных — не слова источника: «…источники:
  // ext_gb_coh_psc, us_trade_csl, eu_fsf» стояло в отчёте цитатой трижды.
  if (looksLikeMachineDump(t)) return "";
  // SERP «…» titles: keep only when clean recovered a complete sentence.
  if (SERP_TRUNCATED_RE.test(raw) && !/[.!?»]$/u.test(t)) return "";
  if (t.length <= budget) return t;
  const slice = t.slice(0, budget);
  const cut = Math.max(
    slice.lastIndexOf(": "),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" — "),
    slice.lastIndexOf(" – ")
  );
  // Do NOT cut on ", " — that produces «…Фамилии,» stubs.
  if (cut < budget * 0.55) return "";
  let body = slice.slice(0, cut).trim().replace(/[\s,;:.—–-]+$/u, "").trim();
  if (hasDanglingTail(body)) {
    body = body.replace(DANGLING_TAIL_RE, "").trim().replace(/[\s,;:.—–-]+$/u, "");
  }
  if (!body || body.length < 24 || hasDanglingTail(body) || isIncompleteClientQuote(body)) {
    return "";
  }
  return `${body}…`;
}

/**
 * PDF-44 H.1 — reject bare FIO / SEO-bio / truncated SERP titles that hide risk essence.
 */
export function isWeakExampleTitle(
  title: string,
  opts?: { theme?: ThemeDef }
): boolean {
  const raw = String(title ?? "");
  const t = cleanExampleTitle(raw);
  if (!t || t.length < 12) return true;
  if (/^potential\s+match$/i.test(t) || /^потенциальное совпадение$/i.test(t)) return true;
  if (hasDanglingTail(t) || isIncompleteClientQuote(t)) return true;
  // Строка автодополнения — не публикация: у неё нет ни автора, ни адреса.
  // Правило стояло в композиторе резюме, но приложение строится другим путём, и
  // на живом прогоне «дуров суд сегодня» попало в приложение как доказательство
  // криминальной темы (шаг 15, E5).
  if (looksLikeSearchQuery(t)) return true;
  // Подпись служебного блока выдачи («Картинки по запросу "…"») повторяет
  // запрос и ничего не утверждает: цитировать её как материал нельзя.
  if (looksLikeSurfaceBlockHeading(t)) return true;
  // PDF-46 I.1 — provider-truncated SERP «…»: weak unless a full sentence remains.
  if (SERP_TRUNCATED_RE.test(raw.trim()) && !/[.!?»]$/u.test(t)) return true;

  const themeHit = opts?.theme ? opts.theme.keywords.test(t) : false;

  // Bare / near-bare person name: «Given F. Family», «Имя Фамилия».
  if (!themeHit && looksLikeBarePersonName(t)) {
    return true;
  }

  // SEO biography blurbs as the only “evidence” for an adverse theme.
  if (
    opts?.theme &&
    ADVERSE_THEME_IDS.has(opts.theme.themeId) &&
    BIO_SEO_RE.test(t) &&
    !themeHit
  ) {
    return true;
  }

  // Энциклопедический зачин («<Имя> — российский предприниматель…») отвечает
  // на вопрос «кто это», а не «что произошло», и доказательством темы риска
  // быть не может (шаг 15, E6).
  if (opts?.theme && ADVERSE_THEME_IDS.has(opts.theme.themeId) && !themeHit) {
    if (looksLikeEncyclopedicLead(t)) return true;
  }

  return false;
}

/** PDF-44 H.1 — rank evidence for client quotes (theme hit in title beats snippet-only). */
export function scoreExampleForTheme(item: RawInventoryItem, theme: ThemeDef): number {
  const title = cleanExampleTitle(String(item.title ?? ""));
  const snippet = String(item.snippet ?? "").trim();
  const domain = domainOf(item.sourceUrl);
  let score = 0;
  if (theme.keywords.test(title)) score += 8;
  else if (snippet && theme.keywords.test(snippet)) score += 3;
  if (itemIsAdverse(item)) score += 2;
  const tokens = title.split(/\s+/u).filter(Boolean).length;
  if (tokens >= 6) score += 2;
  else if (tokens >= 4) score += 1;
  if (title.length >= 40) score += 1;
  if (STRONG_DOMAIN_RE.test(domain)) score += 1;
  const rawTitle = String(item.title ?? "");
  if (isWeakExampleTitle(rawTitle, { theme }) || isWeakExampleTitle(title, { theme })) {
    // PDF-47 — SERP «…» title that still names the risk theme is recoverable
    // via snippet; do not bury it under bare-FIO penalty.
    if (SERP_TRUNCATED_RE.test(rawTitle.trim()) && theme.keywords.test(rawTitle)) score -= 3;
    else score -= 12;
  }
  if (!title && snippet.length >= 40) score += 1;
  return score;
}

/**
 * PDF-44 H.2 — pick a client-facing quote: strong title, else theme-relevant snippet.
 */
/**
 * Поверхности, у которых нет заголовка публикации.
 *
 * ИИ-ответ, поисковая подсказка и связанный запрос — не статьи: цитировать у
 * них нечего. В поле `title` лежит служебная строка поверхности, и когда она
 * шла в доказательства наравне с заголовками, в отчёт попадали строки вида
 * «AI overview: Имя Фамилия and Компания (RU) #3» — как будто это найденная
 * публикация о субъекте.
 *
 * Тема при этом не пропадает: без цитат утверждение собирается по числу
 * материалов и доменам, а сами поверхности показываются в своих разделах.
 */
const NON_QUOTABLE_EVIDENCE_TYPES = new Set(["ai_answer", "suggestion", "related_query"]);

export function resolveExampleQuote(
  item: RawInventoryItem,
  theme: ThemeDef
): ClaimEvidenceExample | null {
  if (NON_QUOTABLE_EVIDENCE_TYPES.has(String(item.evidenceType ?? "").toLowerCase())) {
    return null;
  }
  const domain = domainOf(item.sourceUrl);
  const title = cleanExampleTitle(String(item.title ?? ""));
  const rawTitle = String(item.title ?? "");
  if (title && !isWeakExampleTitle(rawTitle, { theme })) {
    const q = quoteForClaim(rawTitle, 220);
    if (
      q &&
      !isWeakExampleTitle(q, { theme }) &&
      !hasDanglingTail(q) &&
      !isIncompleteClientQuote(q)
    ) {
      return { title: q, domain };
    }
  }

  const snip = String(item.snippet ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  // PDF-47/48 — SERP-truncated title still carries theme keywords («Рыбка»,
  // «Навальный»): close the snippet into a complete headline, never «…,».
  const titleCarriesTheme = theme.keywords.test(rawTitle) || theme.keywords.test(title);
  if (
    snip.length >= 40 &&
    (theme.keywords.test(snip) || getAdversePatterns().test(snip) || titleCarriesTheme)
  ) {
    const headline = snippetToClientHeadline(snip);
    if (
      headline.length >= 24 &&
      !hasDanglingTail(headline) &&
      !isIncompleteClientQuote(headline)
    ) {
      const q = quoteForClaim(headline, 220) || (headline.length <= 220 ? headline : "");
      if (q && !isIncompleteClientQuote(q)) return { title: q, domain };
    }
  }
  return null;
}

/** Pick up to 2 ranked, non-weak quotes from a finding evidence bucket. */
export function pickClaimExamples(
  items: RawInventoryItem[],
  theme: ThemeDef,
  adverseItems: RawInventoryItem[] = []
): ClaimEvidenceExample[] {
  const adverseSet = new Set(adverseItems);
  const ranked = [...items].sort((a, b) => {
    const sa = scoreExampleForTheme(a, theme) + (adverseSet.has(a) ? 0.5 : 0);
    const sb = scoreExampleForTheme(b, theme) + (adverseSet.has(b) ? 0.5 : 0);
    return sb - sa;
  });
  const examples: ClaimEvidenceExample[] = [];
  const seen = new Set<string>();
  for (const i of ranked) {
    const ex = resolveExampleQuote(i, theme);
    if (!ex?.title) continue;
    const key = `${ex.title.toLowerCase()}|${ex.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(ex);
    if (examples.length >= 2) break;
  }
  return examples;
}

/**
 * PDF-40 G.2b / PDF-44 H — concrete claim: framing (+ domain anchor) → quotes → scale → why.
 * Theme label is prepended by consumers (`themedClaim`).
 */
export function buildClientFacingClaim(input: {
  theme: ThemeDef;
  itemsCount: number;
  adverseCount: number;
  /** Prefer adverse evidence first; title+domain pairs from the corpus. */
  examples: ClaimEvidenceExample[];
  /** @deprecated kept for call-site compat; ignored when examples is set. */
  domains?: string[];
  /** @deprecated kept for call-site compat; ignored when examples is set. */
  titles?: string[];
}): string {
  const baseFraming =
    CLIENT_THEME_FRAMING[input.theme.themeId] ??
    `Найдены публикации по теме «${input.theme.label}»`;
  const why =
    CLIENT_THEME_WHY[input.theme.themeId] ??
    "Для банка, инвестора или контрагента это сигнал к углублённой проверке.";

  let examples = (input.examples ?? [])
    .map((e) => ({
      title: cleanExampleTitle(e.title),
      domain: String(e.domain ?? "")
        .replace(/^www\./iu, "")
        .trim(),
    }))
    .filter(
      (e) =>
        e.title.length >= 12 &&
        !/^potential\s+match$/i.test(e.title) &&
        !/^потенциальное совпадение$/i.test(e.title) &&
        !isWeakExampleTitle(e.title, { theme: input.theme })
    );
  // Compat path: old callers still pass titles/domains separately.
  if (examples.length === 0 && (input.titles?.length || input.domains?.length)) {
    const domains = input.domains ?? [];
    examples = (input.titles ?? [])
      .map((t, i) => ({ title: cleanExampleTitle(t), domain: domains[i] ?? domains[0] ?? "" }))
      .filter(
        (e) => e.title.length >= 12 && !isWeakExampleTitle(e.title, { theme: input.theme })
      );
  }

  // PDF-46/47 — up to 2 full quotes (never mid-cut); second evidence is kept
  // when it adds a distinct risk angle (e.g. FБК/Приходько + Guardian).
  const quoteLines: string[] = [];
  // Два примера — но про разные сюжеты.
  //
  // Здесь стояло `examples.slice(0, 2)`: два первых подряд, без вопроса, не
  // одна ли это публикация. В отчёте о Тинькове (28.07, стр.5) так вышло —
  // «Oleg Tinkov Net Worth…» и «Oleg Tinkov: Oleg Tinkov Net Worth… -
  // Goodreturns» с одного goodreturns.in: одна статья предъявлена как два
  // свидетельства, и читатель видит одно предложение дважды подряд.
  //
  // Правило общее с построителем региональных резюме — оно одно на оба места.
  for (const e of pickDistinctTitles(examples, 2)) {
    const q = quoteForClaim(e.title, 220);
    if (!q || isWeakExampleTitle(q, { theme: input.theme }) || hasDanglingTail(q)) continue;
    // Домен называется клиенту только если он не из демо-данных.
    const safe = clientSafeDomain(e.domain);
    quoteLines.push(safe ? `«${q}» — источник ${safe}` : `«${q}»`);
  }

  const total = pluralRu(input.itemsCount, "материал", "материала", "материалов");
  const scale =
    input.adverseCount > 0
      ? `Всего по теме: ${input.itemsCount} ${total}, с негативным контекстом — ${input.adverseCount}.`
      : `Всего по теме: ${input.itemsCount} ${total}.`;

  // Domain anchors stay on quote lines («…» — источник domain) — do NOT append
  // «(в т.ч. материалы на …)» to framing: long parentheticals get mid-clipped by
  // the renderer and trip the dangling-bullet QA (PDF-44 render 500 on p4).
  const framing = baseFraming;
  const anchorDomains = [
    ...new Set(
      clientSafeDomains([
        ...examples.map((e) => e.domain),
        ...(input.domains ?? []).map((d) => d.replace(/^www\./iu, "").trim()),
      ])
    ),
  ].slice(0, 2);

  if (quoteLines.length === 0) {
    const domainHint = clientSafeDomains(input.domains ?? []).slice(0, 3).join(", ");
    const gap = domainHint
      ? `По теме ${input.itemsCount} ${total} в источниках ${domainHint}; отдельный заголовок с сутью риска в выдаче не выделен — сверить первоисточники.`
      : `По теме ${input.itemsCount} ${total}; отдельный заголовок с сутью риска в выдаче не выделен — сверить первоисточники.`;
    return [`${framing}.`, gap, scale, why].join("\n");
  }
  const whereLine =
    anchorDomains.length > 0 ? `Где видно: ${anchorDomains.join(", ")}.` : "";
  return [`${framing}:`, ...quoteLines, scale, whereLine, why].filter(Boolean).join("\n");
}

/**
 * PDF-36 D.5 — SERP headline quoted as a client example: strip raw source
 * suffixes («… | Дзен»), trailing timestamps («- 03.12.25 22:27») and a
 * final fragment the search engine itself truncated with an ellipsis.
 */
/** Названия справочных площадок, приклеиваемые к заголовку карточки. */
const REFERENCE_SOURCE_SUFFIX =
  /\s*[-–—]\s*(?:Википедия|Wikipedia|Wikidata|Циклопедия|Рувики|RuWiki|Энциклопедия[^-–—]*|ПЕРСОНА\s+ТАСС|Telegram\s+Вики|[A-Za-zА-Яа-яЁё ]{0,20}Вики(?:педия)?)\s*$/iu;

/**
 * Кончается ли текст концом предложения, а не точкой внутри числа или инициала.
 *
 * Точка — не всегда граница: «$18.4 billion», «Фонд А.Усманова», «1.4B». Взяв
 * её за конец предложения, восстановление обрезанного заголовка давало
 * «Благотворительный Фонд А.» и «Alisher Usmanov is worth is an estimated
 * $18.» — обрывки, ради устранения которых восстановление и делалось.
 */
export function endsWithSentence(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[!?…»]$/u.test(t)) return true;
  if (!/\.$/u.test(t)) return false;
  // Десятичный разделитель: «$18.», «1.».
  if (/\d\.$/u.test(t)) return false;
  // Инициал: «Фонд А.», «J.».
  if (/(?:^|[\s(«"])\p{Lu}\.$/u.test(t)) return false;
  return true;
}

export function cleanExampleTitle(raw: string): string {
  let t = String(raw ?? "").replace(/\s+/gu, " ").trim();
  // Source suffix after a pipe: "Заголовок | Дзен" / "… | Forbes.ru".
  t = t.replace(/\s*\|\s*[^|]{1,40}$/u, "").trim();
  // Справочный суффикс через тире: «Дуров, Павел Валерьевич — Википедия».
  // Без этого карточка-справка не опознаётся как голое имя и проходит в
  // доказательства темы, которой не касается: единственным «материалом» об
  // офшорах в отчёте оказалась статья Википедии (шаг 13, C3). Название
  // источника и так печатается отдельно.
  t = t.replace(REFERENCE_SOURCE_SUFFIX, "").trim();
  // Trailing date/time stamps: "- 03.12.25 22:27", "· 02.03.2020".
  t = t.replace(/\s*[-–—·]\s*\d{1,2}\.\d{1,2}\.\d{2,4}(?:\s+\d{1,2}:\d{2})?\s*$/u, "").trim();
  // Nested guillemets break quote parsers: «Экс-владелец «Главстроя»».
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(/«([^«»]*)«([^»]+)»([^»]*)»/gu, "«$1\"$2\"$3»");
    if (next === t) break;
    t = next;
  }
  // Search engines truncate long titles with an ellipsis: drop the broken
  // last fragment when a complete sentence remains before it.
  const m = t.match(/^(.*[.!?…»])\s*[^.!?…»]*(?:\.\.\.|…)$/u);
  if (m && m[1].length >= 20 && endsWithSentence(m[1].trim())) t = m[1].trim();
  return t.replace(/\s*(?:\.\.\.|…)\s*$/u, "").trim();
}

/** Join whole titles while the segment fits the budget — never a mid-title cut. */
export function joinTitlesWithinBudget(titles: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const t of titles) {
    const extra = (kept.length > 0 ? 3 : 0) + t.length; // " · " separator
    if (used + extra > budget) break;
    kept.push(t);
    used += extra;
  }
  if (kept.length === 0 && titles.length > 0) {
    // Single overlong title: keep it whole up to the budget word boundary.
    const slice = titles[0].slice(0, budget);
    const cut = slice.lastIndexOf(" ");
    return (cut > budget * 0.5 ? slice.slice(0, cut) : slice).trim();
  }
  return kept.join(" · ");
}

/**
 * One evidence item may support multiple genuinely different claims: it is
 * matched against EVERY theme, not consumed by the first/highest-priority one.
 */
function themesFor(item: RawInventoryItem): ThemeDef[] {
  const text = itemText(item);
  return getFindingThemes().filter(
    // Материал, утверждающий отсутствие («не было выставленных претензий»),
    // темой риска не является: иначе отчёт говорит противоположное источнику
    // (шаг 15, J1).
    (theme) => theme.keywords.test(text) && !themeHitIsNegated(text, theme.keywords)
  );
}

/** Same evidence + same normalized claim must collapse into one contribution. */
export function claimFingerprint(themeId: string, item: RawInventoryItem): string {
  const normalizedClaim = String(item.title ?? "")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return `${themeId}|${normalizedClaim}`;
}

function riskFor(theme: ThemeDef, adverseCount: number, total: number): RiskLevel {
  if (theme.baseRisk === "none") return adverseCount > 0 ? "low" : "none";
  if (adverseCount === 0) return theme.baseRisk === "high" ? "medium" : "low";
  if (theme.baseRisk === "high") return adverseCount >= 3 || adverseCount / total > 0.5 ? "critical" : "high";
  return adverseCount >= 3 ? "high" : theme.baseRisk;
}

function promotionFor(risk: RiskLevel, confidence: number): PromotionPriority {
  if ((risk === "critical" || risk === "high") && confidence >= 0.6) return "P1";
  if (risk === "high" || risk === "medium") return "P2";
  if (risk === "low") return "P3";
  return "P3";
}

function detectContradictions(
  themeId: string,
  items: RawInventoryItem[]
): { contradictions: FindingContradiction[]; limitations: string[] } {
  const contradictions: FindingContradiction[] = [];
  const limitations: string[] = [];

  const cfg = resolveFindingThemesConfig();
  const unverified = items.filter((i) => cfg.unverifiedClaimPatterns.test(itemText(i)));
  const adverse = items.filter((i) => itemIsAdverse(i));
  const positive = items.filter((i) => cfg.positivePatterns.test(itemText(i)));

  if (unverified.length > 0) {
    limitations.push(
      `${unverified.length} из ${items.length} сигналов помечены как неподтверждённые (potential match / requires review).`
    );
    if (adverse.length > unverified.length) {
      contradictions.push({
        description:
          "Часть источников подаёт тему как установленную, при этом compliance-сигналы по той же теме явно не верифицированы.",
        evidenceRefs: [...unverified.slice(0, 3), ...adverse.slice(0, 3)].map(refOf),
      });
    }
  }

  const asserting = items.filter((i) => cfg.assertionPatterns.test(itemText(i)));
  const denying = items.filter((i) => cfg.denialPatterns.test(itemText(i)));
  if (asserting.length > 0 && denying.length > 0) {
    contradictions.push({
      description:
        "Источники противоречат друг другу по существу: одни утверждают факт, другие его опровергают.",
      evidenceRefs: [...asserting.slice(0, 2), ...denying.slice(0, 2)].map(refOf),
    });
  }

  if (adverse.length > 0 && positive.length > 0) {
    contradictions.push({
      description:
        "Тональность источников противоречива: одновременно присутствуют негативные материалы и позитивно-биографические публикации.",
      evidenceRefs: [...adverse.slice(0, 2), ...positive.slice(0, 2)].map(refOf),
    });
  }

  const domains = new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean));
  if (domains.size === 1 && items.length > 1) {
    limitations.push(`Все свидетельства темы происходят из одного домена (${[...domains][0]}).`);
  }
  void themeId;

  return { contradictions, limitations };
}

export function synthesizeFindings(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  sourceHashes: string[];
  /** Coverage-driven limitations, e.g. "images (UAE): NOT_COLLECTED". */
  coverageLimitations?: string[];
}): FindingSynthesisResult {
  const themeAssignments = new Map<string, string[]>();
  const byDecisionTheme = new Map<string, RawInventoryItem[]>(); // `${decision}|${themeId}`
  const seenClaimFingerprints = new Map<string, Set<string>>(); // `${decision}|${themeId}` -> fingerprints
  const uncategorizedItems: UncategorizedMaterial[] = [];
  const seenUncategorizedRefs = new Set<string>();

  let subjectMatchEvidence = 0;
  let likelySubjectEvidence = 0;
  let ambiguousEvidence = 0;
  let otherSubjectEvidence = 0;

  for (const item of input.items) {
    const ref = refOf(item);
    const resolution = input.resolutionByRef.get(ref);
    const decision = resolution?.decision ?? "INSUFFICIENT_IDENTIFIERS";
    if (decision === "SUBJECT_MATCH") subjectMatchEvidence += 1;
    else if (decision === "LIKELY_SUBJECT") likelySubjectEvidence += 1;
    else if (decision === "AMBIGUOUS") ambiguousEvidence += 1;
    else if (decision === "OTHER_SUBJECT") otherSubjectEvidence += 1;

    // Multi-theme: evidence supports every distinct claim it matches;
    // duplicates of the same normalized claim within a theme collapse.
    // SUBJECT_MATCH/LIKELY without keyword hits → uncategorized (§3.2), not a
    // finding (never enters the risk matrix). AMBIGUOUS without hits still gets
    // a review theme so they reach «Требует подтверждения» / appendix (§2.1).
    let themes = themesFor(item);
    if (themes.length === 0) {
      if (decision === "SUBJECT_MATCH" || decision === "LIKELY_SUBJECT") {
        if (!seenUncategorizedRefs.has(ref)) {
          seenUncategorizedRefs.add(ref);
          uncategorizedItems.push({
            evidenceRef: ref,
            title: String(item.title ?? "").trim() || "(без заголовка)",
            domain: domainOf(item.sourceUrl) || "—",
            region: mapRegionBucket(item.region),
            subjectMatch: decision,
          });
        }
        continue;
      }
      if (decision === "AMBIGUOUS") {
        const fallback = FINDING_THEMES.find((t) => t.themeId === "business_profile");
        if (fallback) themes = [fallback];
      }
    }
    for (const theme of themes) {
      const key = `${decision}|${theme.themeId}`;
      const fp = claimFingerprint(theme.themeId, item);
      const fingerprints = seenClaimFingerprints.get(key) ?? new Set<string>();
      if (fingerprints.has(fp)) continue; // same evidence identity + same claim
      fingerprints.add(fp);
      seenClaimFingerprints.set(key, fingerprints);

      const assigned = themeAssignments.get(ref) ?? [];
      if (!assigned.includes(theme.themeId)) assigned.push(theme.themeId);
      themeAssignments.set(ref, assigned);

      const bucket = byDecisionTheme.get(key) ?? [];
      bucket.push(item);
      byDecisionTheme.set(key, bucket);
    }
  }

  const byRegion: UncategorizedMaterialsBlock["byRegion"] = {};
  for (const row of uncategorizedItems) {
    const bucket = byRegion[row.region] ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < UNCATEGORIZED_PER_REGION_N) {
      bucket.examples.push(row);
    }
    byRegion[row.region] = bucket;
  }
  const uncategorized: UncategorizedMaterialsBlock = {
    version: "uncategorized-materials-v1",
    count: uncategorizedItems.length,
    subjectMatchCount: uncategorizedItems.filter((r) => r.subjectMatch === "SUBJECT_MATCH")
      .length,
    likelySubjectCount: uncategorizedItems.filter((r) => r.subjectMatch === "LIKELY_SUBJECT")
      .length,
    topExamples: uncategorizedItems.slice(0, UNCATEGORIZED_TOP_N),
    allEvidenceRefs: uncategorizedItems.map((r) => r.evidenceRef),
    byRegion,
  };

  const makeFinding = (
    themeId: string,
    items: RawInventoryItem[],
    subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT"
  ): Finding => {
    const theme = FINDING_THEMES.find((t) => t.themeId === themeId)!;
    const adverseItems = items.filter((i) => itemIsAdverse(i));
    const risk = riskFor(theme, adverseItems.length, items.length);
    const evidenceRefs = items.map(refOf);
    const domains = [...new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean))];
    const providers = [...new Set(items.map((i) => String(i.provider ?? "unknown").toLowerCase()))];
    const regions = [...new Set(items.map((i) => mapRegionBucket(i.region)))];
    const surfaces = [
      ...new Set(
        items.map((i) =>
          mapSurfaceBucket(
            String(((i.rawMetadata ?? {}) as Record<string, unknown>).surface ?? i.evidenceType)
          )
        )
      ),
    ];
    const { contradictions, limitations } = detectContradictions(themeId, items);
    if (subjectMatch === "AMBIGUOUS") {
      limitations.push("Принадлежность части свидетельств проверяемому лицу не установлена однозначно.");
    }
    if (subjectMatch === "LIKELY_SUBJECT") {
      limitations.push(
        "Принадлежность вероятна по фамилии и контексту, но не подтверждена однозначно — требуется проверка."
      );
    }
    for (const l of input.coverageLimitations ?? []) limitations.push(l);

    const sourceDiversity = Math.min(domains.length / 3, 1);
    const confidence =
      subjectMatch === "SUBJECT_MATCH"
        ? Math.min(0.55 + 0.3 * sourceDiversity + (adverseItems.length > 0 ? 0.05 : 0.1), 0.95)
        : subjectMatch === "LIKELY_SUBJECT"
          ? Math.min(0.45 + 0.2 * sourceDiversity, 0.7)
          : 0.35;

    // PDF-44 H.1/H.2 — rank by theme substance; never quote bare FIO / SEO-bio.
    const examples = pickClaimExamples(items, theme, adverseItems);

    // PDF-40 G.2b — concrete quotes + domains; theme prepended by consumers.
    const claim = buildClientFacingClaim({
      theme,
      itemsCount: items.length,
      adverseCount: adverseItems.length,
      examples,
      domains,
    });

    return FindingSchema.parse({
      schemaVersion: FINDING_SCHEMA_VERSION,
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      evidenceRefs,
      findingId: `finding-${themeId}-${subjectMatch.toLowerCase()}-${createHash("sha1")
        .update(evidenceRefs.sort().join("|"))
        .digest("hex")
        .slice(0, 8)}`,
      theme: theme.label,
      claim,
      subjectMatch,
      riskLevel: risk,
      confidence,
      regions,
      sourceDomains: domains,
      providers,
      recommendedAction: theme.recommendedAction,
      contradictions,
      limitations: [...new Set(limitations)],
      promotionPriority:
        subjectMatch === "SUBJECT_MATCH" ? promotionFor(risk, confidence) : "APPENDIX",
      surfaceKinds: surfaces,
    });
  };

  const verified: Finding[] = [];
  const likelyFindings: Finding[] = [];
  const ambiguousFindings: Finding[] = [];
  const excludedFindings: Finding[] = [];

  for (const [key, items] of byDecisionTheme) {
    const [decision, themeId] = key.split("|");
    if (decision === "SUBJECT_MATCH") verified.push(makeFinding(themeId, items, "SUBJECT_MATCH"));
    else if (decision === "LIKELY_SUBJECT")
      likelyFindings.push(makeFinding(themeId, items, "LIKELY_SUBJECT"));
    else if (decision === "AMBIGUOUS") ambiguousFindings.push(makeFinding(themeId, items, "AMBIGUOUS"));
    else if (decision === "OTHER_SUBJECT") excludedFindings.push(makeFinding(themeId, items, "OTHER_SUBJECT"));
  }

  const sortByPriority = (a: Finding, b: Finding) => {
    const order: Record<string, number> = { P1: 0, P2: 1, P3: 2, APPENDIX: 3 };
    const d = (order[a.promotionPriority] ?? 9) - (order[b.promotionPriority] ?? 9);
    return d !== 0 ? d : a.findingId.localeCompare(b.findingId);
  };
  verified.sort(sortByPriority);
  likelyFindings.sort(sortByPriority);
  ambiguousFindings.sort(sortByPriority);

  const exclusionReasons: Record<string, string> = {};
  for (const f of excludedFindings) {
    exclusionReasons[f.findingId] = "OTHER_SUBJECT: свидетельства относятся к другому лицу";
  }

  const bundle: VerifiedFindingBundle = VerifiedFindingBundleSchema.parse({
    schemaVersion: VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    // KPI / confirmed evidence: SUBJECT_MATCH only (§2.1 invariant).
    evidenceRefs: verified.flatMap((f) => f.evidenceRefs),
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    // LIKELY stays in the bundle for matrix «Требует подтверждения», not KPI.
    findings: [...verified, ...likelyFindings, ...excludedFindings],
    excludedFindingIds: excludedFindings.map((f) => f.findingId),
    exclusionReasons,
  });

  return {
    bundle,
    ambiguousFindings,
    themeAssignments,
    uncategorized,
    stats: {
      subjectMatchEvidence,
      likelySubjectEvidence,
      ambiguousEvidence,
      otherSubjectEvidence,
      adverseFindingCount: verified.filter((f) =>
        ["medium", "high", "critical"].includes(f.riskLevel)
      ).length,
      uncategorizedCount: uncategorized.count,
    },
  };
}
