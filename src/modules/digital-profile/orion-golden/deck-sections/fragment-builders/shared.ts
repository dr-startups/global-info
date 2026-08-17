/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type {
  SectionType,
  SlideBody,
  SlideContentContract,
} from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY, type DeckTemplateId } from "../template-registry";
import { balanceTailPage } from "../semantic-summary-pagination";
import {
  normalizeEvidenceRef,
  regionMatches,
  resolveEmptySurfaceCollection,
  type EmptySurfaceCollectionStatus,
  type LinkReadRegionCounts,
  type MetricSnapshot,
  type ScopedFragmentInput,
  type SurfaceCollectionHint,
} from "../scoped-input";
import {
  type CanonicalSlotDef,
  type VisibleAssetItem,
  type VisualAssetsBySlot,
} from "../canonical-slots";
import type { Finding } from "../../contracts/finding";
import type { SurfaceClaim } from "../../contracts/surface-analysis";
import { ADVERSE_PATTERNS } from "../../analytics/surface-analyzers";
import { VISUAL_ASSET_UNAVAILABLE } from "../slide-markers";
import { clampQuotedLine, closeDanglingQuote } from "../quote-integrity";
import { normalizeForCompare } from "../text-compare";
import { pageQuoteForClient } from "../../analytics/client-quote-hygiene";
import {
  cleanExampleTitle,
  isWeakExampleTitle,
  quoteForClaim,
  joinTitlesWithinBudget,
  pluralRu,
} from "../../analytics/finding-synthesizer";
import { getFindingThemes } from "../../../config/finding-themes";
import {
  freshnessFootnote,
  reportDiffClientLine,
} from "../../../services/report-material-freshness";
export { pickDistinctTitles, titleFingerprint } from "../../analytics/distinct-stories";
import { pickDistinctTitles } from "../../analytics/distinct-stories";
import { clientSafeDomains, isMockClientDomain } from "../../../services/composite-serp-merge";
import { getClientTextFieldBudgets } from "../../client/load-client-text-contract";
import type { ComposedClientSummary } from "../../contracts/composed-client-summary";

export type ExecutiveSummaryExtras = {
  verdict: string;
  executiveConclusion: string;
  keyFindings: Array<{
    findingId: string;
    title: string;
    factualBasis: string;
    clientImpact: string;
    recommendedAction: string;
  }>;
  priorityActions: string[];
  identityCaveats: string[];
  dataLimitations: string[];
  /**
   * Optional regional one-liners from the executive-summary stage artifact.
   *
   * В клиентский текст не подмешиваются: их процент («негативные материалы — 3
   * из 42 (7 %)») считается по субъектным материалам региона и отвечает на тот
   * же вопрос, что доля негатива среди прочитанных страниц, другим
   * определением. Двух ответов на один вопрос в отчёте быть не должно —
   * печатается только доля по прочитанному (`readShareExecutiveLine`).
   * Артефакт поле сохраняет: его читают гарды и разбор прогона.
   */
  regionalOverview?: Array<{
    region: string;
    oneLiner: string;
    totalCount?: number | null;
  }>;
};

/**
 * Sanitized stage-1 GPT case analysis (already client-safe): a holistic
 * assessment of the whole verified corpus. Used to write the executive
 * summary and to expand each risk theme with a client-language explanation
 * and concrete advice.
 */
export type GptCaseAnalysisExtras = {
  overallRiskLevel: string;
  executiveConclusion: string;
  digitalPortrait?: string;
  keyRisks: Array<{ theme: string; severity: string; explanation: string; advice: string }>;
  positiveSignals: string[];
  recommendations: string[];
};

/** REMEDIATION §3.2 — themeless SUBJECT_MATCH/LIKELY examples for regional summary. */
export type UncategorizedMaterialsExtras = {
  count: number;
  byRegion: Record<
    string,
    {
      count: number;
      examples: Array<{ title: string; evidenceRef: string; domain?: string }>;
    }
  >;
};

export type FragmentExtras = {
  executiveSummary?: ExecutiveSummaryExtras;
  /**
   * Stage 5/6 — deterministic composed client summary.
   * When present, EXECUTIVE_SUMMARY uses semantic pagination (no mid-cut).
   */
  composedClientSummary?: ComposedClientSummary;
  /** Existing compliance client copy (no source expansion). */
  complianceNarrative?: string[];
  /** Typed visual assets bound per canonical slot. */
  visualAssets?: VisualAssetsBySlot;
  /** Holistic GPT case analysis (client-safe, optional). */
  gptCaseAnalysis?: GptCaseAnalysisExtras;
  /** Themeless subject materials — regional summary only, not risk matrix. */
  uncategorizedMaterials?: UncategorizedMaterialsExtras;
  /** Coverage/provider hints for empty-state copy (§7.4). */
  surfaceCollectionHints?: SurfaceCollectionHint[];
  /** REMEDIATION §7.2 — earliest/latest material capture times. */
  materialFreshness?: { earliestAt: string; latestAt: string };
  /** REMEDIATION §7.2 — counts vs previous successful report for the case. */
  reportDiff?: {
    addedCount: number;
    removedCount: number;
    previousJobId: string | null;
  };
};

/** Loose theme match: token overlap between a finding theme and a GPT risk theme. */
export function matchGptKeyRisk(
  theme: string,
  risks: GptCaseAnalysisExtras["keyRisks"] | undefined
): GptCaseAnalysisExtras["keyRisks"][number] | undefined {
  if (!risks?.length) return undefined;
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-zа-яё0-9]+/iu)
        .filter((w) => w.length > 3)
    );
  const a = tokens(theme);
  if (a.size === 0) return undefined;
  let best: { risk: GptCaseAnalysisExtras["keyRisks"][number]; score: number } | null = null;
  for (const risk of risks) {
    const b = tokens(risk.theme);
    let hit = 0;
    for (const w of a) if (b.has(w)) hit += 1;
    const score = hit / Math.max(1, Math.min(a.size, b.size));
    if (score >= 0.5 && (!best || score > best.score)) best = { risk, score };
  }
  return best?.risk;
}

export type FragmentBuildOutput = {
  slides: SlideContentContract[];
  status: "READY" | "EMPTY_VALID" | "INSUFFICIENT_DATA";
  emptyStateReason?: string;
};

export { VISUAL_ASSET_UNAVAILABLE };

export const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function isAdverse(f: Finding): boolean {
  return (RISK_ORDER[f.riskLevel] ?? 0) >= 2;
}

export function assetsFor(extras: FragmentExtras, slotId: string): string[] {
  return (extras.visualAssets?.[slotId] ?? []).filter((a) => a.hasImage).map((a) => a.assetRef);
}

export function makeSlotSlide(input: {
  slot: CanonicalSlotDef;
  sectionId: SectionType;
  templateId?: DeckTemplateId;
  title?: string;
  subtitle?: string;
  content: SlideBody;
  evidenceRefs: string[];
  findingIds: string[];
  metrics?: Record<string, number | string>;
  visualAssetRefs?: string[];
  emptyStateReason?: string;
}): SlideContentContract {
  return {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: input.slot.slotId,
    baseSlotId: input.slot.slotId,
    sectionId: input.sectionId,
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: input.templateId ?? input.slot.templateId,
    title: input.title ?? input.slot.title,
    subtitle: input.subtitle,
    content: input.content,
    evidenceRefs: input.evidenceRefs,
    findingIds: input.findingIds,
    metrics: input.metrics ?? {},
    visualAssetRefs: input.visualAssetRefs ?? [],
    emptyStateReason: input.emptyStateReason,
  };
}

/**
 * Разложить блоки по страницам: первая — с обвязкой, дальше — без неё.
 *
 * Считается и число блоков, и их суммарный объём: разбиение по одному лишь
 * числу оставляло странице то, что на ней помещалось в шесть раз, и уносило
 * хвост на отдельный лист.
 */
/**
 * Во сколько **нарисованных** строк развернётся блок.
 *
 * Структурные строки заданы переводами строки и переносятся всегда, а каждая
 * из них ещё и переносится по ширине. Счёт по знакам этого не видит:
 * тематический блок «Заголовок / Найдены публикации по теме: / цитата /
 * источник» занимает строк много, а знаков мало.
 */
export function estimateRenderedLines(text: string, charsPerLine: number): number {
  if (charsPerLine <= 0) return 1;
  return text
    .split("\n")
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.trim().length / charsPerLine)), 0);
}

export function packBulletPages(
  bullets: readonly string[],
  firstCount: number,
  contCount: number,
  itemCharBudget: number,
  lines?: {
    /** Ёмкость первой страницы в нарисованных строках. */
    first: number;
    /** То же для продолжения. */
    cont: number;
    charsPerLine: number;
  }
): string[][] {
  if (firstCount <= 0) return [[...bullets]];
  const pages: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  let curLines = 0;
  let cap = firstCount;
  let charCap = firstCount * itemCharBudget;
  let lineCap = lines?.first ?? Number.POSITIVE_INFINITY;
  const flush = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    curChars = 0;
    curLines = 0;
    cap = contCount;
    charCap = contCount * itemCharBudget;
    lineCap = lines?.cont ?? Number.POSITIVE_INFINITY;
  };
  for (const b of bullets) {
    const size = b.length;
    // Высота — то, по чему ёмкость меряет рендерер. Счёт блоков и знаков
    // остаётся: он ловит свои случаи, а строки — те, где блоки разного роста.
    const blockLines = lines ? estimateRenderedLines(b, lines.charsPerLine) : 0;
    const overflows =
      cur.length >= cap || curChars + size > charCap || curLines + blockLines > lineCap;
    if (cur.length > 0 && overflows) flush();
    cur.push(b);
    curChars += size;
    curLines += blockLines;
  }
  if (cur.length) pages.push(cur);

  // Последний лист не остаётся с одиноким блоком: девять блоков при ёмкости
  // 2 + 3 давали 2 | 3, 3, 1, и последняя страница уходила почти пустой (на
  // финальном прогоне — один блок в 115 знаков на весь лист). Правило общее с
  // пагинатором резюме — второго такого заводить не будем.
  balanceTailPage(pages, (b) => b.length, contCount * itemCharBudget);
  return pages.length ? pages : [[]];
}

/**
 * Chunk oversized bullets/table rows into adjacent continuation slides.
 * PDF-31 B.1b: an over-budget narrative flows to continuation slides as
 * complete-sentence paragraphs instead of being clamped — the full meaning
 * stays in the report, each slide's narrative stays within its budget.
 */
