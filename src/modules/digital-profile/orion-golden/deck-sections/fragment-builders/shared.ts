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
import {
  DECK_TEMPLATE_REGISTRY,
  SIDEBAR_HIGHLIGHT_BUDGET,
  type DeckTemplateId,
} from "../template-registry";
import { balanceTailPage } from "../semantic-summary-pagination";
import { buildContinuationSlide } from "../continuation-slide";
import {
  evidenceMaterialKey,
  normalizeEvidenceRef,
  regionMatches,
  resolveEmptySurfaceCollection,
  type ComplianceScreeningRecord,
  type EmptySurfaceCollectionStatus,
  type LinkReadRegionCounts,
  type MetricSnapshot,
  type PersonaDecisionRecord,
  type ScopedEvidenceIndex,
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
import {
  pageReadAsFavourable,
  resolveRowAdverse,
  type ObservationVerdict,
} from "../../../serp-observation/resolve-observation-highlights";
import { VISUAL_ASSET_UNAVAILABLE } from "../slide-markers";
import { clampQuotedLine, closeDanglingQuote } from "../quote-integrity";
import { clientRiskStep, riskAttentionPhrase, riskWord } from "../../client/risk-scale";
import {
  clientAddress,
  clientAddressText,
  parseClientAddress,
  SOURCE_ATTRIBUTION_SOURCE,
} from "../../client/client-address";
import { normalizeForCompare } from "../text-compare";
import { pageQuoteForClient } from "../../analytics/client-quote-hygiene";
import {
  cleanExampleTitle,
  clientThemeWhy,
  isWeakExampleTitle,
  quoteForClaim,
  themeScaleLine,
} from "../../analytics/finding-synthesizer";
import { pluralRu } from "../../../report/i18n/plural-ru";
import {
  getFindingThemes,
  isAccusingTheme,
  type ThemeDef,
} from "../../../config/finding-themes";
import {
  freshnessFootnote,
  reportDiffClientLine,
} from "../../../services/report-material-freshness";
export { pickDistinctTitles, titleFingerprint } from "../../analytics/distinct-stories";
import { pickDistinctTitles } from "../../analytics/distinct-stories";
import {
  clientSafeDomain,
  clientSafeDomains,
  isMockClientDomain,
} from "../../../services/composite-serp-merge";
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
  /**
   * Итоги скрининга по комплаенс-базам этого прогона.
   *
   * Страница базы без записей выбирает по ним одну из трёх формулировок:
   * «проверено — совпадений нет», «проверка не выполнена — причина» и
   * «проверка не выполнялась». Данные, а не конфигурация: чтение окружения
   * сделало бы клиентский текст зависимым от машины сборки.
   */
  complianceScreenings?: ComplianceScreeningRecord[];
  /**
   * Решение оператора о том, о ком собираем, — снимок, снятый до первой траты.
   *
   * Отсутствие поля значит «решения у кейса нет», и лист «Кого проверяли»
   * говорит именно это: пропустить лист было бы вторым смыслом — «решения не
   * было» и «страница потерялась» стали бы неразличимы.
   */
  personaDecision?: PersonaDecisionRecord;
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
 * Разложить блоки по страницам первым заходом: первая — с обвязкой, дальше — без неё.
 *
 * Это **сид**, а не ёмкость. Сколько влезает на лист, отвечает мерный прогон
 * рендерера, и после него разбивку определяет вердикт меры. Счётная модель
 * строк, которая раньше стояла здесь, пыталась угадать высоту по числу знаков
 * в строке и промахнулась на живом прогоне: она и была вторым ответом на
 * вопрос, у которого ответ один.
 */
export function packBulletPages(
  bullets: readonly string[],
  firstCount: number,
  contCount: number,
  itemCharBudget: number,
  /** Померенная ёмкость первого листа в знаках; без неё — прежний расчёт. */
  firstCharCap?: number
): string[][] {
  if (firstCount <= 0) return [[...bullets]];
  const pages: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  let cap = firstCount;
  let charCap = firstCharCap ?? firstCount * itemCharBudget;
  const flush = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    curChars = 0;
    cap = contCount;
    charCap = contCount * itemCharBudget;
  };
  for (const b of bullets) {
    const size = b.length;
    const overflows = cur.length >= cap || curChars + size > charCap;
    if (cur.length > 0 && overflows) flush();
    cur.push(b);
    curChars += size;
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
  /*
   * Ёмкость первого листа в знаках — только там, где её померили.
   *
   * Разбивка шла по счёту буллетов и молчала, когда счёт помещается, а знаки
   * нет: три блока по 300 знаков — это «три из четырёх», и лист их принимал,
   * хотя рендерер рисовал один. Шаблоны без объявленной меры сохраняют прежнее
   * поведение: подставить сюда расчёт «по бумаге» значило бы завести второй,
   * неизмеренный ответ о ёмкости.
   */
  const firstCharCap = tpl.layout.maxBulletCharsPerSlide;
  const overflowsChars =
    firstCharCap !== undefined && bullets.reduce((n, b) => n + b.length, 0) > firstCharCap;
  const needsPaging = firstBulletCap > 0 && (bullets.length > firstBulletCap || overflowsChars);
  const bulletChunks = needsPaging
    ? packBulletPages(
        bullets,
        firstBulletCap,
        contBulletCap,
        tpl.layout.itemCharBudget,
        firstCharCap
      )
    : [bullets];
  const addresses = base.content.table?.rowAddresses;
  const needsRowPaging = tpl.maxTableRowsPerSlide > 0 && rows.length > tpl.maxTableRowsPerSlide;
  const rowChunks = needsRowPaging ? chunk(rows, tpl.maxTableRowsPerSlide) : [rows];
  // Адреса режутся тем же разрезом, что и строки: иначе строки уезжают на
  // продолжение, а их адреса остаются на первой странице — и обе страницы
  // печатают чужие ссылки.
  const addressChunks = addresses
    ? needsRowPaging
      ? chunk(addresses, tpl.maxTableRowsPerSlide)
      : [addresses]
    : undefined;
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
        ? {
            headers: base.content.table.headers,
            rows: rowChunks[i] ?? [],
            ...(addressChunks ? { rowAddresses: addressChunks[i] ?? [] } : {}),
          }
        : undefined,
    };
    if (i === 0) {
      slides.push({ ...base, content: { ...content, narrative: narrativeChunks[0] || undefined } });
    } else {
      slides.push(
        buildContinuationSlide({
          base,
          index: i + 1,
          totalPages: total,
          content: { ...content, narrative: narrativeChunks[i] || undefined },
        })
      );
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

/**
 * Обрубленный хвост, начатый ярлыком, снимается целиком.
 *
 * «Где видно:», «Что делать:», «Всего по теме:» обещают содержимое, и рез
 * посреди него — сломанный текст двух видов: ярлык без ничего («…Где видно:»)
 * и список, оборванный на первом имени («Где видно: nordmarket-watch.se» там,
 * где их было два). Второе хуже первого: читатель не видит, что список
 * неполон. Модели это запрещено прямым указанием в промпте
 * (`llm-slide-copy`), а детерминированный рез делал ровно то же самое.
 *
 * Срабатывает только когда рез пришёлся НЕ на конец предложения: текст,
 * законченный точкой или закрывающей скобкой, не трогается.
 *
 * Ярлык — короткий: до трёх слов не длиннее двадцати знаков каждое, и ни одно
 * не содержит конца предложения. Поэтому длинный токен (адрес, скажем) ярлыком
 * не считается, а «Текст. Что делать: све» теряет ровно предложение с ярлыком.
 *
 * Если после снятия не осталось ничего — текст возвращается как был: пустой
 * буллет хуже обрубленного, а случай «весь текст — один обрезанный ярлык»
 * означает бюджет в пару десятков знаков, которого в деке нет.
 */
const INCOMPLETE_LABEL_TAIL_RE =
  /(?:^|(?<=[.!?…»)]\s))[^\s:.!?…»]{1,20}(?:\s[^\s:.!?…»]{1,20}){0,2}:.*$/u;

function withoutIncompleteLabelTail(text: string): string {
  if (/[.!?…»)]$/u.test(text)) return text;
  const cut = text.replace(INCOMPLETE_LABEL_TAIL_RE, "").replace(/[\s·;,—-]+$/u, "");
  return cut || text;
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
  out = withoutIncompleteLabelTail(out);
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
      ? // Было «достоверность оценки высокая». Рядом со ступенью «высокий» это
        // один и тот же корень дважды об одном предложении, а речь о разном:
        // степень внимания и надёжность оценки.
        "оценка достоверна"
      : top.confidence >= 0.6
        ? "достоверность оценки уверенная"
        : "оценка требует подтверждения";
  const head = kind.charAt(0).toUpperCase() + kind.slice(1);
  // Ступень стоит после тире; у неизвестного уровня слова-прилагательного нет,
  // и оборот берётся целиком — иначе выходит «уровень внимания — требует
  // уточнения».
  const attention = clientRiskStep(top.riskLevel)
    ? `уровень внимания — ${riskWord(top.riskLevel)}`
    : riskAttentionPhrase(top.riskLevel);
  return `${head}, ${attention}; ${conf}.`;
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
  /** findingId → номера напечатанных строк, которые его поддерживают. */
  supportRows: Map<string, number[]>;
  /**
   * Строки, которые страница действительно напечатала.
   *
   * Единица счёта листа: таблица выдачи сводит наблюдения по материалу, и
   * «негативных заголовков — 2» над одной строкой «Нежелательный» читается как
   * ошибка. Есть у того, кто такие строки печатает; у сетки и панели их нет.
   */
  printedRows?: PrintedPageRow[];
};

/**
 * Напечатанная строка таблицы: её номер и ссылки материала, который она несёт.
 *
 * Номер — тот, что напечатан в первой колонке, а не порядок в массиве: на
 * странице выдачи это позиция в выдаче, и читатель ищет на листе именно её.
 */
export type PrintedPageRow = { rank: number; refs: string[] };

/**
 * @param printedRows Строки, которые страница действительно напечатала.
 *
 * Передаёт их только тот, у кого единица листа — строка с номером (таблица
 * выдачи). Тогда тема на такой странице называет свою опору номером, а тема,
 * которую не поддерживает ни одна напечатанная строка, не называется вовсе:
 * ярлык без опоры отправляет читателя искать на листе то, чего там нет. У
 * плитки сетки, панели знаний и подсказок номера строки нет, и они этот
 * аргумент не передают.
 */
export function buildPageEvidenceView(
  scoped: ScopedFragmentInput,
  pageRefs: string[],
  printedRows?: PrintedPageRow[]
): PageEvidenceView {
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
  // Номер строки разыскивается теми же двумя ключами, что и поддержка находки:
  // иначе страница признавала бы тему своей и не могла назвать строку.
  const rowByNormRef = new Map<string, number>();
  const rowByNormUrl = new Map<string, number>();
  for (const row of printedRows ?? []) {
    for (const ref of row.refs) {
      rowByNormRef.set(normalizeEvidenceRef(ref), row.rank);
      const u = normalizeEvidenceUrl(scoped.evidenceIndex[ref]?.url);
      if (u && !rowByNormUrl.has(u)) rowByNormUrl.set(u, row.rank);
    }
  }
  const findings: Finding[] = [];
  const supportDomains = new Map<string, string[]>();
  const supportRows = new Map<string, number[]>();
  for (const f of scoped.findings) {
    const support = new Set<string>();
    const rows = new Set<number>();
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
        const rank = rowByNormRef.get(norm);
        if (rank !== undefined) rows.add(rank);
        continue;
      }
      const u = normalizeEvidenceUrl(e?.url);
      if (u && urlToDomain.has(u)) {
        hit = true;
        support.add(urlToDomain.get(u)!);
        const rank = rowByNormUrl.get(u);
        if (rank !== undefined) rows.add(rank);
      }
    }
    if (!hit) continue;
    // Страница называет только то, что показала строкой.
    if (printedRows && rows.size === 0) continue;
    findings.push(f);
    supportDomains.set(f.findingId, [...support]);
    supportRows.set(f.findingId, [...rows].sort((a, b) => a - b));
    // Support domains name the same on-page rows (resolved through the
    // finding's evidence entry when the page ref itself is opaque).
    for (const d of support) domains.add(d);
  }
  findings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  return {
    refs: pageRefs,
    domains: [...domains],
    findings,
    supportDomains,
    supportRows,
    ...(printedRows ? { printedRows } : {}),
  };
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
 * Настройки блоков, собираемых по одной странице.
 *
 * `namePageDomains: false` — перечень доменов в абзац не идёт. Так делает
 * **только** построитель таблицы выдачи: полосы адресов под строками печатают
 * те же домены целиком и все, а перечень режется тремя элементами и потому
 * противоречит собственному листу — на стр. 15 эталона он называл три домена
 * из четырёх, лежащих на странице. У изображений, подсказок, панели знаний,
 * AI-ответов и идентичности полос адресов нет, и без перечня такая страница не
 * скажет, откуда материал; поэтому по умолчанию домены называются.
 */
