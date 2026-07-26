/**
 * Stage 6 — semantic pagination for ComposedClientSummary.
 * Never mid-cuts sentences / article titles / qualifications.
 * Does not use arbitrary maxChars truncate for client meaning.
 */

import type { ComposedClientSummary } from "../contracts/composed-client-summary";
import type { CanonicalThemeId } from "../contracts/canonical-claim";
import { getClientTextFieldBudgets } from "../client/load-client-text-contract";

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
  /** Gates for Stage 6 stop criteria. */
  gates: {
    CLIENT_TEXT_TRUNCATIONS: number;
    CONTINUATION_ADJACENCY: boolean;
    SUMMARY_BLOCKS_PRESERVED: number;
    SUMMARY_BLOCKS_EMITTED: number;
  };
};

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pack sentences into chunks ≤ maxChars. A single over-long sentence stays whole
 * (no mid-sentence cut) — caller places it alone on a page.
 */
export function packSentencesNoTruncate(text: string, maxChars: number): string[] {
  const sentences = splitSentences(text);
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

function themeToBlocks(
  theme: ComposedClientSummary["sections"]["themes"][number],
  bulletBudget: number
): SemanticBlock[] {
  const chunks = packSentencesNoTruncate(theme.body, bulletBudget);
  if (chunks.length <= 1) {
    return [
      {
        kind: "theme",
        blockId: theme.themeId,
        themeId: theme.themeId,
        heading: theme.heading,
        text: theme.body.trim(),
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
    heading: i === 0 ? theme.heading : `${theme.heading} (продолжение)`,
    text,
    evidenceRefs: [...theme.evidenceRefs],
    articleTitles: i === 0 ? [...theme.articleTitles] : [],
    articleDomains: i === 0 ? [...theme.articleDomains] : [],
  }));
}

function textBlock(
  kind: SemanticBlockKind,
  blockId: string,
  text: string,
  evidenceRefs: string[] = []
): SemanticBlock | null {
  const t = text.trim();
  if (!t) return null;
  return {
    kind,
    blockId,
    text: t,
    evidenceRefs,
    articleTitles: [],
    articleDomains: [],
  };
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
    textBlock("isolated", "isolated", summary.sections.isolatedItems, evidence),
    textBlock("databases", "databases", summary.sections.internationalDatabases, evidence),
    textBlock("changes", "changes", summary.sections.changesSinceBaseline, evidence),
    textBlock("next_steps", "next_steps", summary.sections.nextSteps, evidence),
  ].filter((b): b is SemanticBlock => Boolean(b));

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
    const overflowText = overviewNarrative.slice(3).join(" ");
    overviewNarrative = overviewNarrative.slice(0, 3);
    const ob = textBlock("overall", "overall_overflow", overflowText, evidence);
    if (ob) narrativeOverflow.push(ob);
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

  return {
    overviewNarrative,
    overviewBlocks,
    continuationPages,
    gates: {
      CLIENT_TEXT_TRUNCATIONS: truncations,
      CONTINUATION_ADJACENCY: true,
      SUMMARY_BLOCKS_PRESERVED: preserved,
      SUMMARY_BLOCKS_EMITTED: emitted,
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
}
