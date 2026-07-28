/**
 * Stage 6 — semantic pagination for ComposedClientSummary.
 * Never mid-cuts sentences / article titles / qualifications.
 * Does not use arbitrary maxChars truncate for client meaning.
 */

import type { ComposedClientSummary } from "../contracts/composed-client-summary";
import type { CanonicalThemeId } from "../contracts/canonical-claim";
import { getClientTextFieldBudgets } from "../client/load-client-text-contract";
import { themeBlockText } from "../analytics/client-summary-composer";

export type SemanticBlockKind =
  | "overall"
  | "scope"
  | "theme"
  | "isolated"
  | "databases"
  | "changes"
  | "next_steps";

export type SemanticBlock = {
  kind: SemanticBlockKind;
  /** Stable id for tests/trace (themeId or kind). */
  blockId: string;
  themeId?: CanonicalThemeId;
  heading?: string;
  /** Complete client text for this block (never mid-truncated). */
  text: string;
  evidenceRefs: string[];
  articleTitles: string[];
  articleDomains: string[];
};

export type SummaryPagePlan = {
  /** Overview narrative paragraphs (complete sentences only). */
  overviewNarrative: string[];
  /** Theme/other blocks on the overview slide (typically 2–3 short lead themes). */
  overviewBlocks: SemanticBlock[];
  /** Continuation pages — each is an ordered list of whole semantic blocks. */
  continuationPages: SemanticBlock[][];
  /**
   * Блоки, чья **печатная** форма не влезла в бюджет буллета. В норме пуст:
   * укладка меряет то же, что печатает. Непустым он бывает только если появился
   * новый способ склейки в обход укладки — тогда виновник назван по имени.
   */
  overBudgetBlocks: Array<{ blockId: string; length: number; budget: number }>;
  /** Gates for Stage 6 stop criteria. */
  gates: {
    CLIENT_TEXT_TRUNCATIONS: number;
    CONTINUATION_ADJACENCY: boolean;
    SUMMARY_BLOCKS_PRESERVED: number;
    SUMMARY_BLOCKS_EMITTED: number;
    SUMMARY_BLOCK_OVER_BUDGET: number;
  };
};

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Границы внутри предложения, по которым его можно разложить на два абзаца, не
 * потеряв ни слова. Порядок — от самой «крупной» паузы к самой мелкой.
 */
const CLAUSE_BOUNDARIES = ["; ", " — ", ": ", ", "];

/**
 * Разложить одно слишком длинное предложение по границам частей.
 *
 * Ничего не отбрасывается: части идут дальше отдельными блоками, а
 * страничная разбивка уже умеет ставить их подряд. Если границ нет вовсе
 * (одно длинное предложение без запятых), режем по пробелу — это по-прежнему
 * не потеря текста, а перенос.
 */