export function withContinuations(
  base: SlideContentContract,
  templateId: DeckTemplateId,
  opts?: {
    /**
     * Ёмкость первой страницы, когда обвязки на ней больше, чем у шаблона по
     * умолчанию. Один шаблон обслуживает страницы с разной обвязкой: у обзора
     * профиля шесть KPI-плиток, нарратив и карточка «Действие», а у
     * регионального резюме — три плитки.
     */
    firstPageBullets?: number;
  }
): SlideContentContract[] {
  const tpl = DECK_TEMPLATE_REGISTRY[templateId];
  const slides: SlideContentContract[] = [];
  const bullets = base.content.bullets ?? [];
  const rows = base.content.table?.rows ?? [];
  const narrativeBudget = getClientTextFieldBudgets().narrative;
  const narrative = base.content.narrative ?? "";

  const firstBulletCap = opts?.firstPageBullets ?? tpl.maxBulletsPerSlide;
  const contBulletCap = tpl.maxBulletsPerContinuation ?? tpl.maxBulletsPerSlide;
  const lineModel =
    tpl.maxBulletLinesPerSlide && tpl.layout.charsPerRenderedLine
      ? {
          first: tpl.maxBulletLinesPerSlide,
          cont: tpl.maxBulletLinesPerContinuation ?? tpl.maxBulletLinesPerSlide,
          charsPerLine: tpl.layout.charsPerRenderedLine,
        }
      : undefined;
  // Разбивать приходится и тогда, когда блоков не больше предела: два блока
  // при пределе два всё равно не влезли по высоте и один был выброшен
  // (страницы 11 и 29 эталона). Условие «блоков больше предела» этот случай
  // пропускало, потому что смотрело на количество.
  const needsPaging =
    firstBulletCap > 0 &&
    (bullets.length > firstBulletCap ||
      (lineModel !== undefined &&
        bullets.reduce((n, b) => n + estimateRenderedLines(b, lineModel.charsPerLine), 0) >
          lineModel.first));
  const bulletChunks = needsPaging
    ? packBulletPages(bullets, firstBulletCap, contBulletCap, tpl.layout.itemCharBudget, lineModel)
    : [bullets];
  const rowChunks =
    tpl.maxTableRowsPerSlide > 0 && rows.length > tpl.maxTableRowsPerSlide
      ? chunk(rows, tpl.maxTableRowsPerSlide)
      : [rows];
  const narrativeChunks =
    narrative.length > narrativeBudget
      ? splitClientParagraphs(narrative, narrativeBudget, 4)
      : [narrative || undefined];
  const total = Math.max(bulletChunks.length, rowChunks.length, narrativeChunks.length);

  for (let i = 0; i < total; i += 1) {
    const content: SlideBody = {
      ...base.content,
      bullets: bulletChunks[i] ?? [],
      table: base.content.table
        ? { headers: base.content.table.headers, rows: rowChunks[i] ?? [] }
        : undefined,
    };
    if (i === 0) {
      slides.push({ ...base, content: { ...content, narrative: narrativeChunks[0] || undefined } });
    } else {
      slides.push({
        ...base,
        slideId: `${base.slideId}__cont${i}`,
        isContinuation: true,
        continuationOf: base.slideId,
        continuationIndex: i,
        title: `${base.title} (продолжение ${i + 1}/${total})`,
        content: {
          ...content,
          narrative: narrativeChunks[i] || undefined,
          whatWasFound: undefined,
          whyItMatters: undefined,
          // Заголовочные числа блока принадлежат его первой странице. Повторяясь
          // на каждом продолжении, они занимали треть листа и не сообщали ничего
          // нового: «312 / 5 / 6 / 31» пять страниц подряд (шаг 13, D4).
          kpis: undefined,
          // Рекомендация тоже одна на блок — на продолжении она вырождалась
          // в обрубок «Проверить» (шаг 13, D3).
          whatToCheck: undefined,
        },
      });
    }
  }
  return slides;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Distribute items across N slots as evenly-sized contiguous chunks. */
export function distribute<T>(items: T[], slots: number): T[][] {
  const out: T[][] = Array.from({ length: slots }, () => []);
  items.forEach((item, i) => out[Math.min(Math.floor((i * slots) / Math.max(items.length, 1)), slots - 1)].push(item));
  return out;
}

export function domainOfUrl(url: string | undefined): string {
  if (!url || !/^https?:\/\//iu.test(url)) return "—";
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "—";
  }
}

/**
 * Compose client text from whole sentences of the given parts, appending
 * sentences while they fit the budget — never a mid-sentence cut.
 */
export function fitClientSentences(parts: string[], max: number): string {
  const sentences = parts
    .flatMap((p) => p.split(/(?<=[.!?…])\s+/u))
    .map((s) => s.trim())
    .filter(Boolean);
  let out = "";
  for (const s of sentences) {
    const trial = out ? `${out} ${s}` : s;
    if (trial.length > max) break;
    out = trial;
  }
  if (!out && sentences[0]) return clampClientText(sentences[0], max);
  return /[.!?…]$/u.test(out) ? out : `${out}.`;
}

/**
 * Split client text into complete-sentence paragraphs of at most `maxPerPara`
 * characters (for renderer layouts that draw one card per paragraph).
 */
export function splitClientParagraphs(text: string, maxPerPara: number, maxParas: number): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter(Boolean);
  const paras: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const trial = buf ? `${buf} ${s}` : s;
    if (trial.length > maxPerPara && buf) {
      paras.push(buf);
      if (paras.length >= maxParas) return paras;
      buf = s.length > maxPerPara ? clampClientText(s, maxPerPara) : s;
    } else {
      buf = trial.length > maxPerPara ? clampClientText(trial, maxPerPara) : trial;
    }
  }
  if (buf && paras.length < maxParas) paras.push(buf);
  return paras;
}

/**
 * Trailing conjunctions/prepositions left dangling after a word-boundary cut
 * («…владению и.», «требуют ещё.») — stripped before the final period.
 */
const DANGLING_TAIL_RE =
  /(?:\s+(?:и|а|но|или|же|то|что|как|при|про|для|без|под|над|из|из-за|от|до|по|к|ко|в|во|на|с|со|о|об|обо|у|за|ещё|еще|также|а также|более|менее|чем))+$/iu;

/**
 * Clamp client text to its budget — last-resort safety net (PDF-31 B.1c).
 * Prefers a sentence/list boundary even when it is early in the budget
 * (a shorter complete phrase beats a longer broken one); the word-boundary
 * fallback is used only when the slice has no boundary at all, and dangling
 * conjunctions/prepositions are stripped so the text never ends in «…и.».
 */
/**
 * Ссылка в человекочитаемом виде.
 *
 * Провайдеры собирают адреса через `encodeURIComponent`, и в клиентском отчёте
 * это выглядело так: «статья найдена —
 * https://ru.wikipedia.org/wiki/%D0%94%D1%83%D1%80%D0%BE%D0%B2». Читателю
 * такая строка не говорит ничего, а документ, за который платят, обесценивает
 * сразу. Машине проценты нужны, человеку — нет; отчёт пишется человеку.
 *
 * Если раскодировать не удалось (битая последовательность), остаётся исходная
 * строка: показать ссылку как есть честнее, чем не показать вовсе.
 */
export function clientReadableUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

export function clampClientText(text: string, max: number): string {
  if (text.length <= max) return text;
  // Цитата укорачивается внутри кавычек, с сохранением источника: обычная
  // обрезка по пробелу уносила закрывающую ёлочку вместе с «— источник …», и
  // утверждение оставалось без происхождения.
  const asQuote = clampQuotedLine(text, max);
  if (asQuote !== undefined) return asQuote;
  const slice = text.slice(0, max);
  const boundaries = [slice.lastIndexOf(". "), slice.lastIndexOf(" · "), slice.lastIndexOf("; ")];
  const cut = Math.max(...boundaries);
  const atSentenceBoundary = cut > 0;
  let out = atSentenceBoundary ? slice.slice(0, cut) : slice.slice(0, slice.lastIndexOf(" "));
  out = out.replace(/[\s·;,.]+$/u, "");
  out = out.replace(DANGLING_TAIL_RE, "").replace(/[\s·;,.]+$/u, "");
  if (!out) return "";
  // Кавычка, открытая до места реза, закрывается многоточием: висящая ёлочка
  // читается как наше утверждение, а не как сокращённая цитата.
  out = closeDanglingQuote(out);
  // Точка ставится только там, где резали по границе предложения. Прежде она
  // дописывалась всегда, и обрубок выдавался за законченную мысль: в отчёт
  // попадали «Для банка или партнёра такие.», «Деловой фон.», «Всего.»
  // (шаг 13, C7). Оборванная фраза должна выглядеть оборванной.
  return atSentenceBoundary ? `${out}.` : out;
}

/**
 * PDF-46 I.4 — fit a multi-line theme bullet by dropping whole structural lines
 * (why → 2nd quote → where → scale). Never flatten+mid-cut «контекстом — 10».
 */
export function fitStructuredBullet(text: string, maxChars: number): string {
  const reflowed = reflowThemeBullet(String(text ?? ""));
  const markerMatch = reflowed.match(/(\s*\[finding-[^\]]+\])\s*$/u);
  const marker = markerMatch?.[1] ?? "";
  const raw = reflowed.replace(/\s*\[finding-[^\]]+\]\s*$/u, "").trim();
  if (!raw) return marker.trim();

  const incompleteMetaRe =
    /^(Что делать|Всего по теме|В корпусе|Где видно)\s*:\s*\.?$/iu;
  const danglingCountRe = /,\s*с негативным контекстом\s+[—–-]\s*\.?$/u;
  // PDF-49 — dangling token must be preceded by « or whitespace. Bare `и»`
  // inside genitive «…Фамилии» was a false positive that deleted an evidence quote.
  const danglingQuoteRe =
    /^«.*(?:«|\s)(?:из-за|и|в|во|на|по|с|со|о|об|and|or|of|the|to|for|with|from|by|over)\s*»/iu;
  const incompleteQuoteRe = /^«.*[,;:]\s*»/u;

  const isQuoteLine = (l: string) => /^«/u.test(l) && /источник/iu.test(l);
  let lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !incompleteMetaRe.test(l) && !danglingCountRe.test(l))
    .filter((l) => !danglingQuoteRe.test(l) && !incompleteQuoteRe.test(l));
  // Пересказ живёт при своей цитате: строка «О чём: …» без цитаты выше
  // объясняет неизвестно что. Проверка стоит до подгонки по бюджету — сирота
  // не должна доживать до отчёта и в тех блоках, что и так помещаются.
  lines = lines.filter((l, i) => !/^О чём:/u.test(l) || isQuoteLine(lines[i - 1] ?? ""));

  const lenOf = (ls: string[]) => ls.join("\n").length;
  if (lenOf(lines) <= maxChars) {
    const body = lines.join("\n");
    return marker ? `${body}${marker}` : body;
  }

  const isWhy = (l: string) =>
    /^(Для банка|Банки |Это усиливает|Риск в том|Деловой фон|Что делать:)/u.test(l);
  const isWhere = (l: string) => /^Где видно:/u.test(l);
  const isScale = (l: string) => /^(Всего по теме:|В корпусе:)/u.test(l);
  const isQuote = isQuoteLine;
  const isGist = (l: string) => /^О чём:/u.test(l);
  const dropGistAfter = (list: string[], idx: number): void => {
    if (isGist(list[idx] ?? "")) list.splice(idx, 1);
  };

  // PDF-49 — evidence quotes are last to drop (why/where/scale go first).
  // Previously the 2nd quote was sacrificed before meta, so ФБК/currenttime vanished.
  const droppers: Array<(l: string, all: string[]) => boolean> = [
    (l) => isWhy(l),
    (l) => isWhere(l),
    (l) => isScale(l),
    (l, all) => isQuote(l) && all.filter(isQuote).indexOf(l) >= 1,
  ];
  let kept = [...lines];
  for (const pred of droppers) {
    while (lenOf(kept) > maxChars) {
      const idx = kept.findIndex((l) => pred(l, kept));
      if (idx < 0) break;
      const wasQuote = isQuote(kept[idx] ?? "");
      kept.splice(idx, 1);
      if (wasQuote) dropGistAfter(kept, idx);
    }
  }
  while (lenOf(kept) > maxChars && kept.length > 2) kept.pop();
  // Ещё раз после подгонки: цитату мог унести общий сброс хвоста.
  kept = kept.filter((l, i) => !isGist(l) || isQuote(kept[i - 1] ?? ""));
  if (lenOf(kept) > maxChars) {
    const first = kept[0] ?? "";
    kept = first.length <= maxChars ? [first] : [clampClientText(first, maxChars)];
  }
  const body = kept.join("\n");
  return marker ? `${body}${marker}` : body;
}