export type PageBlockOptions = {
  namePageDomains?: boolean;
  /**
   * Состав строк, уже посчитанный вызывающим.
   *
   * Нужен там, где страница называет своё число негатива дважды — в заголовке
   * и в теле. Пересчитать его здесь по `view.refs` значило бы завести второй
   * ответ на тот же вопрос: у страницы изображений в счёт входят ещё и строки,
   * которые нашли, но не нарисовали, а `view` о них не знает.
   */
  composition?: PageRowComposition;
};

/**
 * Номера подряд — диапазоном, остальные через запятую: «1–3, 5, 11–20».
 *
 * Один ответ на «как этот лист называет набор своих номеров»: им подписаны и
 * пропущенные позиции таблицы (`missingSerpRanks`), и опора темы в абзаце над
 * ней. Разная запись на одной странице читалась бы как разные величины.
 */
export function compactRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  const flush = (): void => {
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
  };
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    flush();
    start = n;
    prev = n;
  }
  flush();
  return parts.join(", ");
}

/**
 * Вывод по теме: тема, ступень внимания и опора — номера строк этой страницы.
 *
 * Тема без опоры — ярлык: на стр. 22 отчёта Кремлёва абзац объявлял «Офшоры /
 * корпоративное владение», а которая из четырёх напечатанных строк её несёт, не
 * говорил. Домены на эту роль не годятся (полосы адресов под строками печатают
 * их целиком и все, а перечень режется тремя и спорит с собственным листом), а
 * номер строки с полосой не спорит: он указывает на строку того же листа.
 */
function themeAttentionLine(f: Finding, rows: number[]): string {
  // Было: «тема»: уровень внимания — критический — материалы на этой странице:
  // a, b. Цепочка «двоеточие — тире — двоеточие» читается как строка таблицы,
  // а не как предложение. Теперь это два коротких предложения.
  const attention = `«${f.theme}» — ${riskAttentionPhrase(f.riskLevel)}`;
  if (rows.length === 0) return `${attention}.`;
  const word = rows.length === 1 ? "строка" : "строки";
  /*
   * Опора названа скобкой, а не отдельным предложением, и номера в ней
   * свёрнуты в диапазоны.
   *
   * Абзац страницы выдачи стоит у кромки кегля: замер
   * `renderer/smoke_search_table_layout.py` (Т11е2) показывает, что живой
   * состав — лид с запросом, пропущенные позиции, набор из пяти запросов,
   * «почему важно» и рекомендация — держит 11 pt едва-едва, и опора съедает
   * весь остаток. Перечисление «строки 17, 18, 19 и 20» стоит вдвое дороже
   * диапазона «строки 17–20» и роняло лист на девятку при соседних листах
   * деки в 11 pt.
   *
   * Несмежные номера остаются перечнем через запятую: диапазон «13–19» назвал
   * бы строки 14, 16 и 18, которые тему не несут, — то есть отправил бы
   * читателя ровно к той строке, ради которой опора и заводилась. Правило
   * одно на все случаи и то же самое, каким этот лист называет пропущенные
   * позиции («Позиции 1–3, 5, 11–20»).
   *
   * Номера перечисляются все: на листе их не больше ёмкости таблицы, и «и ещё
   * 2» вместо номеров вернуло бы ту же ненайденную опору.
   */
  return `${attention} (${word} ${compactRanges(rows)}).`;
}

/** Перечень доменов страницы, поддерживающих эту тему. */
function pageDomainsLine(f: Finding, view: PageEvidenceView): string {
  // Демо-домены вычищались только из строк источников, а сюда протекали.
  const where = clientSafeDomains(view.supportDomains.get(f.findingId) ?? []).slice(0, 3);
  return where.length ? `Материалы по теме на этой странице — ${enumerateRu(where)}.` : "";
}

/**
 * Page-specific conclusion for one finding: theme + risk + the on-page
 * source domains. Deliberately NOT the finding's global claim text — the
 * claim may cite evidence from other pages/regions.
 */
export function pageScopedConclusion(
  f: Finding,
  view: PageEvidenceView,
  opts: PageBlockOptions = {}
): string {
  const src = opts.namePageDomains === false ? "" : pageDomainsLine(f, view);
  const rows = view.supportRows.get(f.findingId) ?? [];
  return clampClientText([themeAttentionLine(f, rows), src].filter(Boolean).join(" "), 400);
}

/**
 * Решение по прочитанной странице так, как его видит единый предикат.
 *
 * Загрузчик входов раскладывает решение по всем ссылкам материала и записывает
 * его тремя полями: тон, принадлежность и `adverse` — «нежелательный вывод,
 * подтверждённый цитатой». Четвёртого поля «была ли цитата» нет намеренно:
 * правило «без цитаты рамку не ставим» применено там же, где решение читается
 * из артефакта, и второй его копии здесь быть не должно.
 *
 * Нет тона — страницу не читали, и решения по ней нет вовсе.
 */
export function evidenceRowVerdict(
  e: ScopedEvidenceIndex[string] | undefined
): ObservationVerdict | undefined {
  if (!e?.readVerdictTone) return undefined;
  return {
    tone: e.readVerdictTone,
    quoted: e.adverse === true,
    subjectMatch: (e.verdictSubjectMatch ?? "unclear") as ObservationVerdict["subjectMatch"],
  };
}

/**
 * Читали ли страницу этой строки — один ответ на весь отчёт.
 *
 * Признак берётся из данных: тон прочитанной страницы есть только у той, что
 * открыли и оценили. Отказ чтения тона не оставляет, и такая строка ничем не
 * отличается от той, которую не запрашивали вовсе, — обе «не проверены».
 *
 * Тема и цитата отдельным признаком быть не могут: тон принимает ровно три
 * значения (`LinkToneSchema`), и загрузчик пишет их одной веткой — запись с
 * темой, но без тона, недостижима.
 */
export function evidenceRowWasRead(e: ScopedEvidenceIndex[string] | undefined): boolean {
  return Boolean(e?.readVerdictTone);
}

/**
 * Негативна ли строка индекса доказательств — тем же предикатом, что и рамка.
 *
 * Прочерк вместо домена — печатная форма пустоты, а не имя площадки: с ним
 * список негативных площадок сравнивать нечего, и адрес отвечает за домен сам.
 *
 * Решение можно передать снаружи: таблица выдачи печатает материал, а не
 * наблюдение, и берёт у него одно решение на все свои ссылки.
 */
export function evidenceRowAdverse(
  e: ScopedEvidenceIndex[string] | undefined,
  verdict: ObservationVerdict | undefined = evidenceRowVerdict(e)
): boolean {
  if (!e) return false;
  return resolveRowAdverse(
    {
      url: e.url,
      domain: e.domain && e.domain !== "—" ? e.domain : undefined,
      title: e.title,
      snippet: e.snippet,
      analystDecision: e.analystDecision,
    },
    verdict
  );
}

/**
 * Вся ли нарисованная строка о другом лице.
 *
 * В одной строке живут все наблюдения материала, и решения о принадлежности у
 * них бывают разными: один запрос отнёс страницу к однофамильцу, другой — к
 * субъекту. «О другом лице» такая строка только тогда, когда **каждая** её
 * ссылка такая, — иначе лист печатал «негативных заголовков — 0» над строкой,
 * которую сам же назвал «Нежелательной». Ответ один: его спрашивают и оценка в
 * таблице выдачи, и счёт строк страницы.
 */
export function evidenceRowsAreOtherSubject(
  scoped: ScopedFragmentInput,
  refs: string[]
): boolean {
  return (
    refs.length > 0 &&
    refs.every(
      (ref) => scoped.evidenceIndex[ref]?.subjectDecision === OTHER_SUBJECT_DECISION
    )
  );
}

/**
 * Негативна ли **нарисованная строка**: у материала одно решение на все ссылки.
 *
 * Наблюдения различаются запросом, а страницу читали не по запросу, поэтому
 * решение берётся один раз; словарь при этом смотрит каждое наблюдение —
 * сниппеты у них разные, и сигнал в любом из них принадлежит материалу.
 *
 * Спрашивают отсюда двое: сама таблица выдачи (колонка «Оценка») и счёт строк
 * страницы. Второй ответ на этот вопрос — это «негативных заголовков — 2» над
 * одной красной строкой.
 */