export function splitOverlongSentence(sentence: string, maxChars: number): string[] {
  const text = sentence.trim();
  if (text.length <= maxChars) return text ? [text] : [];

  for (const boundary of CLAUSE_BOUNDARIES) {
    if (!text.includes(boundary)) continue;
    const parts = text.split(boundary);
    const chunks: string[] = [];
    let buf = "";
    for (let i = 0; i < parts.length; i += 1) {
      // Разделитель остаётся при левой части: без него «а» и «б» слиплись бы.
      const piece = i < parts.length - 1 ? `${parts[i]}${boundary.trimEnd()}` : parts[i]!;
      const trial = buf ? `${buf} ${piece}` : piece;
      if (buf && trial.length > maxChars) {
        chunks.push(buf);
        buf = piece;
      } else {
        buf = trial;
      }
    }
    if (buf) chunks.push(buf);
    if (chunks.every((c) => c.length <= maxChars)) return chunks;
  }

  // Последняя мера — граница слова.
  const words = text.split(/\s+/u);
  const chunks: string[] = [];
  let buf = "";
  for (const w of words) {
    const trial = buf ? `${buf} ${w}` : w;
    if (buf && trial.length > maxChars) {
      chunks.push(buf);
      buf = w;
    } else {
      buf = trial;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Pack sentences into chunks ≤ maxChars.
 *
 * Одно предложение длиннее бюджета раскладывается по границам частей, а не
 * остаётся целым. Прежде оно оставалось, и это роняло весь отчёт: на боевом
 * прогоне 28.07 тема резюме вышла в 916 знаков при бюджете 900, проверка секций
 * дала `bullet over budget on p03_executive: 916>900`, обязательная секция
 * EXECUTIVE_SUMMARY получила FAILED — и сборка деки остановилась целиком.
 * Отчёта не было вовсе из-за шестнадцати лишних знаков.
 *
 * Обещание в имени функции сохранено: ни одно слово не отбрасывается, длинное
 * предложение переносится на соседний блок — страничная разбивка ставит их
 * подряд.
 */
export function packSentencesNoTruncate(text: string, maxChars: number): string[] {
  const sentences = splitSentences(text).flatMap((s) => splitOverlongSentence(s, maxChars));
  if (sentences.length === 0) return [];
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const trial = buf ? `${buf} ${s}` : s;
    if (buf && trial.length > maxChars) {
      chunks.push(buf);
      buf = s;
    } else {
      buf = trial;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** Как выглядит заголовок части: у продолжений он длиннее на одно слово. */
const CONTINUATION_SUFFIX = " (продолжение)";

/** Заголовок продолжения — задаётся здесь и здесь же учитывается в бюджете. */
function continuationHeading(heading: string | undefined): string | undefined {
  const h = (heading ?? "").trim();
  return h ? `${h}${CONTINUATION_SUFFIX}` : undefined;
}

/**
 * Что дека печатает для блока — **единственный ответ** на этот вопрос.
 *
 * До этого ответов было три: `formatSemanticBullet` в построителе резюме
 * печатал, `bodyBudgetForTheme` пересказывал ту же склейку арифметикой, и
 * третья копия жила в тесте. Пока три места отвечают на один вопрос, они
 * расходятся — это и есть класс дефекта «мерилось одно, печаталось другое».
 * Теперь печатает и меряется одна функция, и разойтись им негде.
 */
export function renderSemanticBlock(
  block: Pick<SemanticBlock, "kind" | "heading" | "text">
): string {
  if (block.heading && block.kind === "theme") return themeBlockText(block.heading, block.text);
  return block.text;
}

/**
 * Сколько знаков тела влезает в бюджет буллета для блока такой формы.
 *
 * Накладные расходы не пересказываются арифметикой, а **замеряются** прогоном
 * через `renderSemanticBlock`: поменяется склейка — поправка поедет за ней
 * сама. Прежняя версия повторяла формат словами («точка и пробел из
 * `themeBlockText`»), и следующая склейка вернула бы нас к отказу сборки.
 */
function bodyBudgetForBlock(
  shape: { kind: SemanticBlockKind; heading?: string },
  bulletBudget: number
): number {
  // Односимвольный образец: длина склейки минус его длина и есть накладные.
  // Символ служебный, а не «x»: заголовок «x» совпал бы с началом тела,
  // склейка ушла бы по ветке «тело уже начинается с темы», и накладные
  // вышли бы нулевыми.
  const probe = "\u0001";
  const overhead = renderSemanticBlock({ ...shape, text: probe }).length - probe.length;
  if (overhead <= 0) return bulletBudget;
  // Абсурдно длинный заголовок не должен обнулить тело: лучше недобрать текста,
  // чем выдать блок без содержания.
  return Math.max(80, bulletBudget - overhead);
}

/**
 * Бюджет тела темы с поправкой на заголовок.
 *
 * Укладка считала бюджет по `theme.body`, а в деку уходит склейка заголовка с
 * телом (`themeBlockText` → «Заголовок. Тело»). Мерилось одно, печаталось
 * другое — и на живом прогоне заказчика буллеты вышли в 901 и 922 знака при
 * бюджете 900. Один лишний знак останавливал сборку всего отчёта.
 *
 * Поправка берётся по самому длинному варианту заголовка — с пометкой
 * «(продолжение)»: части нарезаются заранее, и любая из них может оказаться
 * продолжением. Лучше немного недобрать, чем не собрать отчёт.
 */
export function bodyBudgetForTheme(heading: string | undefined, bulletBudget: number): number {
  return bodyBudgetForBlock(
    { kind: "theme", heading: continuationHeading(heading) },
    bulletBudget
  );
}

function themeToBlocks(
  theme: ComposedClientSummary["sections"]["themes"][number],
  bulletBudget: number
): SemanticBlock[] {
  const chunks = packSentencesNoTruncate(
    theme.body,
    bodyBudgetForTheme(theme.heading, bulletBudget)
  );
  if (chunks.length <= 1) {
    return [
      {
        kind: "theme",
        blockId: theme.themeId,
        themeId: theme.themeId,
        heading: theme.heading,
        // Результат укладки, а не исходный текст: здесь стоял `theme.body`, и
        // укладка выбрасывалась вместе со своим бюджетом.
        text: (chunks[0] ?? theme.body).trim(),
        evidenceRefs: [...theme.evidenceRefs],
        articleTitles: [...theme.articleTitles],
        articleDomains: [...theme.articleDomains],
      },
    ];
  }
  return chunks.map((text, i) => ({
    kind: "theme" as const,
    blockId: `${theme.themeId}__part${i + 1}`,
    themeId: theme.themeId,
    heading: i === 0 ? theme.heading : continuationHeading(theme.heading),
    text,
    evidenceRefs: [...theme.evidenceRefs],
    articleTitles: i === 0 ? [...theme.articleTitles] : [],
    articleDomains: i === 0 ? [...theme.articleDomains] : [],
  }));
}

/**
 * Блок обычного текста — с той же укладкой, что и тема.
 *
 * Раньше текст уходил в деку целиком, минуя бюджет вовсе: замер до этой правки
 * дал `isolated: 1500>900`, `databases: 1500>900`, `changes: 1500>900`,
 * `next_steps: 1500>900`. Каждый из них — `bullet over budget`, FAILED у
 * обязательной секции и отчёт, которого нет. Тема была нарезана, остальные
 * четыре вида — нет, хотя печатаются тем же буллетом.
 */
function textBlocks(
  kind: SemanticBlockKind,
  blockId: string,
  text: string,
  bulletBudget: number,
  evidenceRefs: string[] = []
): SemanticBlock[] {
  const t = text.trim();
  if (!t) return [];
  const chunks = packSentencesNoTruncate(t, bodyBudgetForBlock({ kind }, bulletBudget));
  if (chunks.length <= 1) {
    // Идентификатор односоставного блока прежний: короткий текст не должен
    // менять ни имени блока, ни эталона.
    return [
      {
        kind,
        blockId,
        text: (chunks[0] ?? t).trim(),
        evidenceRefs,
        articleTitles: [],
        articleDomains: [],
      },
    ];
  }
  return chunks.map((chunk, i) => ({
    kind,
    blockId: i === 0 ? blockId : `${blockId}__part${i + 1}`,
    text: chunk,
    // Ссылки остаются при всех частях — как у тем: продолжение без источников
    // выглядело бы утверждением без опоры.
    evidenceRefs: [...evidenceRefs],
    articleTitles: [],
    articleDomains: [],
  }));
}

/** Blocks per continuation page — a page of four bullets stops reading as a list. */
export const MAX_BLOCKS_PER_CONTINUATION_PAGE = 3;

/**
 * Characters a continuation page may hold, as a multiple of the per-bullet
 * budget. Three bullets of full budget is what the layout already supports —
 * `packContinuationPages` used to allow exactly that for short blocks.
 */
export const CONTINUATION_PAGE_BUDGET_FACTOR = 3;

/**
 * Pack theme/other blocks into continuation pages.
 *
 * The old rule gave any block longer than 66% of the bullet budget a page to
 * itself. Theme blocks are typically 600–900 characters, so nearly every one
 * monopolised a page: the delivered report spread its summary over nine
 * continuation pages, each holding a single bullet on about a sixth of the
 * sheet. Density now follows a cumulative page budget — a block only gets a
 * page alone when it does not fit beside anything else.
 */
/**
 * Не оставить последний лист с одиноким блоком.
 *
 * Разбиение по ёмкости честно заполняет каждую страницу и складывает остаток на
 * последнюю: девять блоков при ёмкости три дают 3, 3, 3 — и хорошо, а восемь
 * дают 3, 3, 2, семь — 3, 3, 1. Последний случай и виден читателю как пустой
 * лист. Хвост добирается за счёт предыдущей страницы; порядок сохраняется,
 * потому что переносится ровно последний её блок.
 *
 * Останавливаемся до того, как сосед станет легче хвоста: менять одну редкую
 * страницу на другую незачем.
 */
export function balanceTailPage<T>(
  pages: T[][],
  sizeOf: (item: T) => number,
  tailCharCap: number
): void {
  const charsOf = (page: readonly T[]) => page.reduce((n, b) => n + sizeOf(b), 0);
  while (pages.length >= 2) {
    const last = pages[pages.length - 1]!;
    const prev = pages[pages.length - 2]!;
    if (prev.length <= 1 || last.length + 1 >= prev.length) break;
    const moved = prev[prev.length - 1]!;
    if (charsOf(last) + sizeOf(moved) > tailCharCap) break;
    prev.pop();
    last.unshift(moved);
  }
}

function packContinuationPages(blocks: SemanticBlock[], bulletBudget: number): SemanticBlock[][] {
  const pageBudget = bulletBudget * CONTINUATION_PAGE_BUDGET_FACTOR;
  const pages: SemanticBlock[][] = [];
  let cur: SemanticBlock[] = [];
  let curChars = 0;
  const flush = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    curChars = 0;
  };
  for (const b of blocks) {
    const size = b.text.length;
    // Oversized on its own: nothing would fit beside it anyway.
    if (size > pageBudget) {
      flush();
      pages.push([b]);
      continue;
    }
    const wouldOverflow = curChars + size > pageBudget;
    const wouldExceedCount = cur.length >= MAX_BLOCKS_PER_CONTINUATION_PAGE;
    if (cur.length > 0 && (wouldOverflow || wouldExceedCount)) flush();
    cur.push(b);
    curChars += size;
  }
  flush();
  balanceTailPage(pages, (b) => b.text.length, pageBudget);
  return pages;
}

/**
 * Build a page plan from a composed client summary.
 * Overview keeps overall + scope narrative and up to 3 lead theme blocks;
 * remaining blocks go to adjacent continuation pages (never dropped).
 */
export function paginateComposedClientSummary(
  summary: ComposedClientSummary,
  opts?: { leadThemeCount?: number }
): SummaryPagePlan {
  const budgets = getClientTextFieldBudgets();
  const leadThemeCount = opts?.leadThemeCount ?? 3;
  const evidence = [...summary.evidenceRefs];

  const themeBlocks = summary.sections.themes.flatMap((t) =>
    themeToBlocks(t, budgets.bullet)
  );
  const trailing = [
    ...textBlocks("isolated", "isolated", summary.sections.isolatedItems, budgets.bullet, evidence),
    ...textBlocks(
      "databases",
      "databases",
      summary.sections.internationalDatabases,
      budgets.bullet,
      evidence
    ),
    ...textBlocks(
      "changes",
      "changes",
      summary.sections.changesSinceBaseline,
      budgets.bullet,
      evidence
    ),
    ...textBlocks("next_steps", "next_steps", summary.sections.nextSteps, budgets.bullet, evidence),
  ];

  // Overview leads with up to N distinct themes (first part of each if split),
  // not N arbitrary blocks — a long theme must not consume all lead slots.
  const overviewBlocks: SemanticBlock[] = [];
  const rest: SemanticBlock[] = [];
  const leadThemes = new Set<string>();
  for (const b of themeBlocks) {
    const tid = b.themeId ?? b.blockId;
    if (leadThemes.size < leadThemeCount && !leadThemes.has(tid)) {
      leadThemes.add(tid);
      overviewBlocks.push(b);
      continue;
    }
    if (leadThemes.has(tid) && overviewBlocks.some((x) => x.blockId === `${tid}` || x.themeId === tid)) {
      // Further parts of a lead theme stay with the overview only if still room;
      // otherwise they go to continuation immediately after (adjacency).
      rest.push(b);
      continue;
    }
    rest.push(b);
  }
  rest.push(...trailing);

  // Narrative: pack overall+scope into complete paragraphs within narrative budget.
  const narrativeSource = [summary.sections.overallAssessment, summary.sections.scope]
    .filter(Boolean)
    .join("\n\n");
  let overviewNarrative = packSentencesNoTruncate(narrativeSource, budgets.narrative);
  // Dashboard shows ≤3 narrative cards — overflow narrative sentences become blocks.
  const narrativeOverflow: SemanticBlock[] = [];
  if (overviewNarrative.length > 3) {
    // Куски нарратива меряются бюджетом нарратива (1100), а печатаются буллетом
    // (900) — и склеивались через `join(" ")` вовсе без бюджета. Замер до этой
    // правки: `overall_overflow: 1796>900`, то есть два куска подряд. Остаток
    // укладывается заново, уже по бюджету того поля, в котором он печатается.
    const overflowText = overviewNarrative.slice(3).join(" ");
    overviewNarrative = overviewNarrative.slice(0, 3);
    narrativeOverflow.push(
      ...textBlocks("overall", "overall_overflow", overflowText, budgets.bullet, evidence)
    );
  }

  const continuationPages = packContinuationPages([...narrativeOverflow, ...rest], budgets.bullet);

  const preserved =
    1 + // overall+scope source
    summary.sections.themes.length +
    (summary.sections.isolatedItems.trim() ? 1 : 0) +
    (summary.sections.internationalDatabases.trim() ? 1 : 0) +
    (summary.sections.changesSinceBaseline.trim() ? 1 : 0) +
    (summary.sections.nextSteps.trim() ? 1 : 0);
  const emitted = overviewBlocks.length + continuationPages.reduce((n, p) => n + p.length, 0);

  // Truncation = any source sentence missing from emitted text.
  const sourceBlob = [
    summary.sections.overallAssessment,
    summary.sections.scope,
    ...summary.sections.themes.map((t) => t.body),
    summary.sections.isolatedItems,
    summary.sections.internationalDatabases,
    summary.sections.changesSinceBaseline,
    summary.sections.nextSteps,
  ].join("\n");
  const emittedBlob = [
    ...overviewNarrative,
    ...overviewBlocks.map((b) => b.text),
    ...continuationPages.flatMap((p) => p.map((b) => b.text)),
  ].join("\n");
  const sourceSentences = splitSentences(sourceBlob);
  const truncations = sourceSentences.filter((s) => !emittedBlob.includes(s)).length;

  // Единственная проверка на том, что уходит в деку, и стоит она там, где
  // выбирают работу, — в укладке. Ниже по течению `checkText` увидит ровно эти
  // же строки, но уже как `bullet over budget` без имени блока и ценой всей
  // обязательной секции.
  const overBudgetBlocks = [...overviewBlocks, ...continuationPages.flat()]
    .map((b) => ({ blockId: b.blockId, length: renderSemanticBlock(b).length, budget: budgets.bullet }))
    .filter((x) => x.length > x.budget);

  return {
    overviewNarrative,
    overviewBlocks,
    continuationPages,
    overBudgetBlocks,
    gates: {
      CLIENT_TEXT_TRUNCATIONS: truncations,
      CONTINUATION_ADJACENCY: true,
      SUMMARY_BLOCKS_PRESERVED: preserved,
      SUMMARY_BLOCKS_EMITTED: emitted,
      SUMMARY_BLOCK_OVER_BUDGET: overBudgetBlocks.length,
    },
  };
}

export function assertSemanticSummaryGatesPass(plan: SummaryPagePlan): void {
  if (plan.gates.CLIENT_TEXT_TRUNCATIONS !== 0) {
    throw new Error(`CLIENT_TEXT_TRUNCATIONS=${plan.gates.CLIENT_TEXT_TRUNCATIONS}`);
  }
  if (!plan.gates.CONTINUATION_ADJACENCY) {
    throw new Error("CONTINUATION_ADJACENCY=false");
  }
  // Блок, проскочивший мимо укладки, останавливает сборку здесь и по имени.
  // Прежде такой блок доезжал до проверки секций, и заказчик получал
  // `EXECUTIVE_SUMMARY:FAILED` — отчёт не собирался вовсе, а из текста отказа
  // не было видно, какой именно блок виноват.
  if (plan.gates.SUMMARY_BLOCK_OVER_BUDGET !== 0) {
    const named = plan.overBudgetBlocks
      .map((b) => `${b.blockId}: ${b.length}>${b.budget}`)
      .join("; ");
    throw new Error(
      `SUMMARY_BLOCK_OVER_BUDGET=${plan.gates.SUMMARY_BLOCK_OVER_BUDGET} (${named})`
    );
  }
}