/** Clamp body so `body + [findingId]` stays within the slide bullet budget. */
export function bulletWithFindingId(body: string, findingId: string, budget = 900): string {
  const marker = ` [${findingId}]`;
  const room = Math.max(48, budget - marker.length);
  const fitted = fitStructuredBullet(body, room).replace(/\s*\[finding-[^\]]+\]\s*$/u, "").trim();
  return `${fitted}${marker}`;
}

/**
 * Region-level finding blocks — used ONLY by summary-level slides whose page
 * content IS the regional dataset (regional summary, full SERP table).
 * Visual/per-page fragments must use `pageFindingBlocks` instead.
 */
export function findingBlocks(
  scoped: ScopedFragmentInput,
  extraCheck?: string,
  extras?: FragmentExtras
): Partial<SlideBody> {
  const adverse = scoped.findings.filter(isAdverse);
  const top = [...scoped.findings].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  )[0];
  return {
    whatWasFound: clampClientText(
      top ? top.claim : "Существенных материалов по данной поверхности не обнаружено.",
      400
    ),
    whyItMatters: clampClientText(
      adverse.length
        ? `Обнаружено сигналов повышенного внимания: ${adverse.length}. Они влияют на восприятие субъекта при первичной проверке.`
        : "Поверхность не формирует негативного фона вокруг субъекта.",
      320
    ),
    whatToCheck: clampClientText(
      top?.recommendedAction ?? extraCheck ?? "Мониторить изменения выдачи.",
      220
    ),
    statusNote: statusLine(top),
    sourceNote: sourceLine(scoped, extras),
  };
}

/**
 * Confidence/status line: confirmed theme vs preliminary signal + level.
 * PDF-36 D.4 — human phrasing instead of the telegraph string
 * «Статус: …; уровень: …; уверенность 90%.» repeated verbatim across pages.
 */
/**
 * Строка оценки внизу страницы поверхности.
 *
 * Слово «Статус:» ушло: это язык нашей приёмки, а не отчёта. Эталон отрасли
 * (`docs/etalon-orion-razbor.md`) не пишет клиенту служебных префиксов вовсе —
 * там внизу страницы стоит объяснение, зачем поверхность важна. Смысл строки
 * не меняется: она называет уровень внимания и надёжность оценки.
 */