export function evidenceRowsAdverse(scoped: ScopedFragmentInput, refs: string[]): boolean {
  const verdict = refs.map((ref) => evidenceRowVerdict(scoped.evidenceIndex[ref])).find(Boolean);
  return refs.some((ref) => evidenceRowAdverse(scoped.evidenceIndex[ref], verdict));
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
 * Что за строки на этой странице: принадлежность, негатив, домены.
 *
 * Негатив считается **единым предикатом** (`resolveRowAdverse`) и по тем же
 * строкам, что и `shown`: числа одной фразы обязаны сходиться между собой, а
 * «негативных заголовков — 3» над «Показано 1 результат» — это лист, который
 * показывают банку. Строки, найденные, но не нарисованные, считает и называет
 * та страница, у которой они есть, — своей фразой и своим числом.
 */
export function composePageRowComposition(
  scoped: ScopedFragmentInput,
  pageRefs: string[],
  /**
   * Нарисованные строки, если страница их печатает.
   *
   * Тогда единица счёта — строка, а не ссылка: таблица выдачи сводит наблюдения
   * по материалу, и страница, найденная двумя запросами, — одна строка. Без
   * этого лист печатал «Показано 8 результатов» над четырьмя строками и
   * «негативных заголовков — 2» над одной красной.
   */
  printedRows?: PrintedPageRow[]
): PageRowComposition {
  const units = printedRows ? printedRows.map((r) => r.refs) : pageRefs.map((ref) => [ref]);
  let subjectMatch = 0;
  let likelySubject = 0;
  let adverseHeadlines = 0;
  const domainCounts = new Map<string, number>();
  for (const refs of units) {
    const decisions = refs.map((ref) => scoped.evidenceIndex[ref]?.subjectDecision);
    if (decisions.includes("SUBJECT_MATCH")) subjectMatch += 1;
    else if (decisions.includes("LIKELY_SUBJECT")) likelySubject += 1;
    // Негативный заголовок о другом лице фон вокруг субъекта не формирует. Но
    // «о другом лице» — это про всю строку целиком: у первой её ссылки решение
    // может быть чужим, а у второй — своим, и тогда строка о субъекте.
    if (
      countsTowardSubjectNegative({
        adverse: evidenceRowsAdverse(scoped, refs),
        decision: evidenceRowsAreOtherSubject(scoped, refs)
          ? OTHER_SUBJECT_DECISION
          : undefined,
      })
    ) {
      adverseHeadlines += 1;
    }
  }
  for (const ref of pageRefs) {
    const e = scoped.evidenceIndex[ref] ?? {};
    const domain = e.domain && e.domain !== "—" ? e.domain : domainOfUrl(e.url);
    if (domain && domain !== "—") {
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }
  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, 4)
    .map(([d]) => d);
  return {
    shown: units.length,
    subjectMatch,
    likelySubject,
    adverseHeadlines,
    topDomains,
  };
}

/**
 * Что страница говорит о негативе, который сама же напечатала строками.
 *
 * Фраза одна на два места: на страницу без выделенной темы и на страницу, где
 * тема есть, но её уровень не «повышенное внимание». Пока их было две — одна
 * считала негатив по строкам, другая по уровню тем, — лист печатал
 * «Показанные на странице материалы не формируют негативного фона вокруг
 * субъекта» прямо над строкой с оценкой «Нежелательный».
 *
 * Единица счёта здесь — строка этого листа, тем же предикатом, каким заполнена
 * колонка «Оценка».
 */
function pageAdverseRowsLine(adverseRows: number): string {
  return adverseRows > 0
    ? `На странице есть негативные заголовки (${adverseRows}) — они влияют на первое ` +
        "впечатление при проверке, даже если отдельная тема повышенного внимания на ней " +
        "не выделена."
    : "Показанные на странице материалы не формируют негативного фона вокруг субъекта.";
}

/** Descriptive sidebar from page rows when no finding is page-supported (§7.1). */
export function pageRowCompositionBlocks(
  composition: PageRowComposition,
  view: PageEvidenceView,
  opts: PageBlockOptions = {}
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
  const domainsList =
    opts.namePageDomains === false
      ? ""
      : enumerateRu(clientSafeDomains(composition.topDomains));
  const domainsNote = domainsList ? `; преобладающие источники: ${domainsList}` : "";
  return {
    whatWasFound: clampClientText(
      `Показано ${composition.shown} ${resultWord}; из них о субъекте — ${composition.subjectMatch}, вероятно о субъекте — ${composition.likelySubject}, негативных заголовков — ${composition.adverseHeadlines}${domainsNote}.`,
      400
    ),
    whyItMatters: clampClientText(
      composition.adverseHeadlines > 0
        ? pageAdverseRowsLine(composition.adverseHeadlines)
        : composition.likelySubject > 0
          ? `Часть строк отмечена как «Вероятно» о субъекте — их нельзя игнорировать, но и нельзя включать в подтверждённые выводы без уточнения принадлежности.`
          : "На странице есть результаты выдачи; отдельной подтверждённой темы повышенного внимания среди показанных строк не выделено.",
      320
    ),
    whatToCheck: clampClientText(
      composition.subjectMatch > 0 || composition.likelySubject > 0
        ? "Сверить заголовки и домены с профилем субъекта; уточнить принадлежность строк со статусом «Вероятно»."
        : "Мониторить изменения выдачи.",
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
  opts: PageBlockOptions = {}
): Partial<SlideBody> {
  const adverse = view.findings.filter(isAdverse);
  const top = view.findings[0];
  /*
   * Состав строк листа считается один раз и здесь.
   *
   * «Есть ли на этой странице негатив» — вопрос о строках, и отвечать на него
   * уровнем темы нельзя: тема низкого уровня уживается на одном листе со
   * строкой «Нежелательный», и лист начинал спорить сам с собой.
   */
  const composition =
    opts.composition ?? composePageRowComposition(scoped, view.refs, view.printedRows);
  if (top) {
    return {
      whatWasFound: pageScopedConclusion(top, view, opts),
      whyItMatters: clampClientText(
        adverse.length
          ? // Было: «затрагивают тем повышенного внимания: 3» — падеж не
            // согласован с числом, и счётчик подан как причина. Теперь число
            // склоняется, а причина названа словами.
            `На странице ${adverse.length} ${pluralRu(adverse.length, "тема", "темы", "тем")} ` +
              "повышенного внимания — эти материалы видны при первой же проверке субъекта."
          : pageAdverseRowsLine(composition.adverseHeadlines),
        320
      ),
      whatToCheck: clampClientText(
        top.recommendedAction ?? "Мониторить изменения выдачи.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote: pageSourceLine(view),
    };
  }
  if (view.refs.length > 0) {
    return pageRowCompositionBlocks(composition, view, opts);
  }
  return {
    whatWasFound:
      "Существенных материалов среди показанных на этой странице элементов не обнаружено.",
    whyItMatters: clampClientText(pageAdverseRowsLine(composition.adverseHeadlines), 320),
    whatToCheck: clampClientText("Мониторить изменения выдачи.", 220),
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
/** Только знаки препинания — своей строки такой кусок не заслуживает. */
const PUNCTUATION_ONLY_RE = /^[^\p{L}\p{N}]+$/u;
const LEADING_PUNCTUATION_RE = /^[.,;:!?…]+/u;

/**
 * Кусок клиентского текста в разбор буллета: содержательный — своей строкой,
 * пунктуация — приклеенной к предыдущей.
 */
function appendClientFragment(out: string[], text: string): void {
  if (!text) return;
  if (PUNCTUATION_ONLY_RE.test(text)) {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]}${text}`;
    return;
  }
  out.push(text);
}

/** Хвост после последней цитаты: ведущая точка остаётся на строке своей цитаты. */
function appendStructuredTail(out: string[], tail: string): void {
  const parts = splitStructuredTail(tail);
  if (parts.length === 0) return;
  const lead = parts[0]!.match(LEADING_PUNCTUATION_RE)?.[0] ?? "";
  if (lead && out.length > 0) {
    out[out.length - 1] = `${out[out.length - 1]}${lead}`;
    parts[0] = parts[0]!.slice(lead.length).trim();
  }
  out.push(...parts.filter(Boolean));
}

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

/**
 * Слова, которыми начинается ввод к цитатам («Найдены публикации по теме…»).
 *
 * Список один на деку: по нему перекладка абзаца отличает ввод от текста, а
 * карточка матрицы — ввод от строки статистики. Разъедутся — карточка снова
 * напечатает ввод вместо чисел.
 */
const QUOTE_INTRO_WORDS = "Найдены|Есть публикации|В открытой";
const QUOTE_INTRO_RE = new RegExp(`^(?:${QUOTE_INTRO_WORDS})`, "u");

/**
 * Строка претензии — ввод к цитатам, а не утверждение.
 *
 * Двоеточие в конце — не единственный признак: перекладка абзаца его снимает, и
 * строка остаётся вводом («Найдены материалы делового профиля»), который
 * повторяет заголовок карточки и склеивается с рекомендацией без точки.
 */
export function isQuoteIntroLine(line: string): boolean {
  const l = String(line ?? "").trim();
  return l.endsWith(":") || QUOTE_INTRO_RE.test(l);
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
  const quoteRe = new RegExp(`«[^»]{8,}»\\s*${SOURCE_ATTRIBUTION_SOURCE}`, "gu");
  const lineNeedsReflow = (l: string): boolean => {
    const n = (l.match(quoteRe) ?? []).length;
    if (n > 1) return true;
    if (n === 1 && /(?:Всего по теме:|В корпусе:|Для банка|Банки |Риск в том|Что делать:)/u.test(l)) {
      return true;
    }
    return new RegExp(`^«[^»]{2,80}»\\s+(?:${QUOTE_INTRO_WORDS})`, "u").test(l);
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
    QUOTE_INTRO_RE.test(themeM[3] ?? "")
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
    /*
     * Между цитатами ничего не пропадает.
     *
     * Буллет пересобирается из совпадений, поэтому всё, что стоит между ними,
     * жило ровно до тех пор, пока его кто-нибудь не назвал. Названа была одна
     * строка — «О чём: …», объясняющая свою цитату; остальное выбрасывалось
     * молча. На живом отчёте 21.08 так исчез хвост адреса с пробелом, а вместе
     * с ним закрывающая скобка (шаг 0025).
     *
     * Специальной ветки больше нет: правило одно на любой кусок. Знаки
     * препинания приклеиваются к предыдущей строке — точка принадлежит
     * предложению, которое закончилось, а не тому, которое начинается.
     */
    const matches = [...rest.matchAll(quoteRe)];
    let lastEnd = 0;
    matches.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      out.push(m[0].trim());
      if (i + 1 >= matches.length) {
        lastEnd = end;
        return;
      }
      const nextStart = matches[i + 1]!.index ?? rest.length;
      lastEnd = nextStart;
      appendClientFragment(out, rest.slice(end, nextStart).trim());
    });
    const tail = rest.slice(lastEnd).trim();
    if (tail) appendStructuredTail(out, tail);
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
      // Ярлык темы печатается заголовком строки, и двоеточие там лишнее. У
      // ввода к цитатам оно часть фразы: без него «Найдены материалы …»
      // упирается прямо в цитату.
      theme = isQuoteIntroLine(left) ? `${left}:` : left;
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

/** Строка счёта в утверждении находки — всегда на своей строке. */
const THEME_SCALE_LINE_RE = /^[ \t]*(?:Всего по теме|В корпусе):[^\n]*$/mu;

/**
 * Собрано ли утверждение синтезатором находок.
 *
 * Его разметка — строка счёта: `buildClientFacingClaim` печатает её всегда, а
 * вместе с ней всегда печатает и присказку темы. Легаси-утверждения (например,
 * в фикстуре `report-72`) идут одной строкой старого формата «тема: 7
 * свидетельств (5 негативных) в источниках …» — ни счёта, ни присказки, и
 * дописывать им своё региональная пересборка не вправе.
 *
 * Без привязки к началу строки: утверждение бывает и одним абзацем.
 */
const SYNTHESIZED_CLAIM_RE = /(?:Всего по теме|В корпусе):/u;

/**
 * Счёт темы на региональной странице: материалы этого региона и негатив среди
 * них.
 *
 * Считаются **материалы**, а не наблюдения: ключ наблюдения включает запрос, и
 * одна страница, найденная двумя запросами, лежит в находке двумя ссылками, а
 * читателю она одна. Негатив у материала один на все его наблюдения и берётся
 * тем же единственным предикатом, которым дека красит строку выдачи и ставит
 * рамку на снимке (`evidenceRowAdverse` → `resolveRowAdverse`), — второго
 * ответа на «негативен ли материал» в отчёте нет.
 *
 * Свидетельство **без региона** не считается нигде: у записи комплаенс-базы
 * региона нет вовсе, и, попадая в счёт каждого региона, она подавалась
 * клиенту как найденная здесь, а сумма региональных чисел выходила больше
 * глобального. Отнести её к одному из регионов страница не может — она видит
 * только свою область; называет такую запись тот раздел, где она живёт.
 *
 * Пустая строка означает «счёта нет»: либо его не было и в глобальном
 * утверждении (`localizedThemedClaim` переписывает найденное, а не добавляет
 * своё), либо считать в этом регионе нечего.
 */
function regionalThemeScaleLine(f: Finding, scoped: ScopedFragmentInput): string {
  if (!THEME_SCALE_LINE_RE.test(String(f.claim ?? ""))) return "";
  const regions = scoped.scope?.regions ?? [];
  const adverseByMaterial = new Map<string, boolean>();
  for (const ref of f.evidenceRefs) {
    const e = scoped.evidenceIndex[ref];
    if (!e) continue;
    if (!regions.some((r) => regionMatches(r, e.region))) continue;
    const key = evidenceMaterialKey(e, ref);
    adverseByMaterial.set(key, (adverseByMaterial.get(key) ?? false) || evidenceRowAdverse(e));
  }
  if (adverseByMaterial.size === 0) return "";
  return themeScaleLine(
    adverseByMaterial.size,
    [...adverseByMaterial.values()].filter(Boolean).length
  );
}

/**
 * Копия находки с региональной строкой счёта вместо глобальной.
 *
 * Правится строка утверждения, а не собранный текст: `themedClaim` дальше сам
 * разложит утверждение по строкам, а подстановка в уже разложенное зависела бы
 * от того, как оно разложилось. Пустая строка счёта означает «считать в этом
 * регионе нечего» — тогда числа не остаётся вовсе, а не остаётся глобальное.
 */
function withThemeScaleLine(f: Finding, scale: string): Finding {
  const claim = String(f.claim ?? "");
  if (!THEME_SCALE_LINE_RE.test(claim)) return f;
  const next = scale
    ? claim.replace(THEME_SCALE_LINE_RE, scale)
    : claim.replace(THEME_SCALE_LINE_RE, "").replace(/\n{2,}/gu, "\n").trim();
  return { ...f, claim: next };
}

/**
 * Тема находки — по её идентификатору, а не по разбору ярлыка.
 *
 * Разбор шёл подстрокой, и держалось это только на том, что ярлыки непохожи:
 * «Офшоры / корпоративное владение» **содержит** «Корпоративное владение», и
 * находка прежнего прогона разбиралась как описательная тема — с чужой
 * присказкой и, что хуже, со снятой защитой «обвиняющая тема не цитирует
 * благоприятно прочитанную страницу». Ярлык переименовывают (в том числе файлом
 * переопределения каталога), идентификатор — нет.
 *
 * Точное совпадение ярлыка остаётся вторым ответом и нужно тем находкам, у
 * которых идентификатор темы не несёт: их собирает слияние подтверждённых
 * правок аналитика (`finding-approved-…`), а ярлык там взят из каталога.
 *
 * Тема, которую не назвал ни один из двух способов, считается **обвиняющей**:
 * `isAccusingTheme(undefined)` строг намеренно.
 */
function themeDefOfFinding(f: Finding): ThemeDef | undefined {
  const themes = getFindingThemes();
  const byId = themes
    .filter((t) => f.findingId.startsWith(`finding-${t.themeId}-`))
    // Идентификатор темы может оказаться началом другого («foo» и «foo-bar»):
    // побеждает самое длинное совпадение, иначе ответ зависел бы от порядка.
    .sort((a, b) => b.themeId.length - a.themeId.length)[0];
  return byId ?? themes.find((t) => t.label === f.theme);
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
  const scale = regionalThemeScaleLine(f, scoped);
  const frs = f.regions ?? [];
  const exclusive =
    frs.length > 0 && frs.every((fr) => regions.some((r) => regionMatches(r, fr)));
  /*
   * Находка целиком своя — цитаты пересобирать не из чего, а счёт всё равно
   * пересчитывается.
   *
   * Глобальная строка приезжала сюда дословно, и на соседних листах одного
   * раздела стояли «Всего по теме: 3 материала» и «Всего по теме: 4 материала,
   * с негативным контекстом — 1»: разная формулировка и разная единица счёта
   * (материал против наблюдения). Отсутствие хвоста при этом читается как
   * «негативных нет», а значит, страница отвечала на один вопрос дважды.
   */
  if (exclusive) return themedClaim(withThemeScaleLine(f, scale));

  const themeDef = themeDefOfFinding(f);

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
    // Регион страницы, а не «регион не чужой»: запись без региона (карточка
    // комплаенс-базы, неотнесённый пример) не найдена в этом регионе и
    // цитируется там, где живёт. Тот же порог стоит в счёте темы.
    if (!regions.some((r) => regionMatches(r, e.region))) continue;
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
    // Обвиняющая тема не цитирует материал, чью страницу прочитали и признали
    // нейтральной. Тему назначает словарь ключевых слов по заголовку, и «суд» в
    // заголовке телеинтервью тянет его в криминальный блок; решение же вынесено
    // по тексту страницы и знает, что там на самом деле.
    //
    // Условие «только для тем не ниже среднего» здесь стояло и было ошибкой:
    // «Финансовые претензии / долговые споры» — тема низкая, и на стр. 52
    // отчёта Кремлёва она процитировала пост о партнёрстве со страницы,
    // прочитанной и признанной нейтральной. Причина защиты от уровня риска не
    // зависит ни в чём — а вот от того, обвиняет тема или описывает, зависит:
    // деловому профилю и публичной экспозиции нейтральная публикация и есть
    // законное доказательство.
    //
    // Предикат общий с аналитикой: там этот же ответ решает, берёт ли тема
    // материал в состав, счёт и уровень. Раз он один, то и правка аналитика,
    // стоящая выше вердикта модели, действует на обеих поверхностях.
    if (
      isAccusingTheme(themeDef) &&
      pageReadAsFavourable({ tone: e.readVerdictTone, analystDecision: e.analystDecision })
    ) {
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
  /*
   * Присказка «почему это важно» — та, что закреплена за темой, а не та, что
   * начинается с угаданного слова.
   *
   * Отбор регуляркой по началу строки терял её у двух тем из восьми: «Для KYC
   * это типичный запрос…» (офшоры) и «Для международных проверок…» (линия
   * безопасности) в перечень начал не попадали, и страница офшоров у банка
   * оставалась без единственного предложения о том, зачем ей эта тема.
   *
   * Печатается только если она была и в глобальном утверждении: региональная
   * пересборка переписывает найденное, а не добавляет своё. Но спрашивается это
   * **у разметки сборщика, а не у текста присказки**: синтезатор дописывает
   * присказку каждому утверждению, которое собирает сам, вместе со строкой
   * счёта (`buildClientFacingClaim`), поэтому наличие счёта и есть наличие
   * присказки. Сравнение с самим текстом ломалось дважды: утверждение бывает
   * одним абзацем (тогда строки для сравнения нет), а справочник присказок
   * правится между сборкой отчёта и пересборкой деки (тогда в утверждении
   * лежит прежняя редакция) — и в обоих случаях присказка молча исчезала бы с
   * региональной страницы, оставаясь на исполнительной.
   */
  const why = SYNTHESIZED_CLAIM_RE.test(String(f.claim ?? ""))
    ? clientThemeWhy(themeDef?.themeId)
    : "";
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
    /*
     * Пустой ветке нечего цитировать — значит, в ней нет и обещания цитаты.
     *
     * Собирается она из разобранных частей, а не подстановкой в глобальный
     * текст. Подстановка правила только сегмент источников и оставляла на
     * региональной странице всё остальное: рамку «Найдены публикации по теме:»,
     * за которой ничего не следует, глобальные числа и — главное — сами цитаты
     * чужого региона, ради изгнания которых пересборка и заведена. Пока
     * нейтрально прочитанная страница цитировалась, ветка была редкой и это не
     * стреляло.
     */
    const safeDomains = clientSafeDomains(domains);
    // Площадок в регионе нет — значит, и числа нет: «источники не выделены» и
    // следом «всего по теме 2 материала» — два спорящих предложения, и второе
    // отправляет читателя искать материалы, которых страница назвать не может.
    const sourceSegment = safeDomains.length
      ? `По теме в источниках ${enumerateRu(safeDomains)}; отдельный заголовок с сутью риска в выдаче не выделен — сверить первоисточники.`
      : "По этой теме источники в данном регионе не выделены — см. другие разделы отчёта.";
    claim = [sourceSegment, safeDomains.length ? scale : "", why]
      .filter(Boolean)
      .join("\n");
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
    /*
     * B.3 — кросс-региональная находка несёт домены всего корпуса; страница
     * региона называет источниками только то, что найдено в её области.
     *
     * Условие строгое — «регион свой», а не «регион не чужой». Мягкое пускало
     * сюда запись без региона (проверка Википедии, карточка базы с адресом), и
     * лист отвечал на один вопрос дважды: подвал называл материал источником
     * этого региона, а блок темы над ним — `localizedThemedClaim` на том же
     * слайде — его же не считал и не цитировал. Область при этом шире одного
     * кода: у ОАЭ это «UAE / INTERNATIONAL / GLOBAL», и материал такой области
     * остаётся своим.
     */
    for (const e of Object.values(scoped.evidenceIndex)) {
      if (!e.domain) continue;
      if (!scopeRegions.some((r) => regionMatches(r, e.region))) continue;
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
 * Название региона для клиентского текста; незнакомый код остаётся как есть.
 *
 * Незнакомый контур — это не «нет региона»: назвать его нечем, но умолчать о
 * нём значило бы потерять материалы, которые в нём собраны.
 */
export function regionClientLabel(region: string): string {
  const raw = String(region ?? "").trim();
  return REGION_CLIENT_LABELS[raw.toUpperCase()] ?? raw;
}

/**
 * Названия стран по-русски — одно место на всю деку.
 *
 * Комплаенс-провайдеры отдают страну кодом ISO 3166-1 («ru», «ch»), и на живом
 * прогоне 20.08 (страница 61) банк читал «Страны в записи: ru, ch». Детектор
 * внутренних кодов такой код не ловит: подчёркиваний в нём нет.
 *
 * Своего словаря стран здесь нет намеренно: полный ICU в среде уже знает все
 * названия, а собственный список устарел бы на первой же смене состава.
 * Названия — часть клиентского текста, поэтому урезанный ICU (молча английские
 * названия) обязан ронять сборку: это закреплено тестом карточки.
 *
 * Английский состав нужен не для печати, а для разбора: провайдеры и ручной
 * импорт называют страну и словом тоже.
 */
const REGION_NAMES_RU = new Intl.DisplayNames(["ru"], { type: "region" });
const REGION_NAMES_EN = new Intl.DisplayNames(["en"], { type: "region" });

/** Название региона по коду; пусто — если ICU этот код не знает. */
function icuRegionName(names: Intl.DisplayNames, code: string): string {
  let name = "";
  try {
    name = names.of(code) ?? "";
  } catch {
    // Некорректный код (дефис, цифра, три буквы) — RangeError, а не название.
    return "";
  }
  // На неизвестном коде ICU возвращает сам код: «XX» на слайде — тот же мусор,
  // что и «xx».
  return name && name.toUpperCase() !== code.toUpperCase() ? name : "";
}

/**
 * Коды, которые ICU не знает, — дополнение к нему, а не второй словарь стран.
 *
 * Здесь только то, на чём `Intl.DisplayNames` бросает: собственные коды
 * территорий FollowTheMoney (их отдаёт OpenSanctions) и четырёхбуквенные коды
 * ISO 3166-3 для стран, которых больше нет. Полный список стран по-прежнему
 * берётся из ICU: дублировать его руками — заводить копию, которая разойдётся.
 *
 * Кода нет в этом списке — он свернётся в общую формулировку, и это безопасный
 * исход: назвать страну неверно хуже, чем сказать, что назвать её нечем.
 */
const EXTRA_TERRITORY_NAMES_RU: Record<string, string> = {
  "GB-ENG": "Англия",
  "GB-NIR": "Северная Ирландия",
  "GB-SCT": "Шотландия",
  "GB-WLS": "Уэльс",
  "SO-SOM": "Сомалиленд",
  "CY-TRNC": "Северный Кипр",
  "GE-AB": "Абхазия",
  "GE-OS": "Южная Осетия",
  "AZ-NK": "Нагорный Карабах",
  "MD-PMR": "Приднестровье",
  SUHH: "СССР",
  DDDE: "ГДР",
  YUCS: "Югославия",
  CSHH: "Чехословакия",
};

/**
 * Псевдорегионы ICU — не страны и в клиентский текст не идут.
 *
 * `ZZ` («неизвестный регион») особенно: это второе название того же, о чём
 * говорит общая формулировка ниже, и печатать два разных слова про одно
 * состояние нельзя.
 */
const ICU_PSEUDO_REGIONS = new Set(["ZZ", "XA", "XB"]);

/** Ключ поиска по названию: регистр и пробелы — не различие. */
function countryNameKey(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Обратный указатель «название → русское название», построенный из ICU.
 *
 * Нужен потому, что страну называют не только кодом: в записях провайдера и в
 * ручном импорте встречаются «Iran», «Cuba», «Germany», «россия». Пока их
 * разбирало правило «2–4 знака = код», «Iran» и «Chad» съедались общей
 * формулировкой — терялось сведение, которое провайдер назвал, причём ровно на
 * санкционно значимых странах.
 *
 * Указатель строится из самого ICU (все существующие alpha-2), а не руками:
 * своего списка названий в проекте по-прежнему нет. Считается один раз, лениво.
 */
let countryNameIndex: Map<string, string> | undefined;

function countryByName(): Map<string, string> {
  if (countryNameIndex) return countryNameIndex;
  const index = new Map<string, string>();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (ICU_PSEUDO_REGIONS.has(code)) continue;
      const ru = icuRegionName(REGION_NAMES_RU, code);
      if (!ru) continue;
      for (const key of [countryNameKey(ru), countryNameKey(icuRegionName(REGION_NAMES_EN, code))]) {
        // Первое название выигрывает: у одной страны бывает несколько кодов
        // («DE» и «DD»), и переписывать уже найденное нечем.
        if (key && !index.has(key)) index.set(key, ru);
      }
    }
  }
  countryNameIndex = index;
  return index;
}

/**
 * Короткий латинский токен — это код, а не название.
 *
 * Нужен только для значений, которые назвать не удалось: «Швеция» из ручного
 * импорта — уже клиентский текст и печатается дословно, а «RUS», «643», «q1»
 * или «xx-yyy» — машинный код, и печатать его нельзя. Дефисная форма — это
 * коды территорий FollowTheMoney: без неё `gb-sct` уходил на слайд дословно,
 * потому что под форму не подходил, а ICU на нём бросал.
 *
 * Трёхбуквенный alpha-3 («RUS», «CHE») остаётся нераспознанным осознанно.
 * Свести его к alpha-2 усечением нельзя: `CHN` → `CH` это Швейцария вместо
 * Китая, `ARE` → `AR` — Аргентина вместо ОАЭ, `IRL` → `IR` — Иран вместо
 * Ирландии. Таблицы alpha-3 в ICU нет, а руками это весь список стран заново.
 */
const COUNTRY_CODE_SHAPE = /^[A-Za-z0-9]{2,4}(?:-[A-Za-z0-9]{2,4})?$/u;

/** Страна есть, назвать её нечем — общая формулировка вместо кода. */
const COUNTRY_NOT_RECOGNIZED_RU = "страна не распознана";

/** Русское название одного значения; `undefined` — назвать нечем. */
function countryNameRu(raw: string): string | undefined {
  const upper = raw.toUpperCase();
  if (/^[A-Za-z]{2}$/u.test(raw) && !ICU_PSEUDO_REGIONS.has(upper)) {
    const icu = icuRegionName(REGION_NAMES_RU, upper);
    if (icu) return icu;
  }
  return EXTRA_TERRITORY_NAMES_RU[upper] ?? countryByName().get(countryNameKey(raw));
}

/**
 * Список стран записи для клиентского текста.
 *
 * Разбор идёт лестницей, и первый ответ выигрывает: код alpha-2 через ICU →
 * дополнение к ICU → название словом. Не разобрали и похоже на машинный код —
 * общая формулировка. Именно одна и без счёта: «ru» и «RUS» могут быть одной
 * страной, и число нераспознанных назвало бы две. Пустой список — пустой
 * результат: строки о странах в карточке тогда нет вовсе, потому что провайдер
 * о них не говорил.
 */
export function countryNamesRu(values: readonly string[]): string[] {
  const named: string[] = [];
  let hasUnrecognized = false;
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const name = countryNameRu(raw);
    if (name) {
      named.push(name);
    } else if (COUNTRY_CODE_SHAPE.test(raw)) {
      hasUnrecognized = true;
    } else {
      named.push(raw);
    }
  }
  const unique = [...new Set(named)];
  if (hasUnrecognized) unique.push(COUNTRY_NOT_RECOGNIZED_RU);
  return unique;
}

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
 * Печатается через `content.statusNote`: нарратив переписывает стадия 2 и
 * подгоняет по высоте рендерер, а статусная строка не уходит модели и рисуется
 * отдельно. Это единственное место, где фраза собирается.
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
  let excluded = 0;
  for (const regionKey of READ_SHARE_REGION_ORDER) {
    const b = ms.linkReadByRegion?.[regionKey];
    if (!b) continue;
    const denominator = readShareDenominator(b);
    if (denominator <= 0) continue;
    excluded += b.readOther;
    parts.push(
      `${regionClientLabel(regionKey)} — ${readSharePercent(
        b.adverseRead,
        denominator
      )}% (${b.adverseRead} из ${denominator})`
    );
  }
  if (parts.length === 0) return undefined;
  const head = `Негатив среди прочитанных страниц: ${parts.join(", ")}.`;
  /*
   * Исключённые страницы названы теми же словами, что на странице региона.
   *
   * Знаменатель — прочитанные минус признанные чужими, и страница региона это
   * говорит. Строка резюме молчала: на живом отчёте 21.08 читатель складывал
   * «51» и «28», получал 79 при 80 прочитанных и не находил объяснения. Числа
   * были верны, необъяснённой была разница — а необъяснённое число в отчёте
   * для банка читается как ошибка (пункт CS).
   */
  return excluded > 0
    ? `${head} Страницы о других людях (${excluded}) в долю не входят.`
    : head;
}

/**
 * Запрос в сравнимом виде: регистр и лишние пробелы — свойства написания.
 *
 * Тот же ответ, что уже дан на уровне ключей наблюдений (`norm()` слияния и
 * `compositeObservationKey`): там запрос давно приводится к нижнему регистру, а
 * дека сравнивала строки как есть. На прогоне 76 это дало один дефект с двумя
 * противоположными исходами: в ОАЭ запрос таблицы совпал со строкой
 * обогатителя посимвольно и впустил его нумерацию, а в России «Рашников Виктор
 * Филиппович» не совпал с «рашников виктор филиппович» — и материалы того же
 * запроса в таблицу не вошли.
 */
export function normalizeSerpQuery(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

/** Один ли это запрос — независимо от написания. */
export function sameSerpQuery(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeSerpQuery(a);
  return left.length > 0 && left === normalizeSerpQuery(b);
}

/**
 * Печатная форма запроса: самое частое написание, при равенстве — по алфавиту.
 *
 * Отчёт обязан быть воспроизводимым: два прогона на одних данных дают одни
 * слова, поэтому «первое попавшееся написание» здесь не годится.
 */
export function serpQueryDisplayForm(spellings: string[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of spellings) {
    // Двойной пробел внутри запроса — не другое написание, а мусор: печатать
    // его клиенту незачем, а регистр сохраняется, он часть написания.
    const q = String(raw ?? "").trim().replace(/\s+/gu, " ");
    if (!q) continue;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")
  );
  return sorted.length > 0 ? sorted[0]![0] : null;
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
 *
 * Отдельно от фразы, потому что решать «печатать ли справку» надо по составу
 * набора: перечень из одного запроса, уже названного заголовком таблицы,
 * ничего не добавляет.
 */
export function subjectQueries(scoped: ScopedFragmentInput, limit = 5): string[] {
  // Написания одного запроса — один запрос: иначе строка печатала «Рашников
  // Виктор Филиппович» и «рашников виктор филиппович» как два разных.
  const spellingsByQuery = new Map<string, string[]>();
  for (const e of Object.values(scoped.evidenceIndex)) {
    const q = String(e.query ?? "").trim();
    if (!q) continue;
    if (e.queryPurpose && e.queryPurpose !== "subject_lookup") continue;
    const key = normalizeSerpQuery(q);
    const spellings = spellingsByQuery.get(key) ?? [];
    spellings.push(q);
    spellingsByQuery.set(key, spellings);
  }
  return [...spellingsByQuery.values()]
    .map((spellings) => ({ display: serpQueryDisplayForm(spellings)!, count: spellings.length }))
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display, "ru"))
    .slice(0, limit)
    .map((q) => q.display);
}

/**
 * Общая приставка набора запросов: сам запрос-основа и хвосты остальных.
 *
 * Живой набор — это имя субъекта и подсказки поисковика, к которым имя
 * дописано **в начало**, поэтому «имя + слово» и есть типичный случай.
 *
 * Условия ровно два, и оба про прослеживаемость, а не про красоту:
 *
 *   - приставка ищется **по словам и только с начала строки**. Подстрочное
 *     совпадение запрещено: у подсказки «биография глинка сергей михайлович»
 *     имя стоит внутри, и «он же с добавлением «биография»» описало бы запрос,
 *     которого никто не отправлял;
 *   - основа обязана сама быть одним из запросов набора. Иначе фраза назвала бы
 *     запросом строку, которой не было.
 *
 * Не выполнилось — ответа нет, и справка печатает прежний перечень целиком.
 */
function commonQueryPrefix(
  queries: string[]
): { base: string; tails: string[] } | undefined {
  if (queries.length < 2) return undefined;
  const wordsOf = (q: string): string[] => q.trim().split(/\s+/u).filter(Boolean);
  for (const base of queries) {
    const baseWords = wordsOf(base).map((w) => w.toLowerCase());
    if (baseWords.length === 0) continue;
    const tails: string[] = [];
    for (const q of queries) {
      if (q === base) continue;
      const qWords = wordsOf(q);
      const starts =
        qWords.length > baseWords.length &&
        baseWords.every((w, i) => qWords[i]!.toLowerCase() === w);
      if (!starts) break;
      tails.push(qWords.slice(baseWords.length).join(" "));
    }
    if (tails.length === queries.length - 1) return { base, tails };
  }
  return undefined;
}

/**
 * Та же справка одной фразой.
 *
 * Общая часть называется один раз: имя субъекта входило сюда пять раз (плюс
 * шестой в лиде страницы), и справка занимала 199 знаков абзаца, у которого
 * запаса нет вовсе, — лист выдачи уходил на девятый кегль при соседних листах
 * деки в одиннадцатом. Содержание при этом сохраняется целиком: число запросов
 * настоящее, каждый хвост назван дословно.
 */
export function subjectQueriesLine(
  scoped: ScopedFragmentInput,
  limit = 5
): string | undefined {
  const queries = subjectQueries(scoped, limit);
  if (queries.length === 0) return undefined;
  const word = pluralRu(queries.length, "запросу", "запросам", "запросам");
  const lead = `Выдача проверена по ${queries.length} ${word}: `;
  const common = commonQueryPrefix(queries);
  if (common) {
    const tails = common.tails.map((t) => `«${t}»`).join(", ");
    return `${lead}«${common.base}» и он же с добавлением ${tails}.`;
  }
  return `${lead}${queries.map((q) => `«${q}»`).join(", ")}.`;
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

/*
 * Тексты страницы Википедии — по одному экземпляру на всех потребителей.
 *
 * Их читают два места: страницы `p13_ru_wikipedia` / `p29_uae_wikipedia`
 * (`fragment-builders/identity.ts`) и ключ `no-identity-data` ниже. Пока
 * страница писала свои формулировки, а ключ — свои, отчёт объяснял важность
 * Википедии и советовал клиенту разное на соседних листах.
 *
 * Длина каждого текста — не вкусовщина: пустое состояние рисуется карточками
 * `content_card`, а он при нехватке места уменьшает кегль и **молча**
 * отбрасывает предложения, без телеметрии и без красной приёмки. Потолки этой
 * страницы держат юнит-тесты (`wikipedia-methodology-page.test.ts`), а не
 * рендерер.
 */

/** Почему статья в Википедии важна сама по себе — независимо от того, есть она или нет. */
export const WIKIPEDIA_WHY_KNOWLEDGE_PANEL =
  "Статья в Википедии — опорный источник «официальной» биографии: её содержимое поисковые системы показывают в панелях знаний и используют в ответах ИИ, а СМИ и контрагенты сверяются с ней в первую очередь.";

/** Чем плохо отсутствие статьи. */
export const WIKIPEDIA_WHY_NO_ARTICLE =
  "Пока статьи нет, эту нишу занимают сторонние площадки, которые субъект не контролирует: первые страницы выдачи формируются случайными материалами, и авторитетной нейтральной страницы, задающей корректную биографию, в этом контуре нет.";

/**
 * Чем важна статья, принадлежность которой не подтверждена.
 *
 * Отдельный текст, а не «почему важна статья субъекта»: тот утверждает, что
 * читатель видит проверенную биографию проверяемого лица, — а мы как раз не
 * знаем, о ком статья. Опасность здесь другая и настоящая: панель знаний
 * покажет её на запрос об имени в любом случае.
 */
export const WIKIPEDIA_WHY_ARTICLE_NAME_MATCH =
  "Статья, найденная по имени субъекта, попадает в панели знаний и ответы ИИ независимо от того, о ком она написана: читатель, проверяющий субъекта, увидит её первой и примет изложенное за его биографию. Поэтому сначала нужно установить, кому статья посвящена.";

/** Чем важна уже существующая статья: её правит кто угодно. */
export const WIKIPEDIA_WHY_ARTICLE_EXISTS =
  "Содержимое статьи попадает в панели знаний и ответы ИИ и воспринимается читателем как проверенная биография. Править статью может любой участник Википедии, поэтому искажение или недоброжелательное изменение быстро тиражируется поисковыми системами.";

/** Статьи нет — предложить создать. */
export const WIKIPEDIA_ADVICE_CREATE =
  "Мы предлагаем рассмотреть создание нейтральной биографической статьи о проверяемом лице — по правилам Википедии, при соответствии критериям значимости и с опорой на независимые авторитетные источники.";

/** Статья есть и принадлежит субъекту — предложить контролировать содержимое. */
export const WIKIPEDIA_ADVICE_CONTROL =
  "Мы предлагаем контролировать корректность содержимого статьи: периодически сверять изложенные в ней факты и отслеживать историю правок, чтобы своевременно фиксировать искажения.";

/**
 * Статья с совпадающим именем есть, но принадлежность не подтверждена.
 *
 * Проверка Википедии сверяет имя, а не личность: тёзка проходит её насквозь
 * (на реальном прогоне так прошла «Глинка (дворянский род)»). Пока
 * принадлежность не подтверждена, рекомендация обязана быть двусторонней.
 */
export const WIKIPEDIA_ADVICE_CONFIRM_OWNERSHIP =
  "Мы предлагаем сначала подтвердить принадлежность найденной статьи проверяемому лицу; если статья о нём — контролировать корректность её содержимого, если о другом лице — рассмотреть создание отдельной нейтральной биографической статьи.";

/**
 * Подпись основного описания статьи.
 *
 * «Дословно» — не украшение: за этой строкой идёт текст самой статьи, а не наш
 * пересказ, и читатель обязан видеть разницу.
 */
export const WIKIPEDIA_ARTICLE_LEAD_PREFIX = "Начало статьи (дословно): ";

/** То же описание, когда неизвестно, о ком статья. */
export const WIKIPEDIA_ARTICLE_LEAD_PREFIX_UNCONFIRMED =
  "Начало статьи (дословно; принадлежность статьи проверяемому лицу не подтверждена): ";

/**
 * Метка второго и следующих листов лида.
 *
 * Лид биографии — 700–1500 знаков и разъезжается на несколько буллетов. Без
 * метки на каждом втором лист выглядит абзацем от лица отчёта, а стоит он
 * рядом со строками «Риск смешения с другим лицом»: читателю нечем отличить
 * цитату от нашего утверждения.
 */
export const WIKIPEDIA_ARTICLE_LEAD_PREFIX_CONTINUED = "Начало статьи (дословно), продолжение: ";

/**
 * Какая из записей проверки описывает статью, о которой говорит страница.
 *
 * Ответ один на построителя и на ворота: страница печатает найденную статью
 * (при нескольких языковых разделах — ту, где статья есть), и ворота обязаны
 * спрашивать о принадлежности **той же** записи. Пока ворота спрашивали «есть
 * ли среди записей слайда хоть одна подтверждённая», подтверждённая запись
 * «статьи нет» оправдывала бы фрагменты неподтверждённой найденной статьи.
 */
export function pickWikipediaCheckEntry<T extends { wikipediaExists?: boolean }>(
  entries: readonly T[]
): T | undefined {
  return entries.find((e) => e.wikipediaExists === true) ?? entries[0];
}

/** Метка фрагмента текста статьи: по ней его узнаёт и читатель, и валидация. */
export const WIKIPEDIA_FRAGMENT_CATEGORY_LABELS: Record<"negative" | "needs_update", string> = {
  negative: "Негативный фрагмент",
  needs_update: "Требует проверки",
};

/**
 * Что сделать с фрагментом — детерминированным шаблоном по категории.
 *
 * Писать за клиента новый текст статьи означало бы утверждать биографические
 * факты, которых нет ни в одном наблюдении: модель выбирает и называет
 * фрагменты, но рекомендацию формирует не она.
 */
export const WIKIPEDIA_FRAGMENT_RECOMMENDATIONS: Record<"negative" | "needs_update", string> = {
  negative:
    "Рекомендация: сверить формулировку с первоисточниками, на которые ссылается статья, " +
    "и отслеживать историю правок этого раздела.",
  needs_update:
    "Рекомендация: актуализировать сведения по правилам Википедии, опираясь на независимые " +
    "авторитетные источники.",
};

/** Результат проверки неизвестен — двусторонняя рекомендация. */
export const WIKIPEDIA_ADVICE_UNKNOWN =
  "Мы предлагаем проверить наличие статьи вручную: при отсутствии — рассмотреть создание нейтральной биографической статьи, при наличии — контролировать корректность её содержимого.";

/**
 * ORION-style client copy for surfaces with no collected material: what the
 * surface is, why it matters for the subject's reputation, and what to do.
 * Internal reason keys never leak into client text.
 */
export const COVERAGE_EMPTY_COPY: Record<
  string,
  {
    surface: string;
    measuredWhat: string;
    why: string;
    measuredCheck: string;
    /**
     * Слова частичного состояния: что именно проверено у одной поисковой
     * системы и что не проверялось у другой. Нужны там, где общая формулировка
     * была бы шире факта: по Google мы читаем разобранную выдачу, но не блок
     * AI Overview, и обещать его проверку нельзя.
     */
    partialMeasuredWhat?: string;
    partialNotCollectedWhat?: string;
  }
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
    why: WIKIPEDIA_WHY_KNOWLEDGE_PANEL,
    measuredCheck: WIKIPEDIA_ADVICE_UNKNOWN,
  },
  "no-ai-answers": {
    surface: "ai_answers",
    measuredWhat:
      "Ответы ИИ-поиска (AI Overview, нейро-ответы) по запросам о субъекте проверены: материалов нет — это результат проверки.",
    why: "Ответы ИИ всё чаще заменяют пользователю классическую выдачу: он получает готовый вывод о человеке, не открывая источники, поэтому их содержание критично для репутации.",
    measuredCheck:
      "Рекомендуем отслеживать появление ИИ-ответов при следующих обновлениях: они формируются на основе тех же источников, что и обычная выдача.",
    partialMeasuredWhat: "готового ответа по запросам о субъекте в разобранной выдаче нет",
    partialNotCollectedWhat: "нейро-ответы в этом прогоне не проверялись",
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

/**
 * Поисковые системы в предложном падеже: «Яндексе и Google».
 *
 * Имена берутся из того же словаря, что и охват аудита в резюме, — второй
 * список названий разошёлся бы с первым на следующей же правке.
 */
function enginesClause(engines: readonly string[] | undefined): string {
  const named = [...new Set(engines ?? [])]
    .sort((a, b) => SCOPE_ENGINE_ORDER.indexOf(a) - SCOPE_ENGINE_ORDER.indexOf(b))
    .map((e) => SCOPE_ENGINE_LABELS[e])
    .filter((x): x is string => Boolean(x));
  return named.length > 0 ? named.join(" и ") : "поисковых системах";
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

  if (kind === "MEASURED_PARTIAL") {
    const cause = (reasonLabel ?? "инструмент сбора не входил в состав прогона").trim();
    return {
      narrative:
        `В ${enginesClause(status?.measuredEngines)} проверка выполнена: ` +
        `${copy?.partialMeasuredWhat ?? "материалов нет"}. ` +
        `В ${enginesClause(status?.notCollectedEngines)} ` +
        `${copy?.partialNotCollectedWhat ?? "поверхность в этом прогоне не проверялась"}: ${cause}.`,
      bullets: [
        copy?.why ??
          "Непроверенная поверхность не даёт вывода ни о наличии материалов, ни об их отсутствии.",
        "Непроверенная поверхность — не то же самое, что проверенная и пустая: ответ может показываться пользователям поисковой системы.",
      ],
      whatToCheck:
        "Подключить сбор по непроверенным поисковым системам (инструмент провайдера или официальный API поисковой системы) и повторить проверку.",
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

/**
 * Строка, признанная чужой, печатается с пометкой.
 *
 * Панель воспроизводит то, что показывает поисковик, поэтому строку о другом
 * лице не прячут — её называют. Формулировка одна на все пути показа: буллеты
 * подсказок, связанных запросов и утверждения поверхностей.
 */
export function otherSubjectBulletText(text: string, decision: string | undefined): string {
  return decision === OTHER_SUBJECT_DECISION ? `Относится к другому лицу: ${text}` : text;
}

export function claimText(c: SurfaceClaim): string {
  return otherSubjectBulletText(c.text, c.subjectMatch);
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

/**
 * Уровень и вердикт становятся словом на клиентской шкале, и только там.
 * Построители печатают то, что она отдала, — своей таблицы у них нет.
 */
export { riskLabel, verdictClientLabel } from "../../client/risk-scale";

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
   * говорить, что на ней нашли. Заголовок не переопределяет только по-настоящему
   * пустая страница (`noUnderlyingData`): обещать вывод там, где данных нет,
   * нельзя. Страница, у которой не получилось превью, данные имеет — и вывод
   * печатает.
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
  /*
   * Картинки нет, а данные есть — заголовок-вывод остаётся.
   *
   * Пустая страница (`noUnderlyingData` выше) заголовок не переопределяет: там
   * обещать вывод нечем. Здесь другое состояние: строки нашли, их негатив
   * посчитан, не получилось только превью. Пока `title` сюда не передавался,
   * второй дизъюнкт условия у вызывающего (`shownOnGrid > 0 || adverseTotal >
   * 0`) был недостижим: всякий раз, когда он единственный истинный,
   * вычисленный заголовок молча отбрасывался, и самый заметный элемент
   * страницы молчал там, где новость тяжелее всего (пункт BJ).
   */
  return makeSlotSlide({
    slot: input.slot,
    sectionId: input.sectionId,
    ...(input.title ? { title: input.title } : {}),
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
  /** Строка выделена красным на панели — то, что видит читатель. */
  adverse: boolean;
  /**
   * Формулировка негативна, хотя рамку сняла принадлежность.
   *
   * Без него исключённая строка исчезла бы молча: у строки о другом лице
   * панель рамку не рисует, и по одному `adverse` не отличить нейтральную
   * подсказку от санкционной, снятой со счёта.
   */
  adverseWording?: boolean;
  decision?: string;
};

/** Решение subject-resolution, при котором строка не работает на профиль. */
export const OTHER_SUBJECT_DECISION = "OTHER_SUBJECT";

/**
 * Негатив, работающий на профиль субъекта: формулировка × принадлежность.
 *
 * Формулировку даёт панель (`adverse` — то, что выделено красным),
 * принадлежность — subject-resolution через `evidenceIndex`. В счёт входит их
 * произведение: санкционная подсказка о другом человеке напечатана, но профиль
 * субъекта ею не утяжеляется. Предикат один на все счётчики страницы — иначе
 * заголовок, статус и метрика разойдутся при первой же правке.
 *
 * На стороне деки это ещё и защита от устаревшего ассета: пересборка из
 * `gpt-copy` читает `visual-assets-by-slot.json` с диска, и строка может
 * приехать со старой красной рамкой.
 */
export function countsTowardSubjectNegative(row: {
  adverse: boolean;
  decision?: string;
}): boolean {
  return row.adverse && row.decision !== OTHER_SUBJECT_DECISION;
}

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
      adverseWording: row.adverse === true || row.adverseWording === true,
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
  /** Негативные строки, которые работают на профиль субъекта. */
  adverse: number;
  /** Негативные строки о другом лице — напечатаны, но в счёт не входят. */
  adverseOther: number;
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
    adverse: rows.filter(countsTowardSubjectNegative).length,
    adverseOther: rows.filter(
      (r) => (r.adverseWording ?? r.adverse) && r.decision === OTHER_SUBJECT_DECISION
    ).length,
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
 * Предложение об исключённых строках — одно на подсказки и связанные запросы.
 *
 * Исключение из счёта обязано быть названо словами: иначе строка про
 * санкционный список просто исчезает из чисел страницы, и читателю не отличить
 * «негатива нет» от «негатив есть, но не о проверяемом лице».
 */
export function otherSubjectExclusionSentence(excluded: number): string {
  if (excluded <= 0) return "";
  const noun = pluralRu(excluded, "строка", "строки", "строк");
  const verb = pluralRu(excluded, "относится", "относятся", "относятся");
  const counted = pluralRu(excluded, "входит", "входят", "входят");
  return `Ещё ${excluded} ${noun} с негативной формулировкой ${verb} к другому лицу и в счёт не ${counted}.`;
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
  /** Негативные строки о другом лице: напечатаны, но из счёта исключены. */
  excludedOtherSubject?: number;
  nounOne: string;
  nounFew: string;
  nounMany: string;
}): string {
  const noun = (n: number): string => pluralRu(n, input.nounOne, input.nounFew, input.nounMany);
  const excluded = input.excludedOtherSubject ?? 0;
  const tail = excluded > 0 ? ` ${otherSubjectExclusionSentence(excluded)}` : "";
  if (input.shownAdverse > 0) {
    return `На этой странице ${input.shownAdverse} ${noun(input.shownAdverse)} с негативной формулировкой — их видно до перехода к самим материалам, поэтому они формируют первое впечатление.${tail}`;
  }
  const hidden = input.collectedAdverse ?? 0;
  if (hidden > 0) {
    return `Среди показанных строк негативных формулировок нет; в собранном наборе — ${hidden} ${noun(hidden)}.${tail}`;
  }
  // Голое «негативных формулировок нет» рядом с напечатанной строкой про
  // санкционный список читается как враньё, поэтому отрицание называет лицо.
  if (excluded > 0) {
    return `Негативных формулировок о проверяемом лице на этой странице нет.${tail}`;
  }
  return "Строк с негативной формулировкой на этой странице нет.";
}

/**
 * Граница полосы адреса в таблице выдачи.
 *
 * Число выведено из ширины, а не подобрано: полоса идёт во всю ширину контента
 * (998 px по модели переноса рендерера), самый широкий знак 9 pt — 12,15 px,
 * значит в три нарисованные строки гарантированно укладываются 246 знаков тем
 * письмом, которое встречается в разобранных адресах (латиница, кириллица,
 * цифры, знаки URL). Взято 240 — тот же вывод с запасом на смену гарнитуры.
 * Оговорка честная: `№` (U+2116) шире принятого порога, 13,1 px, и 240 таких
 * знаков подряд дали бы четыре строки; в адресах такой строки не бывает.
 *
 * Три строки, а не две: чтобы гарантировать две, предел пришлось бы опустить
 * до 164 знаков, а в корпусе прогона 72 (243 уникальных `host+path`) длиннее
 * 163 знаков 16 адресов, и шесть из них — обычные читаемые адреса статей
 * (169…186). Резать их значит вернуть тот самый дефект, ради которого адрес и
 * уехал из колонки.
 *
 * На корпусе ветка среза срабатывает семь раз из 243 — на процентно
 * закодированных путях facebook, instagram и kiosk-31 (280…864 знака). Ни один
 * из них сегодня не доезжает до печатаемых таблиц, поэтому в деке обрезанных
 * нет; обещание полосы — про то, что печатается, а не про всё мыслимое.
 *
 * Прежние 62 знака были шириной **колонки**, и обрезанный адрес не
 * открывался — 17 строк из 50 на эталоне, 60 из 60 в золотом кейсе.
 */
const ADDRESS_BAND_MAX_CHARS = 240;

/**
 * Разбор и печать адреса живут в `client/client-address.ts` — их видит и
 * аналитика, а сюда ей ходить нельзя. Реэкспорта здесь нет: у вопроса «как
 * выглядит адрес» один ответ и одно место.
 */

/**
 * Адрес для полосы под строкой таблицы: тот же разбор, та же политика печати.
 *
 * Отбор демо-имён здесь не делается намеренно: строки таблицы отфильтрованы
 * выше по течению, а полоса обязана что-то напечатать. Фраза «Почему выделено»
 * и предложения о конкретной статье пользуются `clientAddress`, у которого
 * политика строже — там адрес стоит рядом с утверждением о лице.
 */
export function clientLink(
  url: string | undefined,
  domain: string | undefined,
  maxChars = ADDRESS_BAND_MAX_CHARS
): string {
  const raw = String(url ?? "").trim();
  if (!raw) return domain ?? "—";
  const parts = parseClientAddress(raw);
  // Не публичная схема — не адрес: `arsenkin://suggestion/17` открыть нельзя,
  // и клиенту он читается внутренним кодом. Называется площадка, если она
  // известна. Тот же ответ даёт `clientAddress`, возвращая здесь `undefined`.
  if (!parts) return domain ?? "—";
  const text = `${parts.host}${parts.path}`;
  if (text.length <= maxChars) return text;
  /*
   * В полосу целиком не влез — сначала снимаем строку параметров, и только
   * потом режем.
   *
   * Обрезанный адрес не открывается: `tadviser.ru/…/Персона:Глинка?shem=r…`
   * хуже, чем тот же адрес без параметров, который открывается и ведёт на ту
   * же страницу. Порядок именно такой: параметры нужны там, где без них
   * страницы нет (`youtube.com/watch?v=…`), а такие адреса коротки и в полосу
   * помещаются.
   */
  const withoutQuery = `${parts.host}${parts.path.replace(/[?#].*$/u, "")}`;
  if (withoutQuery.length <= maxChars) return withoutQuery;
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Почему страницу не прочитали — клиентскими словами.
 *
 * Машинный код решения (`blocked`, `not_found`) клиенту не показывается, а
 * перевод живёт одной функцией: три места, переводившие причины по-своему,
 * уже расходились в формулировках на соседних страницах.
 */
function readFailureWords(reason: string | undefined): string {
  switch (String(reason ?? "")) {
    case "blocked":
      return "доступ закрыт";
    case "not_found":
      return "страница не найдена";
    case "timeout":
      return "страница не ответила вовремя";
    case "empty_text":
      return "на странице нет читаемого текста";
    case "analysis_failed":
      return "текст получен, но разбор не состоялся";
    case "not_fetched":
      return "страница не запрашивалась";
    default:
      return "причина не установлена";
  }
}

/** Фраза «Почему выделено» в двух формах: для узкой колонки и целиком. */
export type HighlightPhrase = {
  /** Форма для боковой панели: помещается в её бюджет знаков. */
  sidebar: string;
  /** Форма целиком — с полной цитатой и полным адресом. */
  full: string;
  /** Адрес наблюдения в клиентской форме, если он известен. */
  link?: string;
  /** Адрес уцелел в сайдбарной форме. */
  sidebarHasLink: boolean;
  /** Сайдбарная форма ничего не потеряла — продолжение этой строке не нужно. */
  sidebarComplete: boolean;
  /** Страница прочитана: у решения по ней есть сюжет. */
  read: boolean;
};

/** Предложения текста — по границе, а не по знакам. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * «Почему выделено» — словами прочитанной страницы.
 *
 * Прежде под выделенным результатом стояло перечисление «рубрика — домен;
 * уровень: высокий»: три служебных слова вместо ответа на вопрос, что на
 * странице написано. Ответ уже куплен раньше по конвейеру — сюжет одной
 * фразой, дословная цитата с аудитом и адрес наблюдения, — поэтому фраза
 * собирается детерминированно и прослеживается до URL. Модель на сборке деки
 * её не пишет и не правит.
 *
 * Непрочитанная страница прочитанной не притворяется: у неё нет ни сюжета, ни
 * цитаты, и фраза называет словарную рубрику и причину непрочтения. Домен
 * обязателен в обеих ветках и берётся из доказательств самой строки — домен,
 * добытый другим способом, роняет обязательную секцию воротами области.
 */
export function highlightPhrase(input: {
  row: VisibleAssetItem;
  evidence: ScopedEvidenceIndex;
  /**
   * Находка, которой принадлежит строка, если она с ней сопоставлена.
   *
   * Отвечает сразу на два вопроса и потому передаётся целиком: какой рубрикой
   * назвать непрочитанную страницу и учтён ли уже материал в находках отчёта.
   * Находки знает область фрагмента, а не индекс доказательств, — поэтому
   * сопоставление делает вызывающий.
   */
  finding?: Finding;
  /** Ёмкость узкой колонки; по умолчанию — та, что рисует рендерер. */
  budget?: number;
}): HighlightPhrase {
  const e = input.evidence[input.row.ref];
  const budget = input.budget ?? SIDEBAR_HIGHLIGHT_BUDGET;
  /*
   * Источник называется, если его можно назвать, — и не называется иначе.
   *
   * Пропускать такую строку нельзя: рамку на снимке ставит классификатор, до
   * отбора имён ему дела нет, и страница выходила с тремя красными рамками при
   * подписи «выделено: 2». Число, не сходящееся с картинкой, читатель замечает
   * раньше любой ошибки в формулировке. Прочерк вместо имени тоже не годится —
   * это сломанный текст, — поэтому у безымянной строки имени просто нет, а всё
   * остальное во фразе остаётся.
   *
   * Причин безымянности две: имя демонстрационных данных (в отчёт не попадает
   * ни под каким видом) и адрес, который не разбирается в домен вовсе.
   */
  const domain = clientSafeDomain(e?.domain ?? input.row.domain);
  // Адрес печатается целиком: обрезанный не открывается, а фраза заводится
  // ровно ради того, чтобы утверждение можно было проверить по первоисточнику.
  // Не поместился в узкую колонку — уйдёт на продолжение, но не пропадёт.
  const link = clientAddress(e?.url ?? input.row.url);
  const linkText = clientAddressText(e?.url ?? input.row.url);

  // Непрочитанная страница решения не приносит: сюжет и цитата в артефакте
  // могли остаться от заголовка выдачи, но выдавать их за содержимое страницы,
  // которую не открывали, — сочинение.
  const readFailure = e?.readFailure ? String(e.readFailure) : undefined;
  const theme = readFailure ? "" : String(e?.verdictTheme ?? "").trim();
  const read = theme.length > 0;

  /*
   * Основание рамки называет тот, кто её поставил.
   *
   * Решение аналитика — сильнейший источник предиката, и объяснять поставленную
   * им рамку заголовком выдачи нельзя: у строки «Anders Holmström, CEO of
   * Nordkap Capital AB — fintech investor profile» негатива в заголовке нет
   * вовсе, словарь по нему молчит, и проверяющий, пойдя по единственному
   * предъявленному основанию, не найдёт там ничего. Вывод, который он сделает,
   * хуже правды: будто отчёт выделяет строки наугад. На самом деле решение
   * принял человек и отвечает за него.
   *
   * Тема материала остаётся, но **пояснением, а не заголовком**: «Деловой
   * профиль» первым словом под красной рамкой спорит с самой рамкой.
   *
   * Ветка одна на прочитанную и непрочитанную страницу: и там и там рамку
   * поставил человек. Нейтральная прочитанная страница, помеченная аналитиком,
   * иначе объясняла бы рамку собственным сюжетом и цитатой — тем самым, что
   * человек и переоценил.
   *
   * «Требует ручной проверки» такой строке не приписывается: аналитик её уже
   * посмотрел, он и есть ручная проверка.
   */
  if (e?.analystDecision === "ADVERSE") {
    const topic = String(
      input.finding?.theme ?? (readFailure ? "" : e?.verdictTheme) ?? input.row.themeTitle ?? ""
    ).trim();
    const text = [
      `Отмечено аналитиком${domain ? ` — ${domain}` : ""}`,
      topic ? `; тема материала — «${topic}»` : "",
      input.finding ? "; материал учтён в находках отчёта" : "",
      ".",
    ].join("");
    return { sidebar: text, full: text, sidebarHasLink: false, sidebarComplete: true, read };
  }

  if (!read) {
    const rubric = String(
      input.finding?.theme ?? input.row.themeTitle ?? "Потенциально нежелательный материал"
    ).trim();
    const why = readFailure
      ? `страница не прочитана: ${readFailureWords(readFailure)}`
      : "страница не читалась в этом прогоне";
    /*
     * Сопоставленная с находкой строка и строка, не сопоставленная ни с чем, —
     * разные состояния, и словами они разные. Прежде их различал «уровень:
     * высокий»; уровень отсюда ушёл (степень риска — язык находок и матрицы),
     * но само различие терять нельзя: иначе страница изображений говорит об
     * учтённом материале и о ничейном одинаково.
     */
    // Точка с запятой, а не тире: у «материал учтён» своё подлежащее, и через
    // тире оценка приравнивалась к материалу.
    const tail = input.finding
      ? "; материал учтён в находках отчёта"
      : " — требует ручной проверки";
    const head = `${rubric}${domain ? ` — ${domain}` : ""}; ${why}, оценка по заголовку выдачи${tail}.`;
    /*
     * Адрес называет материал, а рубрика с доменом — нет.
     *
     * Два разных материала одного издания под одной рубрикой давали дословно
     * одинаковое предложение. Пока они стояли на разных листах, читатель этого
     * не видел; стоило разбивке сдвинуться — и лист «почему выделено» напечатал
     * одну строку дважды подряд. Схлопывать такие фразы нельзя: каждая
     * объясняет свою рамку, и «выделено: 2» под одним объяснением — потеря
     * рамки. Различает их адрес: он у материалов разный всегда.
     *
     * Механизм тот же, что у прочитанной страницы, и это одно правило, а не
     * два: адрес живёт в полной форме, а из узкой колонки уступает место —
     * тогда строке нужен лист-продолжение, и он его получает.
     */
    const addr = linkText ? ` ${linkText}.` : "";
    /*
     * Адрес не уступает — уступает объяснение вокруг него.
     *
     * Первая редакция делала наоборот: не поместился в узкую колонку — адрес
     * уходил целиком, а строке полагался лист-продолжение. У снимка выдачи
     * продолжение есть, у страниц изображений и подсказок его нет, и там
     * материал снова оставался неназванным: на эталоне 72 так вышло у двух
     * фраз из девяти (адреса в 183 и 191 знак).
     *
     * Порядок уступок — тот же, что у прочитанной страницы («цитата уступает
     * адресу: без адреса утверждение нечем проверить»): первым уходит домен —
     * его повторяет сам адрес, — затем «оценка по заголовку выдачи», затем
     * хвост про находку, затем рубрика. Непрочтение не уступает никогда:
     * страница, которую не открывали, не должна выглядеть проверенной.
     *
     * Сокращать адрес нельзя: обрезанная строка перестанет совпадать с
     * напечатанными адресами страницы, уйдёт в общий разбор доменов, и сегмент
     * пути прочитается как чужой домен — то есть обязательная секция получит
     * отказ. Поэтому уступает текст, а не адрес.
     */
    const ladder = [
      head,
      `${rubric}; ${why}, оценка по заголовку выдачи${tail}.`,
      `${rubric}; ${why}${tail}.`,
      `${rubric}; ${why}.`,
      `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
    ];
    const full = `${head}${addr}`;
    // Адрес длиннее любой ступени — случай, которого на обоих корпусах нет:
    // тогда узкая колонка остаётся без него, и полная форма уходит на
    // лист-продолжение, как у прочитанной страницы.
    const sidebar =
      ladder.map((step) => `${step}${addr}`).find((text) => text.length <= budget) ??
      ladder.find((step) => step.length <= budget) ??
      ladder[ladder.length - 1]!;
    return {
      sidebar,
      full,
      link,
      sidebarHasLink: Boolean(linkText) && sidebar.includes(linkText!),
      sidebarComplete: sidebar === full,
      read: false,
    };
  }

  const head = domain ? `На странице ${domain} — ${theme}` : `Выделенный результат — ${theme}`;
  const caveat =
    e?.verdictSubjectMatch === "likely"
      ? "Принадлежность материала проверяемому лицу требует подтверждения."
      : undefined;
  const quoteSentences = sentencesOf(String(e?.pageQuote ?? "").trim());
  /*
   * Цитата с многоточием в боковую панель не идёт.
   *
   * Панель многоточий не допускает (контракт клиентского текста), и подгонка
   * под неё заменяет «…» точкой — прямо внутри кавычек: «Совет ЕС постановил.
   * активы заморожены». Дословная цитата перестаёт быть дословной, а править
   * её нам нельзя. Значит, в узкой колонке такой цитаты нет вовсе, а целиком
   * она печатается на продолжении.
   */
  const sidebarQuoteLimit = quoteSentences.findIndex((q) => /\.\.\.|…/u.test(q));
  const maxSidebarQuote =
    sidebarQuoteLimit === -1 ? quoteSentences.length : sidebarQuoteLimit;

  const compose = (quoteCount: number, withLink: boolean): string => {
    const quote = quoteSentences.slice(0, quoteCount).join(" ");
    // Точка внутри кавычек — точка цитаты; своей мы её не дублируем.
    const opening = quote
      ? `${head}: «${quote}»${/[.!?…]$/u.test(quote) ? "" : "."}`
      : `${head}.`;
    // Адрес в скобках, точка снаружи: `lenta.ru/tags/persons/prohorov-mihail.`
    // не читается — то ли точка часть адреса, то ли конец предложения.
    return [opening, caveat, withLink && linkText ? `${linkText}.` : undefined]
      .filter(Boolean)
      .join(" ");
  };

  const full = compose(quoteSentences.length, true);
  // Цитата уступает адресу: без адреса утверждение нечем проверить, а
  // укороченная по границе предложения цитата остаётся дословной.
  let sidebar: string | undefined;
  let sidebarHasLink = false;
  for (let n = maxSidebarQuote; n >= 0; n -= 1) {
    const candidate = compose(n, true);
    if (candidate.length <= budget) {
      sidebar = candidate;
      sidebarHasLink = Boolean(link);
      break;
    }
  }
  if (sidebar === undefined) {
    for (let n = maxSidebarQuote; n >= 0; n -= 1) {
      const candidate = compose(n, false);
      if (candidate.length <= budget || n === 0) {
        sidebar = candidate;
        break;
      }
    }
  }
  return {
    sidebar: sidebar ?? full,
    full,
    link,
    sidebarHasLink,
    sidebarComplete: (sidebar ?? full) === full,
    read: true,
  };
}

/** Что страница знает о своих выделенных строках — одним разбором. */
export type AdverseVisualSidebar = {
  visibleRows: VisibleAssetItem[];
  adverseRows: VisibleAssetItem[];
  gridRefs: string[];
  explanations: NonNullable<SlideBody["highlightExplanations"]>;
  /** Фразы целиком, в порядке объяснений, — материал слайда-продолжения. */
  phrases: HighlightPhrase[];
  explainedFindings: Finding[];
  explainedFindingIds: string[];
  explainedDomains: string[];
  explainedRefs: string[];
};

/**
 * Объяснения выделенных строк одной привязанной картинки.
 *
 * Один разбор на все поверхности: снимок выдачи, панель подсказок и сетка
 * изображений печатали одну и ту же фразу двумя построителями, и это была
 * готовая точка расхождения — на снимке фраза говорила «выделенный результат»,
 * на панели «изображение ведёт на», а уровень риска в обеих был служебным
 * словом вместо содержания страницы.
 */
export function adverseVisualSidebar(
  slotId: string,
  extras: FragmentExtras,
  scoped: ScopedFragmentInput
): AdverseVisualSidebar {
  const visibleRows = (extras.visualAssets?.[slotId] ?? []).flatMap((a) => a.visibleItems ?? []);
  /*
   * Объяснение — на каждую нарисованную рамку, и считает их не дека.
   *
   * Ключ дедупликации был `находка|домен`, а сопоставление строки с находкой
   * идёт **в том числе по домену**: для двух видимых строк одного источника
   * совпадение ключа было правилом, а не совпадением. Выходило три рамки на
   * картинке и два объяснения под ней, причём схлопнутая строка не попадала и
   * на слайд-продолжение — требование «под каждым выделенным результатом
   * фраза» для неё не выполнялось (пункт BO).
   *
   * Сводить строки по материалу здесь **нельзя**, хотя соблазн есть: разбор
   * обслуживает три поверхности сразу и не знает, чем на каждой рисуется рамка.
   * Один материал занимает две строки снимка законно — колонки Яндекса и Google
   * показывают выдачу, а не список материалов, — и две плитки сетки законно
   * ведут на одну статью. Сведение по материалу отняло бы у второй рамки
   * объяснение, а у подписи — единицу счёта: «выделено красным: 1» под двумя
   * красными плитками. Сводит тот, кто выбирает строки для показа
   * (`selectVisibleObservationsForEngine` и соседи в `canonical-visual-assets`),
   * — там единица рисования известна.
   *
   * Осталась одна защита — от одной и той же строки, попавшей в видимые дважды:
   * это уже не два выделенных результата, а один.
   */
  const seen = new Set<string>();
  const adverseRows = visibleRows.filter((v) => {
    if (!v.adverse || seen.has(v.ref)) return false;
    seen.add(v.ref);
    return true;
  });
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const phrases: HighlightPhrase[] = [];
  const explainedFindings: Finding[] = [];
  const explainedDomains: string[] = [];
  const explainedRefs: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const e = scoped.evidenceIndex[row.ref];
    const domain = clientSafeDomain(e?.domain ?? row.domain);
    const phrase = highlightPhrase({ row, evidence: scoped.evidenceIndex, finding: f });
    phrases.push(phrase);
    explanations.push({
      clientReason: clampClientText(phrase.sidebar, 300),
      frameTone: "red" as const,
    });
    if (f && !explainedFindings.some((x) => x.findingId === f.findingId)) explainedFindings.push(f);
    // Демо-домен не называется клиенту даже как подпись к снимку.
    if (domain && !explainedDomains.includes(domain)) explainedDomains.push(domain);
    if (e) explainedRefs.push(row.ref);
  }
  const gridRefs = visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r]));
  return {
    visibleRows,
    adverseRows,
    gridRefs,
    explanations,
    phrases,
    explainedFindings,
    explainedFindingIds: explainedFindings.map((f) => f.findingId),
    explainedDomains,
    explainedRefs,
  };
}