export function statusLine(top: Finding | undefined): string {
  if (!top) return "Тем риска по этой поверхности не выявлено.";
  const kind =
    top.confidence >= 0.7 ? "тема подтверждена" : "сигнал предварительный";
  const conf =
    top.confidence >= 0.85
      ? "достоверность оценки высокая"
      : top.confidence >= 0.6
        ? "достоверность оценки уверенная"
        : "оценка требует подтверждения";
  const head = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${head}, уровень внимания — ${riskLabel(top.riskLevel).toLowerCase()}; ${conf}.`;
}

export function normalizeEvidenceUrl(url: string | undefined): string {
  return (url ?? "")
    .replace(/^https?:\/\/(www\.)?/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/**
 * Page-scoped evidence view: which of this fragment's findings are actually
 * supported by the evidence displayed on ONE page (refs/URLs of the shown
 * rows/cards), and which domains that support comes from. This is the ONLY
 * source for dynamic sidebar copy on visual pages — no fallback to region- or
 * bundle-level findings/domains.
 */
export type PageEvidenceView = {
  refs: string[];
  /** Domains derivable from the page's own evidence refs. */
  domains: string[];
  /** Fragment findings supported by the page's evidence. */
  findings: Finding[];
  /** findingId → domains of its on-page supporting evidence. */
  supportDomains: Map<string, string[]>;
};

export function buildPageEvidenceView(scoped: ScopedFragmentInput, pageRefs: string[]): PageEvidenceView {
  const entries = pageRefs.map((ref) => ({ ref, e: scoped.evidenceIndex[ref] }));
  const domainByNormRef = new Map<string, string>();
  const urlToDomain = new Map<string, string>();
  const domains = new Set<string>();
  for (const { ref, e } of entries) {
    const domain = e?.domain && e.domain !== "—" ? e.domain : undefined;
    if (domain) {
      domains.add(domain);
      domainByNormRef.set(normalizeEvidenceRef(ref), domain);
      const u = normalizeEvidenceUrl(e?.url);
      if (u) urlToDomain.set(u, domain);
    } else {
      domainByNormRef.set(normalizeEvidenceRef(ref), "");
    }
  }
  const findings: Finding[] = [];
  const supportDomains = new Map<string, string[]>();
  for (const f of scoped.findings) {
    const support = new Set<string>();
    let hit = false;
    for (const r of f.evidenceRefs) {
      const norm = normalizeEvidenceRef(r);
      const e = scoped.evidenceIndex[r];
      if (domainByNormRef.has(norm)) {
        hit = true;
        // Page entry may lack a resolvable domain (opaque asset ref); the
        // finding's own evidence entry names the same source then.
        const d = domainByNormRef.get(norm) || (e?.domain && e.domain !== "—" ? e.domain : "");
        if (d) support.add(d);
        continue;
      }
      const u = normalizeEvidenceUrl(e?.url);
      if (u && urlToDomain.has(u)) {
        hit = true;
        support.add(urlToDomain.get(u)!);
      }
    }
    if (hit) {
      findings.push(f);
      supportDomains.set(f.findingId, [...support]);
      // Support domains name the same on-page rows (resolved through the
      // finding's evidence entry when the page ref itself is opaque).
      for (const d of support) domains.add(d);
    }
  }
  findings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  return { refs: pageRefs, domains: [...domains], findings, supportDomains };
}

/**
 * Поверхности без заголовка публикации — их нечего цитировать.
 *
 * Словарь поверхностей композитных наблюдений (`kind`), а не типов инвентаря:
 * здесь региональная сборка работает с `evidenceIndex`.
 */
const NON_QUOTABLE_SURFACES = new Set([
  "ai_answer",
  "autocomplete",
  "suggestion",
  "related",
  "paa",
  /*
   * Проверка Википедии — наш результат, а не публикация.
   *
   * У записи без статьи заголовок собирается нами: «Wikipedia (en): статья не
   * найдена». В отчёте 73 эта строка стояла в кавычках доказательством темы
   * «Деловой профиль» — то есть отсутствие статьи было предъявлено как
   * найденный материал.
   */
  "wikipedia",
  "wikipedia_check",
]);

/**
 * Page-specific conclusion for one finding: theme + risk + the on-page
 * source domains. Deliberately NOT the finding's global claim text — the
 * claim may cite evidence from other pages/regions.
 */
export function pageScopedConclusion(f: Finding, view: PageEvidenceView): string {
  // Демо-домены вычищались только из строк источников, а сюда протекали.
  const where = clientSafeDomains(view.supportDomains.get(f.findingId) ?? []).slice(0, 3);
  // Было: «тема»: уровень внимания — критический — материалы на этой странице:
  // a, b. Цепочка «двоеточие — тире — двоеточие» читается как строка таблицы,
  // а не как предложение. Теперь это два коротких предложения.
  const level = `«${f.theme}» — ${riskLabel(f.riskLevel).toLowerCase()} уровень внимания.`;
  const src = where.length ? ` Материалы по теме на этой странице — ${enumerateRu(where)}.` : "";
  return clampClientText(`${level}${src}`, 400);
}

/** REMEDIATION §7.1 — row-level composition of one page (evidence-first). */
export type PageRowComposition = {
  shown: number;
  subjectMatch: number;
  likelySubject: number;
  adverseHeadlines: number;
  topDomains: string[];
};

/**
 * Count identity / adverse / domains from the page's own evidence refs.
 * Used when page-supported findings are empty but the table/list is not.
 */
export function composePageRowComposition(
  scoped: ScopedFragmentInput,
  pageRefs: string[]
): PageRowComposition {
  const adverseRefSet = new Set<string>();
  for (const f of scoped.findings.filter(isAdverse)) {
    for (const r of f.evidenceRefs) adverseRefSet.add(r);
  }
  let subjectMatch = 0;
  let likelySubject = 0;
  let adverseHeadlines = 0;
  const domainCounts = new Map<string, number>();
  for (const ref of pageRefs) {
    const e = scoped.evidenceIndex[ref] ?? {};
    if (e.subjectDecision === "SUBJECT_MATCH") subjectMatch += 1;
    else if (e.subjectDecision === "LIKELY_SUBJECT") likelySubject += 1;
    const adverse =
      e.adverse === true ||
      adverseRefSet.has(ref) ||
      ADVERSE_PATTERNS.test(String(e.title ?? ""));
    if (adverse) adverseHeadlines += 1;
    const domain =
      e.domain && e.domain !== "—" ? e.domain : domainOfUrl(e.url);
    if (domain && domain !== "—") {
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }
  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, 4)
    .map(([d]) => d);
  return {
    shown: pageRefs.length,
    subjectMatch,
    likelySubject,
    adverseHeadlines,
    topDomains,
  };
}

/** Descriptive sidebar from page rows when no finding is page-supported (§7.1). */
export function pageRowCompositionBlocks(
  composition: PageRowComposition,
  view: PageEvidenceView,
  extraCheck?: string
): Partial<SlideBody> {
  const resultWord = pluralRu(
    composition.shown,
    "результат",
    "результата",
    "результатов"
  );
  // Решение «писать перечисление» принимается по тому, что напечатается, а не
  // по списку до отбора. `clientSafeDomains` убирает «—» и демо-домены, и в
  // деке report-72 на двух страницах оставалось «преобладающие источники: .» —
  // двоеточие, за которым нет ни одного названия. Условие смотрело на
  // `topDomains`, печатался результат отбора: проверялось одно, печаталось
  // другое.
  const domainsList = enumerateRu(clientSafeDomains(composition.topDomains));
  const domainsNote = domainsList ? `; преобладающие источники: ${domainsList}` : "";
  return {
    whatWasFound: clampClientText(
      `Показано ${composition.shown} ${resultWord}; из них о субъекте — ${composition.subjectMatch}, вероятно о субъекте — ${composition.likelySubject}, негативных заголовков — ${composition.adverseHeadlines}${domainsNote}.`,
      400
    ),
    whyItMatters: clampClientText(
      composition.adverseHeadlines > 0
        ? `На странице есть негативные заголовки (${composition.adverseHeadlines}) — они влияют на первое впечатление при проверке, даже если тема ещё не выделена отдельным выводом.`
        : composition.likelySubject > 0
          ? `Часть строк отмечена как «Вероятно» о субъекте — их нельзя игнорировать, но и нельзя включать в подтверждённые выводы без уточнения принадлежности.`
          : "На странице есть результаты выдачи; отдельной подтверждённой темы повышенного внимания среди показанных строк не выделено.",
      320
    ),
    whatToCheck: clampClientText(
      extraCheck ??
        (composition.subjectMatch > 0 || composition.likelySubject > 0
          ? "Сверить заголовки и домены с профилем субъекта; уточнить принадлежность строк со статусом «Вероятно»."
          : "Мониторить изменения выдачи."),
      220
    ),
    // Клиенту говорим о странице, а не о том, что с ней сделала наша сборка.
    // «Состав страницы описан по строкам таблицы; отдельного тематического
    // вывода нет» — фраза из приёмки: она сообщает читателю ровно ноль.
    statusNote:
      composition.adverseHeadlines > 0
        ? `На этой странице ${composition.adverseHeadlines} ${pluralRu(
            composition.adverseHeadlines,
            "негативный заголовок",
            "негативных заголовка",
            "негативных заголовков"
          )} — их видно до перехода к самим материалам, поэтому они формируют первое впечатление.`
        : "Негативных заголовков на этой странице нет.",
    sourceNote: pageSourceLine(view),
  };
}

/**
 * Finding blocks strictly scoped to ONE page's displayed evidence.
 * Dynamic conclusion, significance, status and the source footer are derived
 * only from the page's own refs/domains; static methodology stays in the
 * template layer.
 *
 * REMEDIATION §7.1: when findings are empty but the page has rows/refs,
 * describe the page composition instead of the empty-state boilerplate.
 */
export function pageFindingBlocks(
  scoped: ScopedFragmentInput,
  view: PageEvidenceView,
  extraCheck?: string
): Partial<SlideBody> {
  const adverse = view.findings.filter(isAdverse);
  const top = view.findings[0];
  if (top) {
    return {
      whatWasFound: pageScopedConclusion(top, view),
      whyItMatters: clampClientText(
        adverse.length
          ? // Было: «затрагивают тем повышенного внимания: 3» — падеж не
            // согласован с числом, и счётчик подан как причина. Теперь число
            // склоняется, а причина названа словами.
            `На странице ${adverse.length} ${pluralRu(adverse.length, "тема", "темы", "тем")} ` +
              "повышенного внимания — эти материалы видны при первой же проверке субъекта."
          : "Показанные на странице материалы не формируют негативного фона вокруг субъекта.",
        320
      ),
      whatToCheck: clampClientText(
        top.recommendedAction ?? extraCheck ?? "Мониторить изменения выдачи.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote: pageSourceLine(view),
    };
  }
  if (view.refs.length > 0) {
    return pageRowCompositionBlocks(
      composePageRowComposition(scoped, view.refs),
      view,
      extraCheck
    );
  }
  return {
    whatWasFound:
      "Существенных материалов среди показанных на этой странице элементов не обнаружено.",
    whyItMatters: clampClientText(
      "Показанные на странице материалы не формируют негативного фона вокруг субъекта.",
      320
    ),
    whatToCheck: clampClientText(
      extraCheck ?? "Мониторить изменения выдачи.",
      220
    ),
    statusNote: statusLine(undefined),
    sourceNote: pageSourceLine(view),
  };
}

/**
 * Перечисление по-русски: «a», «a и b», «a, b и c», «a, b и ещё 4».
 *
 * Домены склеивались через запятую, и строка читалась как выгрузка списка.
 * Союз перед последним элементом стоит копейки, а текст перестаёт выглядеть
 * машинным — это ровно та мелочь, из которых складывается ощущение бланка.
 */
export function enumerateRu(items: string[], max = 3): string {
  const list = items.filter((x) => Boolean(x && x.trim()));
  if (list.length === 0) return "";
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} и ещё ${rest}`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} и ${shown[shown.length - 1]!}`;
}

/**
 * Строка происхождения — одна формулировка на весь отчёт.
 *
 * Их было две, слово в слово одинаковых, в разных местах этого же файла. Пока
 * ответов на один вопрос несколько, они расходятся: правка одной оставляла
 * соседние страницы говорить об источниках по-старому.
 */
export function sourcesSentence(domains: string[], max = 4): string {
  const list = clientSafeDomains(domains);
  return list.length
    ? `Источники — ${enumerateRu(list, max)}.`
    : "Источники — поисковая выдача; полный перечень в приложении.";
}

/** Source footer derived ONLY from the page's own evidence refs. */
export function pageSourceLine(view: PageEvidenceView): string {
  return sourcesSentence(view.domains.slice(0, 5));
}

/** «Тема» — claim; skip the prefix when the claim already names the theme. */
/**
 * PDF-43 — GPT stage2 often flattens G.2b bullets into one paragraph
 * («тема» Найдены…: «q1» — источник a «q2» — источник b Всего…).
 * Restore scan lines so the renderer can bold the theme and break quotes.
 */
/**
 * Служебные врезки, каждая из которых читается как отдельный абзац.
 *
 * Шаг 13, C6 — «Где видно: …» и «Для банка …» приклеивались к цитате
 * источника и превращали строку доказательства в нечитаемую ленту.
 */
const STRUCTURED_TAIL_RE =
  /(?=(?:Всего по теме:|В корпусе:|Где видно:|Что делать:|О чём:|Принадлежность:|Для банка|Банки |Это усиливает|Риск в том|Деловой фон))/u;

/** Разбить строку по служебным врезкам, сохранив порядок. */
function splitStructuredTail(line: string): string[] {
  return line
    .split(STRUCTURED_TAIL_RE)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Строки тела без вынесенного заголовка темы.
 *
 * Заголовок мог занимать отдельную строку или стоять в начале первой строки —
 * в обоих случаях повторять его в теле нельзя.
 */
function withoutLeadingTheme(lines: string[], theme: string): string[] {
  if (!theme) return lines;
  const first = (lines[0] ?? "").trim();
  if (first === theme) return lines.slice(1);
  if (first.startsWith(theme)) {
    return [first.slice(theme.length).trim(), ...lines.slice(1)].filter(Boolean);
  }
  return lines;
}

export function reflowThemeBullet(text: string): string {
  const original = String(text ?? "").replace(/\r\n/gu, "\n");
  const markerMatch = original.match(/(\s*\[finding-[^\]]+\])\s*$/u);
  const marker = markerMatch?.[1] ?? "";
  const raw = original.replace(/\s*\[finding-[^\]]+\]\s*$/u, "").trim();
  if (!raw) return original.trim();

  const existing = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop empty GPT stubs that render as «Что делать:.»
    .filter((l) => !/^(Что делать|Всего по теме|В корпусе)\s*:\s*\.?$/iu.test(l));
  const quoteRe = /«[^»]{8,}»\s*—\s*источник\s+[A-Za-z0-9][A-Za-z0-9.-]*/gu;
  const lineNeedsReflow = (l: string): boolean => {
    const n = (l.match(quoteRe) ?? []).length;
    if (n > 1) return true;
    if (n === 1 && /(?:Всего по теме:|В корпусе:|Для банка|Банки |Риск в том|Что делать:)/u.test(l)) {
      return true;
    }
    return /^«[^»]{2,80}»\s+(?:Найдены|Есть публикации|В открытой)/u.test(l);
  };
  // `\b` в JavaScript определён на ASCII и после кириллического «источник»
  // границы не находит вовсе: строка-цитата не опознавалась, уже размеченный
  // блок каждый раз пересобирался заново — и всё, что стояло между цитатами,
  // при пересборке терялось.
  const quoteLines = existing.filter((l) => /^«[^»]{8,}»\s*—\s*источник(?!\p{L})/u.test(l));
  if (
    quoteLines.length >= 1 &&
    existing.length >= 3 &&
    !existing.some(lineNeedsReflow)
  ) {
    return marker ? `${existing.join("\n")}${marker}` : existing.join("\n");
  }

  const flat = existing.join(" ").replace(/\s+/gu, " ").trim();
  let theme = "";
  let rest = flat;
  const themeM = flat.match(/^(«([^»]{2,80})»)\s+(.*)$/u);
  if (
    themeM &&
    !/источник/iu.test(themeM[1]) &&
    /^(Найдены|Есть публикации|В открытой)/u.test(themeM[3] ?? "")
  ) {
    theme = themeM[1];
    rest = themeM[3] ?? "";
  }

  const quotes = [...rest.matchAll(quoteRe)].map((m) => m[0].trim());
  const out: string[] = [];
  if (theme) out.push(theme);

  if (quotes.length > 0) {
    const firstIdx = rest.search(quoteRe);
    let framing = firstIdx >= 0 ? rest.slice(0, firstIdx).trim() : rest;
    if (framing && /Найдены|публик|материал/iu.test(framing) && !/:\s*$/u.test(framing)) {
      framing = `${framing.replace(/[.:]\s*$/u, "")}:`;
    }
    if (framing) out.push(framing);
    // Цитата идёт вместе со своим пересказом: строка «О чём: …» объясняет
    // именно её, и, оторванная от цитаты, объясняет неизвестно что. Прежде всё,
    // что стояло между цитатами, при пересборке пропадало.
    const matches = [...rest.matchAll(quoteRe)];
    let lastEnd = 0;
    matches.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      out.push(m[0].trim());
      const nextStart = i + 1 < matches.length ? matches[i + 1]!.index ?? rest.length : rest.length;
      const between = rest.slice(end, nextStart).trim();
      if (/^О чём:/u.test(between)) {
        out.push(between);
        lastEnd = nextStart;
      } else {
        lastEnd = end;
      }
    });
    const tail = rest.slice(lastEnd).trim();
    if (tail) out.push(...splitStructuredTail(tail));
  } else {
    // Шаг 13, C6 — тема уже вынесена в `out` отдельной строкой. Исходные
    // строки несут её же, поэтому без вычитания заголовок печатался дважды
    // подряд: «Офшоры / корпоративное владение» / «Офшоры / корпоративное
    // владение» / Найдены публикации…
    const bodyLines = existing.length ? withoutLeadingTheme(existing, theme) : [rest || flat];
    out.push(...bodyLines.flatMap(splitStructuredTail));
  }

  const body = out.filter(Boolean).join("\n");
  if (!marker) return body;
  return `${body}${marker.startsWith(" ") || marker.startsWith("\n") ? marker : ` ${marker.trim()}`}`;
}

/** Split a wall-of-text narrative into 2–3 short paragraphs (PDF-43). */
export function reflowNarrativeParagraphs(text: string, maxParas = 3): string {
  const raw = String(text ?? "").replace(/\r\n/gu, "\n").trim();
  if (!raw) return raw;
  if (raw.includes("\n")) return raw.replace(/\n{3,}/gu, "\n\n").trim();
  if (raw.length < 220) return raw;
  return splitClientParagraphs(raw, Math.max(180, Math.floor(raw.length / maxParas)), maxParas).join(
    "\n"
  );
}

/**
 * PDF-38 F.1 — split a one-line theme claim into scan-friendly lines:
 * theme · stats · sources · examples. Already-structured text is kept.
 */
export function structureThemeClaimText(text: string): string {
  const raw = String(text ?? "").replace(/\r\n/gu, "\n").trim();
  if (!raw) return raw;
  if (
    raw.includes("\n") &&
    (/(?:^|\n)(?:Источники|Примеры|Где видно|В корпусе|Всего по теме|Пример)\b/u.test(raw) ||
      /(?:^|\n)«[^»]{8,}»\s*—\s*источник\b/u.test(raw))
  ) {
    return raw
      .replace(/Примеры заголовков:/gu, "Примеры:")
      .replace(/\n{2,}/gu, "\n")
      .trim();
  }
  let theme = "";
  let rest = raw;
  const guillemet = raw.match(/^«([^»]+)»\s*[—\-–:]?\s*(.*)$/us);
  if (guillemet) {
    theme = `«${guillemet[1].trim()}»`;
    rest = (guillemet[2] ?? "").trim();
  } else {
    // Only treat "Title: body" as a theme when the left side is a short
    // label — never a stats sentence that happens to contain
    // «Источники в регионе: …» (PDF-38 F.1 regression).
    const colon = raw.match(/^([^:\n]{3,80}):\s+(.*)$/us);
    const left = colon?.[1]?.trim() ?? "";
    if (
      colon &&
      left &&
      !/^(Источники|Примеры|Что|Статус|Методология)\b/u.test(left) &&
      !/[.!?…]/.test(left) &&
      !/\d+\s+публикац/iu.test(left)
    ) {
      theme = left;
      rest = (colon[2] ?? "").trim();
    }
  }
  const corpusMatch = rest.match(
    /\s*((?:В корпусе|Всего по теме):\s*.+?)(?=\s*(?:Где видно|Источники|Пример|Примеры)|\s*$)/u
  );
  const sourcesMatch = rest.match(
    /\s*((?:Где видно|Источники(?:\s+в\s+регионе)?):\s*.+?)(?=\s*(?:Пример|Примеры)|\s*$)/u
  );
  const examplesMatch = rest.match(/\s*((?:Пример|Примеры(?:\s+заголовков)?):\s*.+)$/u);
  let stats = rest;
  if (corpusMatch) stats = stats.replace(corpusMatch[0], "").trim();
  if (sourcesMatch) stats = stats.replace(sourcesMatch[0], "").trim();
  if (examplesMatch) stats = stats.replace(examplesMatch[0], "").trim();
  stats = stats.replace(/\s+/gu, " ").replace(/[\s;,.]+$/u, "");
  if (stats && !/[.!?…]$/u.test(stats)) stats = `${stats}.`;
  const corpus = corpusMatch ? corpusMatch[1].replace(/\s+/gu, " ").trim() : "";
  const sources = sourcesMatch
    ? sourcesMatch[1].replace(/\s+/gu, " ").trim()
    : "";
  const examples = examplesMatch
    ? examplesMatch[1]
        .replace(/^Примеры заголовков:/u, "Примеры:")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
  return [theme, stats, corpus, sources, examples].filter(Boolean).join("\n");
}

/** Detail body without the leading «Theme» line (risk-matrix headline already shows it). */
export function claimBodyWithoutTheme(f: Finding): string {
  const full = themedClaim(f);
  const lines = full.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return full;
  if (
    lines[0]!.startsWith("«") ||
    lines[0]!.toLowerCase().startsWith(f.theme.toLowerCase())
  ) {
    return lines.slice(1).join("\n");
  }
  return full;
}

/**
 * PDF-38 F.1 — theme on its own line (renderer bolds it), claim body below.
 * Keeps multi-line claim structure from the synthesizer (stats / sources /
 * examples) so the PDF never collapses into one grey paragraph.
 */
export function themedClaim(f: Finding): string {
  const claim = structureThemeClaimText(String(f.claim ?? "").trim());
  if (!claim) return `«${f.theme}»`;
  const withTheme =
    claim.toLowerCase().startsWith(f.theme.toLowerCase()) || claim.startsWith("«")
      ? claim
      : `«${f.theme}»\n${claim}`;
  return reflowThemeBullet(withTheme);
}

/** Доля кириллицы, начиная с которой строка считается русской. */
const CYRILLIC_SHARE_RU = 0.4;

function cyrillicShare(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters) return 0;
  return letters.replace(/[^\p{Script=Cyrillic}]/gu, "").length / letters.length;
}

/**
 * Строка «О чём: …» под иноязычной цитатой.
 *
 * Переводить цитату нельзя: в кавычках клиенту показали бы слова, которых
 * источник не писал, и неточность перевода стала бы нашим утверждением о факте.
 * Поэтому оригинал остаётся дословным, а рядом идёт изложение — явно наше,
 * отдельной строкой и по-русски.
 *
 * Ставится только там, где без неё не обойтись:
 *
 *   - цитата не по-русски. Русскому заголовку пересказ не нужен и выглядит
 *     издевательством;
 *   - изложение само по-русски. Английская «тема» под английской цитатой не
 *     помогает никому;
 *   - изложение говорит не то же самое. Модель иногда возвращает темой сам
 *     заголовок страницы («Timur Yunusov - IMDb»), и такая строка удваивает
 *     цитату вместо того, чтобы её объяснить.
 */
export function quoteGistLine(title: string, gist: string | undefined): string | undefined {
  const text = String(gist ?? "").trim();
  if (!text) return undefined;
  if (cyrillicShare(title) >= CYRILLIC_SHARE_RU) return undefined;
  if (cyrillicShare(text) < CYRILLIC_SHARE_RU) return undefined;
  const a = normalizeForCompare(title);
  const b = normalizeForCompare(text);
  if (!b || a.includes(b) || b.includes(a)) return undefined;
  // Пересказ длиной с абзац выдавил бы саму цитату под обрезку.
  return `О чём: ${clampClientText(text, 160)}`;
}

/**
 * B.3 — regional pages must not quote foreign-region sources. Cross-regional
 * findings carry globally aggregated «Источники: …» / «Примеры заголовков: …»
 * segments inside the claim; rebuild both from evidence captured for the
 * page's own region. Single-region findings keep the original claim, and the
 * global claim stays untouched for the executive contour.
 */
export function localizedThemedClaim(f: Finding, scoped: ScopedFragmentInput): string {
  const regions = scoped.scope.regions;
  if (!regions || regions.length === 0) return themedClaim(f);
  const frs = f.regions ?? [];
  const exclusive =
    frs.length > 0 && frs.every((fr) => regions.some((r) => regionMatches(r, fr)));
  if (exclusive) return themedClaim(f);

  const themeDef = getFindingThemes().find(
    (t) => t.label === f.theme || f.theme.toLowerCase().includes(t.label.toLowerCase())
  );
  const adverseTheme = isAdverse(f);

  const domains: string[] = [];
  const titleCandidates: Array<{
    title: string;
    domain: string;
    score: number;
    /** О чём публикация — из решения по прочитанной странице. */
    gist?: string;
  }> = [];
  const seenDomains = new Set<string>();
  const seenTitles = new Set<string>();
  for (const ref of f.evidenceRefs) {
    const e = scoped.evidenceIndex[ref];
    if (!e) continue;
    if (e.region && !regions.some((r) => regionMatches(r, e.region))) continue;
    if (e.domain && !seenDomains.has(e.domain) && !isMockClientDomain(e.domain)) {
      seenDomains.add(e.domain);
      domains.push(e.domain);
    }
    // У ИИ-ответа, подсказки и связанного запроса заголовка публикации нет:
    // в `title` лежит служебная строка поверхности. Цитировать её как найденный
    // материал нельзя — так в отчёт попадали строки «AI overview: … (RU) #3».
    // Тот же запрет стоит в синтезаторе находок; здесь региональная сборка
    // цитирует по своему списку и правило нужно повторить.
    if (NON_QUOTABLE_SURFACES.has(String(e.kind ?? "").toLowerCase())) continue;
    // Тема повышенного внимания не цитирует материал, чью страницу прочитали и
    // признали нейтральной. Тему назначает словарь ключевых слов по заголовку,
    // и «суд» в заголовке телеинтервью тянет его в криминальный блок; решение
    // же вынесено по тексту страницы и знает, что там на самом деле.
    if (adverseTheme && (e.readVerdictTone === "neutral" || e.readVerdictTone === "supportive")) {
      continue;
    }
    /*
     * Цитируется прочитанная страница, а не строка выдачи.
     *
     * Поисковик режет заголовок по своей ширине, и в отчёт попадали обрывки:
     * «Алишер Усманов: биография предпринимателя, бизнес, личная», «…в
     * отношении него после», «lost his mansion in Germany due». Прочитанная
     * страница даёт целое предложение, и аудитор уже сверил его с текстом
     * дословно — это и лучшее доказательство, и законченная фраза.
     *
     * Если страницу прочитать не удалось, берётся заголовок — но только целый.
     * Правило отбора здесь то же, что и в синтезаторе находок
     * (`quoteForClaim`): обрезанный поисковиком заголовок не цитируется вовсе.
     * Раньше этот путь собирал цитаты сам и все защиты терял — в том числе
     * потому, что проверку «заголовок обрезан» звали уже на очищенной строке,
     * где многоточия не осталось.
     */
    const rawTitle = String(e.title ?? "");
    const fromPage = pageQuoteForClient(e.pageQuote);
    const t = fromPage || quoteForClaim(rawTitle, 220);
    if (
      !t ||
      seenTitles.has(t.toLowerCase()) ||
      /^potential\s+match$/i.test(t) ||
      (!fromPage && isWeakExampleTitle(rawTitle, { theme: themeDef }))
    ) {
      continue;
    }
    seenTitles.add(t.toLowerCase());
    /*
     * Цитата со страницы сильнее любого заголовка.
     *
     * Вес 6 против «до 10» у заголовка с попаданием в ключевые слова темы
     * означал, что заголовок обгоняет проверенное предложение. На прогоне 73
     * блоки тем напечатали 7 цитат со страниц и 18 заголовков, и заголовки
     * оказались негодные: «Leonid Mikhelson - OpenSanctions», «Л михельсон,
     * кто его жена?» — имя с ярлыком площадки вместо утверждения. При этом у
     * двадцати одной такой ссылки годная цитата со страницы была.
     *
     * Порог поднят выше потолка заголовка (2 + 8): страница выигрывает всегда,
     * а ключевые слова лишь упорядочивают страницы между собой.
     */
    let score = fromPage ? 12 : t.split(/\s+/u).length >= 6 ? 2 : 1;
    if (themeDef?.keywords.test(t)) score += 8;
    titleCandidates.push({
      title: t,
      domain: e.domain ?? domains[0] ?? "",
      score,
      ...(e.verdictTheme ? { gist: e.verdictTheme } : {}),
    });
  }
  titleCandidates.sort((a, b) => b.score - a.score);
  const titles = titleCandidates.map((c) => c.title);

  // PDF-40 G.2b / PDF-44 H — rebuild from this region's evidence only; skip weak titles.
  const regionalQuotes = pickDistinctTitles(titleCandidates, 2).flatMap((c) => {
    // Демо-домен не называется клиенту и здесь: цитата остаётся без источника.
    const domain = clientSafeDomains([c.domain, domains[0]])[0] ?? "";
    const quote = domain ? `«${c.title}» — источник ${domain}` : `«${c.title}»`;
    const gist = quoteGistLine(c.title, c.gist);
    return gist ? [quote, gist] : [quote];
  });
  const lines = String(f.claim ?? "")
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const g2bFrame = lines.find(
    (l) =>
      /^(Найдены|Есть публикации)/u.test(l) && !/«[^»]+»\s*—\s*источник/u.test(l)
  );
  const scale = lines.find((l) => /^(Всего по теме|В корпусе):/u.test(l)) ?? "";
  const why =
    lines.find((l) =>
      /^(Для банка|Банки |Это усиливает|Риск в том|Деловой фон)/u.test(l)
    ) ?? "";
  let claim: string;
  if (regionalQuotes.length > 0) {
    // Never reuse a legacy one-line stats dump as framing — it still carries
    // foreign «Источники: dzen.ru…» and defeats regional localization.
    // Domain anchors go on a short «Где видно:» line — not an inline
    // parenthetical that the renderer mid-clips into «(в.» (PDF-44 p4).
    const framing = g2bFrame ?? "Найдены публикации по теме:";
    const frame = /:\s*$/u.test(framing) ? framing : `${framing.replace(/[.:]\s*$/u, "")}:`;
    const anchors = [
      ...new Set(clientSafeDomains(titleCandidates.slice(0, 2).map((c) => c.domain))),
    ].slice(0, 2);
    const whereLine = anchors.length > 0 ? `Где видно: ${anchors.join(", ")}.` : "";
    claim = [frame, ...regionalQuotes, scale, whereLine, why].filter(Boolean).join("\n");
  } else {
    const safeDomains = clientSafeDomains(domains);
    const sourceSegment = safeDomains.length
      ? `По теме в источниках ${enumerateRu(safeDomains)}; отдельный заголовок с сутью риска в выдаче не выделен — сверить первоисточники.`
      : "По этой теме источники в данном регионе не выделены — см. другие разделы отчёта.";
    claim = String(f.claim ?? "")
      .replace(
        /(?:Где видно|Источники(?:\s+в\s+регионе)?):\s*.+?(?=\n|(?:\s*(?:Пример|Примеры))|$)/u,
        sourceSegment
      )
      .replace(/Источники:\s.*?\.(?=\s|$)/u, sourceSegment);
    // Drop weak quote lines from the global claim when rebuilding regionally.
    claim = claim
      .split("\n")
      .filter((ln) => {
        const m = ln.match(/^«([^»]+)»/u);
        if (!m) return true;
        return !isWeakExampleTitle(m[1]!, { theme: themeDef });
      })
      .join("\n");
    if (/(?:Пример|Примеры(?:\s+заголовков)?):/u.test(claim)) {
      const titlesSegment = joinTitlesWithinBudget(titles.slice(0, 1), 90);
      claim = titlesSegment
        ? claim.replace(/(?:Пример|Примеры(?:\s+заголовков)?):.*$/u, `Пример: ${titlesSegment}`)
        : claim.replace(/\n?(?:Пример|Примеры(?:\s+заголовков)?):.*$/u, "");
    }
  }
  // Prefer multi-line structure even when the stored claim was one paragraph.
  claim = structureThemeClaimText(claim);
  if (!claim) return `«${f.theme}»`;
  const withTheme =
    claim.toLowerCase().startsWith(f.theme.toLowerCase()) || claim.startsWith("«")
      ? claim
      : `«${f.theme}»\n${claim}`;
  return reflowThemeBullet(withTheme);
}

/** Region-level source line — summary pages only (page IS the region). */
export function sourceLine(scoped: ScopedFragmentInput, extras?: FragmentExtras): string {
  const domains = new Set<string>();
  const scopeRegions = scoped.scope?.regions;
  if (scopeRegions && scopeRegions.length > 0) {
    // B.3 — cross-regional findings carry globally aggregated sourceDomains;
    // a regional page must cite only evidence captured for ITS region.
    // Region-neutral evidence (compliance, wikipedia checks) stays visible.
    for (const e of Object.values(scoped.evidenceIndex)) {
      if (!e.domain) continue;
      if (e.region && !scopeRegions.some((r) => regionMatches(r, e.region))) continue;
      domains.add(e.domain);
    }
    // Findings whose regions all belong to this scope may add their own
    // sourceDomains (they cannot carry foreign-region sources).
    for (const f of scoped.findings) {
      const frs = f.regions ?? [];
      const exclusive =
        frs.length > 0 &&
        frs.every((fr) => scopeRegions.some((r) => regionMatches(r, fr)));
      if (exclusive) for (const d of f.sourceDomains ?? []) domains.add(d);
    }
  } else {
    for (const f of scoped.findings) for (const d of f.sourceDomains ?? []) domains.add(d);
    for (const e of Object.values(scoped.evidenceIndex)) if (e.domain) domains.add(e.domain);
  }
  const list = [...domains]
    .filter((d) => d && d !== "—" && !isMockClientDomain(d))
    .sort()
    .slice(0, 6);
  // Та же строка источников, что и в `pageSourceLine`: формулировка одна, иначе
  // соседние страницы отчёта начинают говорить о происхождении по-разному.
  const sources = sourcesSentence(list, 4);
  const fresh =
    extras?.materialFreshness != null
      ? freshnessFootnote(extras.materialFreshness)
      : undefined;
  // Точка ставится только там, где её нет. Склейка «в лоб» давала в отчёте
  // «…и ещё 2.. Данные собраны 28.07.2026» — две точки подряд и предложение без
  // точки в конце, на трёх страницах боевого прогона 28.07.
  if (!fresh) return sources;
  const capitalized = `${fresh.charAt(0).toUpperCase()}${fresh.slice(1)}`;
  return `${endingWithPeriod(sources)} ${endingWithPeriod(capitalized)}`;
}

/** Предложный падеж: «в Яндексе и Google» — как в резюме отчёта. */
const SCOPE_ENGINE_LABELS: Record<string, string> = {
  YANDEX: "Яндексе",
  GOOGLE: "Google",
};

/** Порядок перечисления фиксирован: формулировка не должна плавать от прогона. */
const SCOPE_ENGINE_ORDER = ["YANDEX", "GOOGLE"];

/** Как регион называется в клиентском тексте — одно место на всю деку. */
export const REGION_CLIENT_LABELS: Record<string, string> = {
  RU: "Россия",
  UAE: "ОАЭ",
  INTERNATIONAL: "международный контур",
  GLOBAL: "глобальный контур",
};

/**
 * Предмет аудита одной фразой: что именно проверялось.
 *
 * Отчёт анализирует ТОП-20 выдачи и международные базы, а собирает шире —
 * подсказки, картинки, видео, хвост выдачи. Без этой фразы страница выглядит
 * как аудит всего собранного корпуса, и любое число на ней читается не тем
 * знаменателем. Поисковики и регионы называются по факту прогона
 * (`analysisLanes`), а не заготовленной строкой: не собрали регион — не
 * обещаем его проверку.
 *
 * Возвращает `undefined`, если область анализа неизвестна (старый прогон без
 * `analysis-scope.json`): выдумывать охват нельзя.
 */
export function auditScopeLine(ms: MetricSnapshot, opts?: { withRemainder?: boolean }): string | undefined {
  const analyzed = ms.analyzedCount;
  if (typeof analyzed !== "number" || analyzed <= 0) return undefined;
  const topN = ms.analysisTopN ?? 20;
  const lanes = (ms.analysisLanes ?? []).filter((l) => l.analyzed > 0);
  const engines = [...new Set(lanes.map((l) => l.engine.toUpperCase()))]
    .sort((a, b) => SCOPE_ENGINE_ORDER.indexOf(a) - SCOPE_ENGINE_ORDER.indexOf(b))
    .map((e) => SCOPE_ENGINE_LABELS[e])
    .filter((x): x is string => Boolean(x));
  const regions = [...new Set(lanes.map((l) => REGION_CLIENT_LABELS[l.region.toUpperCase()]))].filter(
    (x): x is string => Boolean(x)
  );
  const where = engines.length > 0 ? ` в ${engines.join(" и ")}` : "";
  const geo = regions.length > 0 ? ` (${regions.join(", ")})` : "";
  const head =
    `Предмет аудита — результаты поиска ТОП-${topN}${where}${geo} и международные базы: ` +
    `${analyzed} ${pluralRu(analyzed, "материал", "материала", "материалов")}.`;
  if (!opts?.withRemainder) return head;
  return `${head} Остальное собранное показано в отчёте, но темы риска по нему не строились.`;
}

/**
 * Знаменатель доли: прочитанные страницы региона минус признанные чужими.
 *
 * Определение одно на все места счёта — и на фразу страницы региона, и на
 * строку резюме, и на машинное поле слайда, которым приёмка сверяет слова с
 * числами. Разъехавшись, они дали бы клиенту два разных «из скольких».
 */
export function readShareDenominator(counts: LinkReadRegionCounts): number {
  return counts.read - counts.readOther;
}

/**
 * Доля негатива в процентах.
 *
 * «0 %» имеет право означать только измеренный ноль: при ненулевом числителе
 * округление вниз до нуля превратило бы найденный негатив в его отсутствие,
 * поэтому нижняя граница — единица.
 */
function readSharePercent(adverseRead: number, denominator: number): number {
  if (adverseRead === 0) return 0;
  return Math.max(1, Math.round((adverseRead / denominator) * 100));
}

/**
 * Доля негатива среди прочитанных страниц региона — фразой для страницы
 * профиля региона.
 *
 * База печатается в той же фразе: «83 %» от шести прочитанных и «83 %» от
 * шестидесяти читаются одинаково, а весят по-разному. Числа — региональные:
 * глобальная строка покрытия чтения рядом с региональной долей давала бы два
 * несопоставимых числа, поэтому она остаётся на странице тем.
 *
 * Каждое состояние без доли названо своей причиной — «страниц не читали»,
 * «прочитать не удалось» и «всё прочитанное о других людях» отвечают на разные
 * вопросы читателя, и подменять их нулём нельзя.
 */
export function readShareRegionalSentence(ms: MetricSnapshot, regionKey: string): string {
  const b = ms.linkReadByRegion?.[regionKey];
  if (!b || b.requested === 0) {
    return "Доля негатива среди прочитанных страниц не приводится: страницы выдачи в этом прогоне не читались.";
  }
  if (b.read === 0) {
    return `Прочитать страницы выдачи региона не удалось (запрошено ${b.requested}, прочитано 0) — доля негатива не приводится.`;
  }
  const denominator = readShareDenominator(b);
  if (denominator <= 0) {
    return `Все прочитанные страницы региона (${b.read}) отнесены к другим лицам; доля негатива о проверяемом лице не приводится.`;
  }
  const head =
    `Негатив среди прочитанных страниц региона: ${b.adverseRead} из ${denominator} ` +
    `(${readSharePercent(b.adverseRead, denominator)}%); прочитано ${b.read} из ${b.requested} отобранных.`;
  return b.readOther > 0
    ? `${head} Страницы о других людях (${b.readOther}) в долю не входят.`
    : head;
}

/** Порядок контуров в резюме фиксирован — формулировка не плавает от прогона. */
const READ_SHARE_REGION_ORDER = ["RU", "UAE"];

/**
 * Та же доля одной строкой для резюме — по регионам, где есть что делить.
 *
 * Регион без прочитанных страниц о субъекте в строке не упоминается: честное
 * отсутствие уже сказано на его собственной странице, а повторять его в резюме
 * каждого прогона без чтения — шум. Если делить нечего нигде, строки нет вовсе.
 */
export function readShareExecutiveLine(ms: MetricSnapshot): string | undefined {
  const parts: string[] = [];
  for (const regionKey of READ_SHARE_REGION_ORDER) {
    const b = ms.linkReadByRegion?.[regionKey];
    if (!b) continue;
    const denominator = readShareDenominator(b);
    if (denominator <= 0) continue;
    parts.push(
      `${REGION_CLIENT_LABELS[regionKey] ?? regionKey} — ${readSharePercent(
        b.adverseRead,
        denominator
      )}% (${b.adverseRead} из ${denominator})`
    );
  }
  if (parts.length === 0) return undefined;
  return `Негатив среди прочитанных страниц: ${parts.join(", ")}.`;
}

/**
 * По каким запросам смотрели выдачу.
 *
 * Эталон отрасли печатает набор запросов на каждой странице поверхности —
 * и это не украшение: без него метрика «столько-то материалов в ТОП-20»
 * не имеет знаменателя, а читатель не знает, что именно спрашивали.
 *
 * Набор берётся из самих доказательств: это запросы, которыми искали субъекта
 * по имени. Прицельные запросы (деловой, медийный, негативный) сюда не входят
 * — по ним выдача не показывается как «страница, которую видит человек».
 */
export function subjectQueriesLine(
  scoped: ScopedFragmentInput,
  limit = 5
): string | undefined {
  const byQuery = new Map<string, number>();
  for (const e of Object.values(scoped.evidenceIndex)) {
    const q = String(e.query ?? "").trim();
    if (!q) continue;
    if (e.queryPurpose && e.queryPurpose !== "subject_lookup") continue;
    byQuery.set(q, (byQuery.get(q) ?? 0) + 1);
  }
  if (byQuery.size === 0) return undefined;
  const queries = [...byQuery.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, limit)
    .map(([q]) => q);
  const word = pluralRu(queries.length, "запросу", "запросам", "запросам");
  return `Выдача проверена по ${queries.length} ${word}: ${queries
    .map((q) => `«${q}»`)
    .join(", ")}.`;
}

/** Строка, законченная как предложение: без второй точки и без её отсутствия. */
function endingWithPeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?…»)]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** §7.2 — one client line about material turnover vs prior report. */
export function changeSinceLastReportLine(extras?: FragmentExtras): string | undefined {
  if (!extras?.reportDiff) return undefined;
  return reportDiffClientLine(extras.reportDiff);
}

/**
 * ORION-style client copy for surfaces with no collected material: what the
 * surface is, why it matters for the subject's reputation, and what to do.
 * Internal reason keys never leak into client text.
 */
export const COVERAGE_EMPTY_COPY: Record<
  string,
  { surface: string; measuredWhat: string; why: string; measuredCheck: string }
> = {
  "no-suggestions": {
    surface: "suggestions",
    measuredWhat:
      "Поисковые подсказки (автодополнение) по запросам о субъекте проверены: материалов нет — это результат проверки.",
    why: "Подсказки формируются поисковыми системами на основе массовых запросов пользователей; негативные формулировки в подсказках видны ещё до просмотра результатов и напрямую влияют на первое впечатление.",
    measuredCheck:
      "Рекомендуем повторить проверку подсказок при следующем обновлении: эта поверхность меняется быстрее остальных.",
  },
  "no-images": {
    surface: "images",
    measuredWhat:
      "Блок изображений по запросам о субъекте проверен: материалов нет — это результат проверки.",
    why: "Блок «Картинки» — одна из первых точек контакта: пользователь видит фотографии и связанные с ними заголовки ещё до перехода на сайты-источники.",
    measuredCheck:
      "Рекомендуем проверить блок изображений вручную и обеспечить присутствие качественных официальных фотографий.",
  },
  "no-identity-data": {
    surface: "wikipedia",
    measuredWhat:
      "Наличие статьи о субъекте в Википедии и связанных энциклопедических материалов проверено: материалов нет — это результат проверки.",
    why: "Википедия и энциклопедические карточки — ключевой источник «официальной» биографии: их содержимое поисковые системы используют в панелях знаний и ответах ИИ.",
    measuredCheck:
      "Рекомендуем проверить наличие статьи вручную; при отсутствии — рассмотреть создание нейтральной биографической статьи, при наличии — контролировать корректность её содержимого.",
  },
  "no-ai-answers": {
    surface: "ai_answers",
    measuredWhat:
      "Ответы ИИ-поиска (AI Overview, нейро-ответы) по запросам о субъекте проверены: материалов нет — это результат проверки.",
    why: "Ответы ИИ всё чаще заменяют пользователю классическую выдачу: он получает готовый вывод о человеке, не открывая источники, поэтому их содержание критично для репутации.",
    measuredCheck:
      "Рекомендуем отслеживать появление ИИ-ответов при следующих обновлениях: они формируются на основе тех же источников, что и обычная выдача.",
  },
  "no-related": {
    surface: "paa_related",
    measuredWhat:
      "Связанные запросы и вопросы «Люди также спрашивают» по субъекту проверены: материалов нет — это результат проверки.",
    why: "Связанные запросы подсказывают пользователю, что искать дальше; негативные формулировки в этом блоке расширяют охват нежелательного контента.",
    measuredCheck: "Рекомендуем повторить сбор связанных запросов при следующем обновлении.",
  },
  "no-organic-data": {
    surface: "organic",
    measuredWhat:
      "Органическая поисковая выдача по данному контуру проверена: материалов нет — это результат проверки.",
    why: "Органическая выдача — основная поверхность: первые страницы результатов формируют репутационную картину для большинства пользователей.",
    measuredCheck: "Рекомендуем проверить региональные настройки сбора и повторить проверку.",
  },
  "no-regional-findings": {
    surface: "organic",
    measuredWhat:
      "По данному региональному контуру проверка выполнена: материалы не зафиксированы — это результат проверки.",
    why: "Региональный контур показывает, как субъект представлен в локальной выдаче; отсутствие материалов — это результат проверки, а не вывод об отсутствии рисков.",
    measuredCheck: "Рекомендуем повторить сбор по региону при следующем обновлении.",
  },
  // Follow-up pages of a multi-slot block with no data: short reference back
  // instead of repeating the same full-page explanation three more times.
  "no-images-continued": {
    surface: "images",
    measuredWhat:
      "Продолжение блока изображений: дополнительных материалов по этой поверхности при проверке не зафиксировано.",
    why: "Статус и рекомендации по блоку изображений приведены на первой странице раздела.",
    measuredCheck: "См. рекомендации на первой странице блока изображений.",
  },
};

export const EMPTY_REASON_SURFACE: Record<string, string> = Object.fromEntries(
  Object.entries(COVERAGE_EMPTY_COPY).map(([reason, v]) => [reason, v.surface])
);

/**
 * Шаг 13, C11 — «Поисковые подсказки проверены: материалов нет» читалось как
 * вывод обо всех подсказках, хотя на соседней странице отчёт цитировал
 * подсказку из другой поисковой системы. Контур проверки называем в том же
 * предложении, до двоеточия, чтобы утверждение сразу было ограниченным.
 *
 * Вставка опирается на то, что каждая формулировка в COVERAGE_EMPTY_COPY
 * построена как «<что проверено>: материалов нет — …»; инвариант закреплён
 * тестом. Без двоеточия контур дописывается отдельной фразой.
 */
export function narrativeWithScope(measuredWhat: string, scopeLabel?: string): string {
  const label = String(scopeLabel ?? "").trim();
  if (!label) return measuredWhat;
  const at = measuredWhat.indexOf(":");
  if (at < 0) return `${measuredWhat} Проверенный контур — ${label}.`;
  return `${measuredWhat.slice(0, at)} (${label})${measuredWhat.slice(at)}`;
}

/** Exported for §7.4 smokes — builds client-safe empty-state copy. */
export function coverageContent(
  reason: string,
  status?: EmptySurfaceCollectionStatus,
  scopeLabel?: string
): SlideBody {
  const copy = COVERAGE_EMPTY_COPY[reason];
  const kind = status?.kind ?? "MEASURED_EMPTY";
  const reasonLabel = status?.reasonLabel;

  if (kind === "COLLECTION_FAILED") {
    const cause = (reasonLabel ?? "ошибка при сборе данных").trim();
    const narrative = /не удалось собрать/i.test(cause)
      ? `${cause.endsWith(".") ? cause : `${cause}.`} Это не результат проверки «материалов нет».`
      : `Не удалось собрать данные по этой поверхности в текущем прогоне — причина: ${cause}.`;
    return {
      narrative,
      bullets: [
        copy?.why ??
          "Без фактического сбора по поверхности нельзя сделать вывод о наличии или отсутствии материалов.",
        "Внутренние коды ошибок в отчёт не выводятся; показана только человекочитаемая причина.",
      ],
      whatToCheck: "Повторить сбор после устранения причины сбоя; до этого не интерпретировать пустую страницу как «проверено, пусто».",
    };
  }

  if (kind === "NOT_COLLECTED") {
    const cause = (reasonLabel ?? "поверхность не собиралась в этом прогоне").trim();
    // Avoid «не собиралась — причина: не собиралась» when label repeats the lead-in.
    const narrative = /не собиралась|не запускался|был пропущен/i.test(cause)
      ? `Поверхность не собиралась в этом прогоне. Это не результат проверки «материалов нет» — сбор не запускался или был пропущен.`
      : `Поверхность не собиралась в этом прогоне — причина: ${cause}.`;
    return {
      narrative,
      bullets: [
        copy?.why ??
          "Отсутствие страницы с данными означает, что проверка по поверхности не выполнялась, а не что рисков нет.",
        "Статус отражает факт сбора на дату отчёта, а не вывод об отсутствии рисков.",
      ],
      whatToCheck: copy?.measuredCheck ?? "Включить сбор по поверхности и повторить проверку.",
    };
  }

  // MEASURED_EMPTY — probed, zero materials.
  // B.4 — collection ran in this run but yielded nothing for THIS region:
  // an explicit regional wording instead of the generic «проверено, пусто».
  if (reasonLabel && /по данному региону/i.test(reasonLabel)) {
    return {
      narrative:
        "Сбор по этой поверхности в текущем прогоне выполнен; материалов по данному региону не получено — это результат проверки, а не пропуск сбора.",
      bullets: [
        copy?.why ??
          "Отсутствие материалов по региону отражает итог проверки на дату отчёта, а не вывод об отсутствии рисков.",
        "Материалы по этой поверхности из других регионов отчёта показаны в соответствующих разделах.",
      ],
      whatToCheck:
        copy?.measuredCheck ?? "Повторить проверку по региону при следующем обновлении.",
    };
  }
  if (!copy) {
    return {
      narrative: "Поверхность проверена: материалов нет — это результат проверки.",
      bullets: [
        "Отсутствие материалов отражает итог проверки на дату отчёта, а не технический пропуск сбора.",
      ],
      whatToCheck: "Повторить проверку при следующем обновлении при необходимости.",
    };
  }
  return {
    narrative: narrativeWithScope(copy.measuredWhat, scopeLabel),
    bullets: [
      copy.why,
      scopeLabel
        ? `Проверено, материалов нет — это результат проверки на дату отчёта, а не вывод об отсутствии рисков. Находки по другим поисковым системам и регионам приведены на своих страницах.`
        : "Проверено, материалов нет — это результат проверки на дату отчёта, а не вывод об отсутствии рисков.",
    ],
    whatToCheck: copy.measuredCheck,
  };
}

export function emptyStatusForReason(
  scoped: ScopedFragmentInput,
  reason: string
): EmptySurfaceCollectionStatus {
  const surface = EMPTY_REASON_SURFACE[reason] ?? "organic";
  return resolveEmptySurfaceCollection(scoped, surface);
}

export function claimText(c: SurfaceClaim): string {
  return c.subjectMatch === "OTHER_SUBJECT" ? `Относится к другому лицу: ${c.text}` : c.text;
}

export function uniqueRefs(scoped: ScopedFragmentInput): string[] {
  const s = new Set<string>();
  for (const f of scoped.findings) for (const r of f.evidenceRefs) s.add(r);
  for (const u of scoped.surfaceUnits) for (const r of u.evidenceRefs) s.add(r);
  if (!scoped.scope.regions) return [...s];
  return [...s].filter((ref) => {
    const region = scoped.evidenceIndex[ref]?.region;
    if (!region) return true;
    return scoped.scope.regions!.some((r) => regionMatches(r, region));
  });
}

export function riskLabel(level: string): string {
  const map: Record<string, string> = {
    critical: "Критический",
    high: "Высокий",
    medium: "Средний",
    low: "Низкий",
    none: "Нет",
  };
  return map[level] ?? level;
}

/** Executive verdict → client label. Raw enum (HIGH/ELEVATED/…) never leaks. */
export function verdictClientLabel(verdict: string): string {
  const map: Record<string, string> = {
    HIGH: "Высокий риск",
    ELEVATED: "Повышенный риск",
    MIXED: "Смешанный фон",
    LOW: "Низкий риск",
    INSUFFICIENT_DATA: "Недостаточно данных",
  };
  return map[String(verdict).toUpperCase()] ?? verdict;
}

/**
 * Visual slide helper: binds the slot's asset when available; otherwise emits
 * the explicit VISUAL_ASSET_UNAVAILABLE fallback text card.
 */
export function visualSlide(input: {
  slot: CanonicalSlotDef;
  sectionId: SectionType;
  extras: FragmentExtras;
  scoped: ScopedFragmentInput;
  content: SlideBody;
  evidenceRefs: string[];
  findingIds: string[];
  metrics?: Record<string, number | string>;
  /** True when the underlying surface genuinely has no data (not just no image). */
  noUnderlyingData?: boolean;
  noDataReason?: string;
  /** Контур страницы («Яндекс, Россия») — чтобы пустой статус не звучал глобально. */
  noDataScopeLabel?: string;
  /**
   * Заголовок-вывод вместо названия раздела.
   *
   * Эталон отрасли даёт читателю итог в заголовке; страница с данными обязана
   * говорить, что на ней нашли. Пустая страница заголовок не переопределяет:
   * обещать вывод там, где данных нет, нельзя.
   */
  title?: string;
}): SlideContentContract {
  const refs = assetsFor(input.extras, input.slot.slotId);
  if (refs.length > 0) {
    return makeSlotSlide({
      slot: input.slot,
      sectionId: input.sectionId,
      ...(input.title ? { title: input.title } : {}),
      content: input.content,
      evidenceRefs: input.evidenceRefs,
      findingIds: input.findingIds,
      metrics: input.metrics,
      visualAssetRefs: refs,
    });
  }
  if (input.noUnderlyingData) {
    const reason = input.noDataReason ?? "нет данных по поверхности";
    return makeSlotSlide({
      slot: input.slot,
      sectionId: input.sectionId,
      templateId: "coverage-empty-state",
      content: coverageContent(
        reason,
        emptyStatusForReason(input.scoped, reason),
        input.noDataScopeLabel
      ),
      evidenceRefs: [],
      findingIds: [],
      metrics: { datasetCount: 0 },
      emptyStateReason: input.noDataReason ?? "no-data",
    });
  }
  return makeSlotSlide({
    slot: input.slot,
    sectionId: input.sectionId,
    content: input.content,
    evidenceRefs: input.evidenceRefs,
    findingIds: input.findingIds,
    metrics: input.metrics,
    visualAssetRefs: [],
    emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
  });
}

/**
 * Match one red-framed snapshot row to the fragment finding it represents.
 * Specificity order: exact observation ref → exact URL → source domain.
 * Adverse findings win over non-adverse; ties resolve by risk level.
 */
export function findingForVisibleRow(row: VisibleAssetItem, scoped: ScopedFragmentInput): Finding | undefined {
  const rowNorm = normalizeEvidenceRef(row.ref);
  const rowUrl = normalizeEvidenceUrl(row.url);
  let best: { f: Finding; score: number } | undefined;
  for (const f of scoped.findings) {
    let specificity = 0;
    for (const r of f.evidenceRefs) {
      if (normalizeEvidenceRef(r) === rowNorm) {
        specificity = Math.max(specificity, 3);
        continue;
      }
      const e = scoped.evidenceIndex[r];
      if (rowUrl && normalizeEvidenceUrl(e?.url) === rowUrl) specificity = Math.max(specificity, 2);
    }
    if (specificity === 0 && row.domain && (f.sourceDomains ?? []).includes(row.domain)) {
      specificity = 1;
    }
    if (specificity === 0) continue;
    const score =
      specificity * 100 + (isAdverse(f) ? 50 : 0) + (RISK_ORDER[f.riskLevel] ?? 0);
    if (!best || score > best.score) best = { f, score };
  }
  return best?.f;
}

/**
 * Sidebar material for red-framed rows on a slot's bound visual asset:
 * one client-language explanation per highlighted row (theme + destination +
 * level), plus the refs the visual actually draws. Shared by the image grids
 * and the suggestion/related panels (ORION style: every red frame explained).
 */
export type PanelRow = {
  ref: string;
  /** Текст строки — ровно то, что нарисовано на панели. */
  text: string;
  adverse: boolean;
  decision?: string;
};

/**
 * Строки, нарисованные на панели-снимке.
 *
 * Клиент читает страницу так: смотрит картинку и сверяет её с описанием
 * рядом. Пока текст считал свой набор строк, а панель рисовала свой, эти два
 * числа расходились: на панели десять подсказок, в описании «показано 7»; на
 * панели две строки связанных запросов, в описании «показаны 3». Панель — то,
 * что видно, поэтому она и есть источник чисел для описания.
 */
export function panelRows(
  slotId: string,
  extras: FragmentExtras,
  scoped: ScopedFragmentInput
): PanelRow[] {
  const rows = (extras.visualAssets?.[slotId] ?? []).flatMap((a) => a.visibleItems ?? []);
  const out: PanelRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = String(row.title ?? "").trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const evidence = scoped.evidenceIndex[row.ref];
    out.push({
      ref: row.ref,
      text,
      // Негативная строка — та, что выделена красным на самой панели. Считать
      // по своим признакам нельзя: заголовок страницы берёт число у панели, и
      // «4 негативные формулировки» в заголовке спорили бы с «5» в тексте.
      adverse: row.adverse === true,
      decision: evidence?.subjectDecision,
    });
  }
  return out;
}

export type PanelComposition = {
  shown: number;
  subject: number;
  likely: number;
  other: number;
  unresolved: number;
  adverse: number;
};

export function panelComposition(rows: readonly PanelRow[]): PanelComposition {
  const count = (decision: string): number => rows.filter((r) => r.decision === decision).length;
  const subject = count("SUBJECT_MATCH");
  const likely = count("LIKELY_SUBJECT");
  const other = count("OTHER_SUBJECT");
  return {
    shown: rows.length,
    subject,
    likely,
    other,
    unresolved: rows.length - subject - likely - other,
    adverse: rows.filter((r) => r.adverse).length,
  };
}

/**
 * Состав панели словами: сколько строк показано и что это за строки.
 *
 * Разбор по принадлежности обязателен — на панели подсказок рядом с
 * субъектом стоят строки о полных тёзках, и без этого читатель считает их
 * запросами о проверяемом лице.
 */
export function panelCompositionLine(input: {
  composition: PanelComposition;
  collected: number;
  /** «подсказка» / «запрос» — в родительном падеже множественного числа. */
  nounOne: string;
  nounFew: string;
  nounMany: string;
  /** Где показаны строки: на снимке панели или просто на странице. */
  place?: string;
}): string {
  const c = input.composition;
  const noun = pluralRu(c.shown, input.nounOne, input.nounFew, input.nounMany);
  const place = input.place ?? "на панели";
  // Тире вместо глагола: «показано 1 подсказка» и «показано 2 подсказки» —
  // рассогласование, а согласовывать глагол пришлось бы по роду каждого
  // существительного, которое сюда передадут.
  const head =
    input.collected > c.shown
      ? `Собрано ${input.collected}, ${place} — ${c.shown} ${noun}`
      : `${place.charAt(0).toUpperCase()}${place.slice(1)} — ${c.shown} ${noun}`;
  const parts: string[] = [];
  if (c.subject > 0) {
    parts.push(`${c.subject} ${pluralRu(c.subject, "относится", "относятся", "относятся")} к субъекту`);
  }
  if (c.likely > 0) parts.push(`${c.likely} вероятно о субъекте`);
  if (c.other > 0) parts.push(`${c.other} — о других лицах`);
  // «Требуют уточнения» говорим только рядом с разобранными строками. Если
  // принадлежность не определялась вовсе, эта фраза выдаёт отсутствие данных
  // за результат проверки — и пугает читателя на ровном месте.
  if (c.unresolved > 0 && c.unresolved < c.shown) {
    parts.push(
      `${c.unresolved} ${pluralRu(c.unresolved, "требует", "требуют", "требуют")} уточнения принадлежности`
    );
  }
  const breakdown = parts.length > 0 ? `: ${enumerateRu(parts, 4)}` : "";
  const adverse =
    c.adverse > 0
      ? ` С негативной формулировкой — ${c.adverse}.`
      : " Негативных формулировок нет.";
  return `${head}${breakdown}.${adverse}`;
}

/**
 * Статусная строка страницы, у которой есть панель.
 *
 * Считает то же, что читатель видит, — строки панели. На прогоне 14.08 стр. 44
 * говорила разом «негативных формулировок нет» (по десяти строкам панели) и «на
 * этой странице 1 негативный заголовок» (по сорока четырём собранным строкам):
 * два числа о разных наборах, поданные как одно про одну страницу.
 *
 * Собранный набор при этом не замалчивается. Если негатив есть в нём, но не
 * попал на панель, строка говорит об этом прямо — иначе исчезнет факт, ради
 * которого страницу и читают.
 */
export function panelStatusLine(input: {
  shownAdverse: number;
  /** Негативные строки во всём собранном наборе, если он больше панели. */
  collectedAdverse?: number;
  nounOne: string;
  nounFew: string;
  nounMany: string;
}): string {
  const noun = (n: number): string => pluralRu(n, input.nounOne, input.nounFew, input.nounMany);
  if (input.shownAdverse > 0) {
    return `На этой странице ${input.shownAdverse} ${noun(input.shownAdverse)} с негативной формулировкой — их видно до перехода к самим материалам, поэтому они формируют первое впечатление.`;
  }
  const hidden = input.collectedAdverse ?? 0;
  if (hidden > 0) {
    return `Среди показанных строк негативных формулировок нет; в собранном наборе — ${hidden} ${noun(hidden)}.`;
  }
  return "Строк с негативной формулировкой на этой странице нет.";
}

export function adverseVisualSidebar(
  slotId: string,
  extras: FragmentExtras,
  scoped: ScopedFragmentInput,
  rowNoun: string
): {
  visibleRows: VisibleAssetItem[];
  adverseRows: VisibleAssetItem[];
  gridRefs: string[];
  explanations: NonNullable<SlideBody["highlightExplanations"]>;
  explainedFindingIds: string[];
} {
  const visibleRows = (extras.visualAssets?.[slotId] ?? []).flatMap((a) => a.visibleItems ?? []);
  const adverseRows = visibleRows.filter((v) => v.adverse);
  const seen = new Set<string>();
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const explainedFindingIds: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const theme = f?.theme ?? row.themeTitle ?? "Потенциально нежелательный материал";
    const target = row.domain ? ` — ${rowNoun} ведёт на ${row.domain}` : "";
    const dedupKey = `${f?.findingId ?? theme}|${row.domain ?? row.title ?? ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    explanations.push({
      clientReason: clampClientText(
        `«${theme}»${target}${f ? `; уровень: ${riskLabel(f.riskLevel).toLowerCase()}` : "; требует ручной проверки"}.`,
        300
      ),
      frameTone: "red" as const,
    });
    if (f && !explainedFindingIds.includes(f.findingId)) explainedFindingIds.push(f.findingId);
  }
  const gridRefs = visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r]));
  return { visibleRows, adverseRows, gridRefs, explanations, explainedFindingIds };
}
