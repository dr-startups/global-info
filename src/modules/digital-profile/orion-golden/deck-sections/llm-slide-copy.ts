/**
 * GPT stage 2 — per-slide client copy.
 *
 * After the deterministic builders produce structurally valid SectionPacks,
 * this stage asks the model to rewrite the CLIENT TEXT of every analytical
 * slide (narrative, «что обнаружено», «почему важно», «что проверить»,
 * bullets) in detailed client language: explain why each signal is risky and
 * what to do about it. The model receives the fragment's own scoped findings,
 * the deterministic draft and the holistic case analysis (stage 1) — never
 * unrelated sections or raw datasets (one prompt per fragment, as designed in
 * prompts.ts).
 *
 * Fail-safe by construction:
 *  - every returned field passes budgets, internal-token and forbidden-token
 *    scans, and the domain gate (no domain the slide's own evidence does not
 *    carry) — a bad field is rejected individually;
 *  - the enhanced pack is re-validated by the section QA; if it fails, the
 *    deterministic pack is kept unchanged (per-fragment fallback);
 *  - any transport error keeps the deterministic pack. The GPT layer can only
 *    improve text, never block the report.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { FragmentKey, SectionPackV2, SlideContentContract } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import { normalizeEvidenceRef, type ScopedEvidenceIndex, type SubjectProfileInput } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { GptCaseAnalysis, GptJsonCaller } from "../gpt/gpt-case-analysis";
import { defaultGptCallQueueOptions, runGptCallQueue } from "../gpt/gpt-call-queue";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../client/client-text-sanitizer";
import {
  getClientTextFieldBudgets,
  matchInternalClientToken,
} from "../client/load-client-text-contract";
import { riskLevelRu, subjectMatchRu } from "../gpt/client-payload-labels";
import type { GptDeckComposition } from "./gpt-deck-composer";
import { reflowNarrativeParagraphs, reflowThemeBullet } from "./fragment-builders/shared";
import { isWeakExampleTitle } from "../analytics/finding-synthesizer";

/** v16 — PDF-49: never drop evidence quotes ending in «…Дерипаски». */
export const GPT_SLIDE_COPY_PROMPT_VERSION = "gpt-slide-copy-v16";

/** Mirrors section-validation budgets — from client-text-contract (§6.1). */
export const GPT_SLIDE_COPY_FIELD_BUDGETS = (() => {
  const b = getClientTextFieldBudgets();
  return {
    narrative: b.narrative,
    bullet: b.bullet,
    whatWasFound: b.whatWasFound,
    whyItMatters: b.whyItMatters,
    whatToCheck: b.whatToCheck,
  } as const;
})();

const TEXT_BUDGETS = GPT_SLIDE_COPY_FIELD_BUDGETS;

/** Prompt marker for offline smokes asserting §7.5 density instructions. */
export const GPT_SLIDE_COPY_DENSITY_MARKER = "заполняй ВСЕ поля черновика";

/** Prompt marker for the over-budget repair pass (PDF-31 B.1a). */
export const GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER =
  "сожми каждый переданный текст";

const DOMAIN_TOKEN_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu;

/**
 * Lenient per-slide schema (PDF-38 F.3): live model pads unchanged fields with
 * null / "" / empty arrays — same failure mode as the deck editor on report 32.
 * Strict zod previously turned whole RU_SUMMARY / UAE_SUMMARY / RU_SUGGESTIONS
 * responses into FALLBACK_ERROR «invalid response schema».
 */
const SlideOverrideLooseSchema = z.object({
  slideId: z.string().min(1),
  narrative: z.string().nullish(),
  bullets: z.array(z.string().nullish()).max(12).nullish(),
  whatWasFound: z.string().nullish(),
  whyItMatters: z.string().nullish(),
  whatToCheck: z.string().nullish(),
});

type SlideOverride = {
  slideId: string;
  narrative?: string;
  bullets?: string[];
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
};

function normalizeCopyScalar(value: string | null | undefined): string | undefined {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Fail-open parse: invalid entries dropped, valid slides kept. Accepts both
 * {slides:[...]} and a bare array. Returns null only when the payload has no
 * recognizable shape at all.
 */
export function parseFragmentCopyResponse(raw: unknown): {
  slides: SlideOverride[];
  droppedSlides: number;
} | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { slides?: unknown }).slides)
      ? ((raw as { slides: unknown[] }).slides)
      : null;
  if (!list) return null;

  const slides: SlideOverride[] = [];
  let droppedSlides = 0;
  for (const item of list.slice(0, 16)) {
    const parsed = SlideOverrideLooseSchema.safeParse(item);
    if (!parsed.success) {
      droppedSlides += 1;
      continue;
    }
    const s = parsed.data;
    const bullets = (s.bullets ?? [])
      .map((b) => (b ?? "").replace(/\r\n/gu, "\n").trim())
      .filter((b) => b.length > 0);
    const override: SlideOverride = {
      slideId: s.slideId,
      narrative: normalizeCopyScalar(s.narrative),
      bullets: bullets.length > 0 ? bullets : undefined,
      whatWasFound: normalizeCopyScalar(s.whatWasFound),
      whyItMatters: normalizeCopyScalar(s.whyItMatters),
      whatToCheck: normalizeCopyScalar(s.whatToCheck),
    };
    const hasContent =
      override.narrative !== undefined ||
      override.bullets !== undefined ||
      override.whatWasFound !== undefined ||
      override.whyItMatters !== undefined ||
      override.whatToCheck !== undefined;
    if (hasContent) slides.push(override);
  }
  return { slides, droppedSlides };
}

// ---------- PDF-31 B.1a — repair-retry for over-budget GPT fields ----------
//
// Before B.1a an over-budget field was rejected outright and the slide kept
// the deterministic draft — the model's richer text was lost entirely. Now
// the field gets ONE repair call («сожми, сохранив факты»); rejection happens
// only when the repaired text still violates the budget/token/domain gates.

type ScalarCopyField = "narrative" | "whatWasFound" | "whyItMatters" | "whatToCheck";

type OverBudgetItem = {
  slideId: string;
  field: ScalarCopyField | "bullets";
  /** Scalar field text (absent for bullets). */
  text?: string;
  /** Full bullet list (absent for scalar fields). */
  texts?: string[];
  /** Target length communicated to the model (below the validation budget). */
  maxChars: number;
};

const RepairResponseSchema = z.object({
  items: z
    .array(
      z.object({
        slideId: z.string().min(1),
        field: z.string().min(1),
        text: z.string().optional(),
        texts: z.array(z.string()).optional(),
      })
    )
    .max(64),
});

const REPAIR_INSTRUCTIONS = [
  `Ты — выпускающий редактор отчёта. Твоя задача — ${GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER} до maxChars символов, сохранив ВСЕ факты, числа, названия тем и домены источников.`,
  "Не добавляй новых фактов и доменов; не используй внутренние технические термины; пиши только по-русски.",
  "Каждый текст должен заканчиваться завершённым предложением с точкой — не обрывай мысль.",
  "Для элементов с полем texts верни массив той же длины: каждый пункт сжат до maxChars.",
  'Верни ТОЛЬКО JSON: {"items": [{"slideId": string, "field": string, "text": string | undefined, "texts": [string] | undefined}]}.',
].join(" ");

/** Margin below the validation budget so the compressed text passes cleanly. */
function repairTargetChars(budget: number): number {
  return Math.max(80, Math.floor(budget * 0.94));
}

function collectOverBudgetItems(
  overrides: SlideOverride[],
  knownIds: Set<string>
): OverBudgetItem[] {
  const items: OverBudgetItem[] = [];
  const scalarFields: ScalarCopyField[] = [
    "narrative",
    "whatWasFound",
    "whyItMatters",
    "whatToCheck",
  ];
  for (const o of overrides) {
    if (!knownIds.has(o.slideId)) continue;
    for (const field of scalarFields) {
      const value = o[field];
      if (value !== undefined && value.trim().length > TEXT_BUDGETS[field]) {
        items.push({
          slideId: o.slideId,
          field,
          text: value.trim(),
          maxChars: repairTargetChars(TEXT_BUDGETS[field]),
        });
      }
    }
    if (o.bullets && o.bullets.some((b) => b.trim().length > TEXT_BUDGETS.bullet)) {
      items.push({
        slideId: o.slideId,
        field: "bullets",
        texts: o.bullets.map((b) => b.trim()),
        maxChars: repairTargetChars(TEXT_BUDGETS.bullet),
      });
    }
  }
  return items;
}

/**
 * Merge repaired texts back into the overrides. Only fields that were sent
 * for repair are replaced, and only when the model actually shortened them
 * into the target; everything else keeps the original round-1 value (and is
 * later re-checked field-by-field in applyOverrides — safety is unchanged).
 */
function mergeRepairedFields(input: {
  overrides: SlideOverride[];
  requested: OverBudgetItem[];
  raw: unknown;
}): { overrides: SlideOverride[]; repairedFields: number } {
  const parsed = RepairResponseSchema.safeParse(input.raw);
  if (!parsed.success) return { overrides: input.overrides, repairedFields: 0 };

  const requestedKeys = new Map(
    input.requested.map((r) => [`${r.slideId}.${r.field}`, r])
  );
  const byId = new Map(input.overrides.map((o) => [o.slideId, { ...o }]));
  let repairedFields = 0;

  for (const item of parsed.data.items) {
    const req = requestedKeys.get(`${item.slideId}.${item.field}`);
    const target = byId.get(item.slideId);
    if (!req || !target) continue;
    if (req.field === "bullets") {
      const texts = (item.texts ?? []).map((t) => t.trim());
      if (
        texts.length > 0 &&
        texts.length === (req.texts?.length ?? 0) &&
        texts.every((t) => t.length > 0 && t.length <= TEXT_BUDGETS.bullet)
      ) {
        target.bullets = texts;
        repairedFields += 1;
      }
      continue;
    }
    const text = (item.text ?? "").trim();
    if (text.length > 0 && text.length <= TEXT_BUDGETS[req.field]) {
      target[req.field] = text;
      repairedFields += 1;
    }
  }
  return {
    overrides: input.overrides.map((o) => byId.get(o.slideId) ?? o),
    repairedFields,
  };
}

const COPY_INSTRUCTIONS = [
  "Твоя задача — переписать клиентский текст каждого переданного слайда лучше чернового варианта: подробным клиентским языком, без жаргона.",
  `Для страниц с данными ${GPT_SLIDE_COPY_DENSITY_MARKER} (narrative, whatWasFound, whyItMatters, whatToCheck, bullets) — не ограничивайся правкой одного поля, если остальные пустые или слишком короткие.`,
  "Для страниц с данными опирайся на конкретику из scoped findings и черновика: числа публикаций, домены источников, темы риска; не пиши общими фразами без опоры на переданные факты.",
  "Для каждого негативного или неоднозначного сигнала объясняй, ПОЧЕМУ он рискован (влияние на репутацию, сделки, банковские и партнёрские проверки), и давай конкретный совет, что с этой информацией делать.",
  "Опирайся только на переданные findings, claims и черновой текст; не добавляй новых фактов, имён, компаний и доменов.",
  "Используй переданный общий анализ кейса (caseAnalysis), чтобы все слайды говорили согласованными выводами.",
  "Не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider) и идентификаторы; не вставляй URL. Пиши только по-русски: не копируй в текст английские служебные слова и коды из данных.",
  "СТРОГО ЗАПРЕЩЕНО упоминать в клиентском тексте процесс подготовки отчёта и источник данных для тебя: слова «черновик», «черновой», «переданный фрагмент», «переданные данные», «scoped», «findings» и любые рассуждения о том, что в черновике чего-то нет или что страницу не следует чем-то наполнять. Клиент видит только выводы о субъекте и фактах, а не твою работу с материалами.",
  "Лимиты длины (верхняя граница с зазором до бюджета валидации): narrative до 1050, каждый bullet до 860, whatWasFound до 480, whyItMatters до 380, whatToCheck до 260.",
  "Нижняя граница для страниц с данными: каждый заполняемый текстовый блок — не короче ~40% своего бюджета (narrative ≳440, whatWasFound ≳200, whyItMatters ≳160, whatToCheck ≳110, bullet ≳340), если в черновике/findings есть материал для раскрытия.",
  "НИКОГДА не обрывай цитату или предложение посередине и не оставляй пустые ярлыки вроде «Что делать:.» / «Всего по теме:.» / «Где видно:.» / «контекстом —.». Либо полная фраза с числом/доменом, либо опусти строку целиком.",
  "Не используй заголовки/snippet, обрезанные поисковиком (хвост «…» / «из-за» / «Путина в» / «Дерипаски,»): либо полная закрытая формулировка, либо опусти цитату.",
  "Пиши КЛИЕНТСКИМ языком консультанта: тема риска → конкретика из заголовков статей → источник (домен) → коротко почему важно. Запрещены внутренние формулировки: «KPI», «тематический блок», «составной набор данных».",
  "СТРОГО: не заменяй конкретику общими фразами вроде «в выдаче устойчиво видны…», «заметны семейные связи», «формируют риск». Если в черновике есть строки ««заголовок» — источник domain.com», сохрани их (можно слегка отредактировать заголовок, но не выкидывай цитату и домен).",
  "ЗАПРЕЩЕНО оставлять или вставлять quotes, где внутри «ёлочек» только ФИО субъекта (например «Oleg V Deripaska», «Олег Дерипаска») или SEO-био без риска («биография, личная жизнь, фото»). Такие строки перепиши в СУТЬ риска по title/snippet/domains из findings (санкции, суд, долг, структура владения, связанное лицо) — без новых фактов.",
  "Для тематических bullets структура (каждый пункт — ОТДЕЛЬНАЯ строка через \\n, не склеивай в один абзац): 1) тема в «ёлочках», 2) короткая рамка «найдены публикации…» с якорем доменов при наличии, 3) 1–2 строки ««суть сюжета» — источник domain» (каждая цитата на своей строке), 4) «Всего по теме: N…», 5) одно предложение почему это важно / что делать.",
  "В narrative резюме: итог для проверки + 2–4 темы с опорой на конкретные сюжеты/источники из findings; без воды. Финал — что делать. Разбивай narrative на 2–3 абзаца через \\n — не пиши одной «простынёй».",
  "Не переписывай честные пустые состояния: если черновик говорит, что поверхность не собиралась / проверена и пуста / визуал недоступен — не подставляй findings с других поверхностей или регионов.",
  "Если передан compositionPlan — следуй ему: начни narrative с указанного смыслового акцента (storyAngle), раскрой в первую очередь темы из emphasisThemes (в заданном порядке) и упоминай прежде всего домены из keyDomains; план не добавляет новых фактов — используй только материал слайда.",
  'Верни ТОЛЬКО JSON: {"slides": [{"slideId": string, "narrative"?: string, "bullets"?: [string], "whatWasFound"?: string, "whyItMatters"?: string, "whatToCheck"?: string}]}. Не возвращай null, пустые строки и пустые массивы — неизменённое поле просто опускай. Опускай слайд целиком, если поверхность пустая и черновик честно сообщает об отсутствии данных.',
].join(" ");

/**
 * Honest coverage / visual fallbacks must keep deterministic copy.
 * GPT must not invent organic/AI content from sibling findings (§UAE SERP).
 */
export function isHonestEmptyStateSlide(slide: SlideContentContract): boolean {
  if (slide.templateId === "coverage-empty-state") return true;
  if (slide.emptyStateReason && slide.emptyStateReason.trim().length > 0) return true;
  return false;
}

/** Offline metric for §7.5 — field fill + length-vs-budget on data slides. */
export type SlideCopyDensityStats = {
  dataSlides: number;
  fieldsExpected: number;
  fieldsFilled: number;
  fieldFillRatio: number;
  avgLengthRatio: number;
};

export function measureSlideCopyDensity(
  slides: SlideContentContract[]
): SlideCopyDensityStats {
  const textFields = ["narrative", "whatWasFound", "whyItMatters", "whatToCheck"] as const;
  let dataSlides = 0;
  let fieldsExpected = 0;
  let fieldsFilled = 0;
  let lengthRatioSum = 0;
  let lengthSamples = 0;

  for (const s of slides) {
    if (s.isContinuation) continue;
    const hasData =
      (s.evidenceRefs?.length ?? 0) > 0 ||
      (s.findingIds?.length ?? 0) > 0 ||
      (s.content.table?.rows?.length ?? 0) > 0 ||
      (s.content.bullets?.length ?? 0) > 0 ||
      Boolean(s.content.narrative?.trim());
    if (!hasData) continue;
    dataSlides += 1;
    for (const field of textFields) {
      fieldsExpected += 1;
      const text = String(s.content[field] ?? "").trim();
      if (!text) continue;
      fieldsFilled += 1;
      lengthRatioSum += Math.min(1, text.length / TEXT_BUDGETS[field]);
      lengthSamples += 1;
    }
    fieldsExpected += 1;
    const bullets = (s.content.bullets ?? []).map((b) => b.trim()).filter(Boolean);
    if (bullets.length > 0) {
      fieldsFilled += 1;
      const joined = bullets.join(" ");
      lengthRatioSum += Math.min(1, joined.length / (TEXT_BUDGETS.bullet * Math.min(3, bullets.length)));
      lengthSamples += 1;
    }
  }

  return {
    dataSlides,
    fieldsExpected,
    fieldsFilled,
    fieldFillRatio: fieldsExpected > 0 ? fieldsFilled / fieldsExpected : 0,
    avgLengthRatio: lengthSamples > 0 ? lengthRatioSum / lengthSamples : 0,
  };
}

export type GptSlideCopyFragmentStatus =
  | "APPLIED"
  | "NO_CHANGES"
  | "SKIPPED_DETERMINISTIC"
  | "SKIPPED_EMPTY"
  | "SKIPPED_CACHED"
  | "FALLBACK_VALIDATION"
  | "FALLBACK_ERROR"
  | "FALLBACK_TIMEOUT";

export type GptSlideCopyFragmentReport = {
  fragmentKey: FragmentKey;
  status: GptSlideCopyFragmentStatus;
  appliedFields: number;
  rejectedFields: string[];
  /** PDF-31 B.1a: over-budget fields recovered by the repair pass. */
  repairedFields?: number;
  detail?: string;
};

export type GptSlideCopyReport = {
  version: "gpt-report-copy-v1";
  promptVersion: string;
  caseAnalysisUsed: boolean;
  /** Level 2: whether a validated composition plan shaped the prompts. */
  compositionUsed?: boolean;
  fragments: GptSlideCopyFragmentReport[];
};

/** Domains a slide is allowed to mention: its own evidence + existing draft. */
export function allowedDomainsForSlide(
  slide: SlideContentContract,
  evidenceIndex: ScopedEvidenceIndex
): Set<string> {
  const allowed = new Set<string>();
  const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
  for (const [ref, e] of Object.entries(evidenceIndex)) {
    if (e.domain && e.domain !== "—" && normRefs.has(normalizeEvidenceRef(ref))) {
      allowed.add(e.domain.toLowerCase());
    }
  }
  const draftTexts = [
    slide.title,
    slide.subtitle,
    slide.content.narrative,
    slide.content.whatWasFound,
    slide.content.whyItMatters,
    slide.content.whatToCheck,
    slide.content.sourceNote,
    ...(slide.content.bullets ?? []),
  ].filter((t): t is string => Boolean(t));
  for (const text of draftTexts) {
    for (const m of text.matchAll(DOMAIN_TOKEN_RE)) allowed.add(m[0].toLowerCase());
  }
  return allowed;
}

/** null when acceptable; otherwise a rejection reason. */
export function rejectReason(value: string, budget: number, allowedDomains: Set<string>): string | null {
  const text = value.trim();
  if (!text) return "empty";
  if (text.length > budget) return `over-budget:${text.length}>${budget}`;
  if (matchInternalClientToken(text)) return "internal-token";
  const forbidden = scanOrionGoldenClientTextForForbiddenTokens(text);
  if (forbidden.length > 0) return `forbidden:${forbidden[0]}`;
  for (const m of text.matchAll(DOMAIN_TOKEN_RE)) {
    if (!allowedDomains.has(m[0].toLowerCase())) return `foreign-domain:${m[0]}`;
  }
  return null;
}

/** PDF-44 H.3 — GPT bullets must not quote bare FIO / SEO-bio as “evidence”. */
export function rejectWeakQuoteLines(bullet: string): string | null {
  for (const m of bullet.matchAll(/«([^»]{3,120})»/gu)) {
    const inner = m[1]!;
    // Theme labels («Криминальные / …») are headers, not evidence quotes.
    if (/\//u.test(inner) || /материалы|сигналы|связи|профиль|экспозици/iu.test(inner)) {
      continue;
    }
    if (isWeakExampleTitle(inner)) return `weak-quote:${inner.slice(0, 40)}`;
  }
  return null;
}

/**
 * PDF-49 — GPT must not silently drop evidence quotes/domains already present
 * in the deterministic draft (e.g. currenttime.tv / ФБК line).
 */
export function rejectDroppedEvidenceQuotes(draft: string, next: string): string | null {
  const srcRe = /—\s*источник\s+([A-Za-z0-9][A-Za-z0-9.-]*)/giu;
  const quoteRe = /«[^»]{8,}»\s*—\s*источник\s+[A-Za-z0-9][A-Za-z0-9.-]*/giu;
  const draftDomains = [...String(draft ?? "").matchAll(srcRe)].map((m) => m[1]!.toLowerCase());
  if (draftDomains.length === 0) return null;
  const nextDomains = new Set(
    [...String(next ?? "").matchAll(srcRe)].map((m) => m[1]!.toLowerCase())
  );
  for (const d of draftDomains) {
    if (!nextDomains.has(d)) return `dropped-evidence-domain:${d}`;
  }
  const draftQuotes = [...String(draft ?? "").matchAll(quoteRe)].length;
  const nextQuotes = [...String(next ?? "").matchAll(quoteRe)].length;
  if (draftQuotes > 0 && nextQuotes < draftQuotes) {
    return `dropped-evidence-quotes:${nextQuotes}<${draftQuotes}`;
  }
  return null;
}

export function contentHashOf(slides: SlideContentContract[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(slides)).digest("hex")}`;
}

function buildFragmentPayload(input: {
  pack: SectionPackV2;
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  caseAnalysis: GptCaseAnalysis | null;
  targets: SlideContentContract[];
  /** Level 2: validated composition plan for THIS fragment (client-safe). */
  composition?: GptDeckComposition | null;
}): Record<string, unknown> {
  const findingById = new Map(input.bundle.findings.map((f) => [f.findingId, f]));
  const plan = input.composition?.fragments.find(
    (f) => f.fragmentKey === input.pack.fragmentKey
  );
  // Themes instead of raw findingIds: the model must never echo internal ids
  // into client text, and themes are already client language.
  const compositionPlan = plan
    ? {
        storyAngle: plan.storyAngle,
        emphasisThemes: plan.emphasisFindingIds
          .map((id) => findingById.get(id)?.theme)
          .filter((t): t is string => Boolean(t)),
        keyDomains: plan.keyDomains,
      }
    : null;
  const scopedFindings = input.pack.sourceFindingIds
    .map((id) => findingById.get(id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .slice(0, 24)
    // Client-language labels only: the model echoes payload tokens, and raw
    // enums (riskLevel "high", SUBJECT_MATCH, finding ids) would leak into the
    // generated text and be rejected by the token scanner afterwards.
    .map((f) => ({
      theme: f.theme,
      claim: f.claim,
      riskLevel: riskLevelRu(f.riskLevel),
      subjectMatch: subjectMatchRu(f.subjectMatch),
      recommendedAction: f.recommendedAction,
      sourceDomains: f.sourceDomains.slice(0, 6),
    }));
  return {
    fragmentKey: input.pack.fragmentKey,
    subject: { displayName: input.subject.displayName, aliases: input.subject.aliases },
    caseAnalysis: input.caseAnalysis
      ? {
          overallRiskLevel: input.caseAnalysis.overallRiskLevel,
          executiveConclusion: input.caseAnalysis.executiveConclusion,
          keyRisks: input.caseAnalysis.keyRisks,
          recommendations: input.caseAnalysis.recommendations,
        }
      : null,
    compositionPlan,
    findings: scopedFindings,
    slides: input.targets.map((s) => ({
      slideId: s.slideId,
      title: s.title,
      subtitle: s.subtitle,
      draft: {
        narrative: s.content.narrative,
        bullets: s.content.bullets,
        whatWasFound: s.content.whatWasFound,
        whyItMatters: s.content.whyItMatters,
        whatToCheck: s.content.whatToCheck,
      },
    })),
  };
}

function applyOverrides(input: {
  pack: SectionPackV2;
  overrides: SlideOverride[];
  evidenceIndex: ScopedEvidenceIndex;
  rejectedFields: string[];
}): { slides: SlideContentContract[]; appliedFields: number } {
  const { pack, overrides, evidenceIndex, rejectedFields } = input;
  const overrideById = new Map(overrides.map((o) => [o.slideId, o]));
  const continuationBases = new Set(
    pack.slides.filter((s) => s.isContinuation).map((s) => s.continuationOf)
  );
  let appliedFields = 0;

  const slides = pack.slides.map((slide) => {
    if (slide.isContinuation) return slide;
    // Fail-closed: never overwrite coverage/visual empty states even if the
    // model returns an override for that slideId.
    if (isHonestEmptyStateSlide(slide)) return slide;
    const o = overrideById.get(slide.slideId);
    if (!o) return slide;
    const allowed = allowedDomainsForSlide(slide, evidenceIndex);
    const content = { ...slide.content };

    const tryField = (
      field: "narrative" | "whatWasFound" | "whyItMatters" | "whatToCheck",
      value: string | undefined,
      budget: number
    ) => {
      if (value === undefined) return;
      const normalized =
        field === "narrative" ? reflowNarrativeParagraphs(value.trim()) : value.trim();
      const reason = rejectReason(normalized, budget, allowed);
      if (reason) {
        rejectedFields.push(`${slide.slideId}.${field}:${reason}`);
        return;
      }
      content[field] = normalized;
      appliedFields += 1;
    };

    tryField("narrative", o.narrative, TEXT_BUDGETS.narrative);
    tryField("whatWasFound", o.whatWasFound, TEXT_BUDGETS.whatWasFound);
    tryField("whyItMatters", o.whyItMatters, TEXT_BUDGETS.whyItMatters);
    tryField("whatToCheck", o.whatToCheck, TEXT_BUDGETS.whatToCheck);

    // Bullets stay deterministic when the slide has chunked continuations
    // (rewriting only the base chunk would desynchronize the sequence).
    if (o.bullets && !continuationBases.has(slide.slideId)) {
      const draftBullets = slide.content.bullets ?? [];
      const reflowed = o.bullets.map((b) => reflowThemeBullet(b.trim()));
      const reasons = reflowed
        .map(
          (b, i) =>
            rejectReason(b, TEXT_BUDGETS.bullet, allowed) ??
            rejectWeakQuoteLines(b) ??
            rejectDroppedEvidenceQuotes(draftBullets[i] ?? "", b)
        )
        .filter((r): r is string => Boolean(r));
      if (reasons.length > 0) {
        rejectedFields.push(`${slide.slideId}.bullets:${reasons[0]}`);
      } else {
        content.bullets = reflowed;
        appliedFields += 1;
      }
    }

    return { ...slide, content };
  });

  return { slides, appliedFields };
}

type PendingGptPack = {
  pack: SectionPackV2;
  targets: SlideContentContract[];
  systemPrompt: string;
  userPayload: unknown;
  wantCaseAnalysis: boolean;
};

/** REMEDIATION §4.3 — cache hit only for successful stage-2 stamps. */
export function isGptCopyCacheHit(
  pack: SectionPackV2,
  wantCaseAnalysis: boolean
): boolean {
  const g = pack.gptCopy;
  if (!g) return false;
  if (!g.promptVersion || g.promptVersion !== GPT_SLIDE_COPY_PROMPT_VERSION) {
    return false;
  }
  if (g.lastStatus?.startsWith("FALLBACK_")) return false;
  if (Boolean(g.caseAnalysisUsed) !== wantCaseAnalysis) return false;
  return true;
}

export function packNeedsGptCopyFallbackRetry(
  pack: SectionPackV2,
  fallbackKeys?: ReadonlySet<string>
): boolean {
  if (pack.gptCopy?.lastStatus?.startsWith("FALLBACK_")) return true;
  // Compat: report listed FALLBACK_* before packs stamped lastStatus.
  if (
    fallbackKeys?.has(pack.fragmentKey) &&
    !isGptCopyCacheHit(pack, Boolean(pack.gptCopy?.caseAnalysisUsed))
  ) {
    return true;
  }
  return false;
}

function stampGptCopy(
  pack: SectionPackV2,
  input: {
    status: GptSlideCopyFragmentStatus;
    detail?: string;
    wantCaseAnalysis: boolean;
    appliedSlides?: number;
    cacheable: boolean;
  }
): SectionPackV2 {
  return {
    ...pack,
    gptCopy: {
      promptVersion: input.cacheable ? GPT_SLIDE_COPY_PROMPT_VERSION : "",
      appliedSlides: input.appliedSlides ?? pack.gptCopy?.appliedSlides ?? 0,
      caseAnalysisUsed: input.wantCaseAnalysis,
      lastStatus: input.status,
      ...(input.detail ? { lastDetail: input.detail } : {}),
    },
  };
}

function applyGptRawToPack(input: {
  pack: SectionPackV2;
  targets: SlideContentContract[];
  raw: unknown;
  wantCaseAnalysis: boolean;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
}): { pack: SectionPackV2; report: GptSlideCopyFragmentReport } {
  const report: GptSlideCopyFragmentReport = {
    fragmentKey: input.pack.fragmentKey,
    status: "NO_CHANGES",
    appliedFields: 0,
    rejectedFields: [],
  };
  const parsed = parseFragmentCopyResponse(input.raw);
  if (!parsed) {
    report.status = "FALLBACK_ERROR";
    report.detail = "invalid response schema";
    return {
      pack: stampGptCopy(input.pack, {
        status: "FALLBACK_ERROR",
        detail: report.detail,
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: false,
      }),
      report,
    };
  }

  const knownIds = new Set(input.targets.map((s) => s.slideId));
  const overrides = parsed.slides.filter((o) => knownIds.has(o.slideId));
  const { slides, appliedFields } = applyOverrides({
    pack: input.pack,
    overrides,
    evidenceIndex: input.evidenceIndex,
    rejectedFields: report.rejectedFields,
  });
  report.appliedFields = appliedFields;
  if (appliedFields === 0) {
    report.status = "NO_CHANGES";
    return {
      pack: stampGptCopy(input.pack, {
        status: "NO_CHANGES",
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: true,
      }),
      report,
    };
  }

  const appliedSlides = new Set(
    overrides.filter((o) => knownIds.has(o.slideId)).map((o) => o.slideId)
  ).size;
  const candidate: SectionPackV2 = {
    ...input.pack,
    slides,
    contentHash: contentHashOf(slides),
    gptCopy: {
      promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
      appliedSlides,
      caseAnalysisUsed: input.wantCaseAnalysis,
      lastStatus: "APPLIED",
    },
  };
  const validation = input.validatePack(candidate);
  if (!validation.passed) {
    report.status = "FALLBACK_VALIDATION";
    report.detail = validation.issues.slice(0, 3).join("; ");
    return {
      pack: stampGptCopy(input.pack, {
        status: "FALLBACK_VALIDATION",
        detail: report.detail,
        wantCaseAnalysis: input.wantCaseAnalysis,
        cacheable: false,
      }),
      report,
    };
  }

  report.status = "APPLIED";
  return {
    pack: { ...candidate, validation: { passed: true, issues: [] } },
    report,
  };
}

/**
 * Enhance analytical SectionPacks with GPT-written client copy.
 * Deterministic fragments, cached GPT packs and anything that fails QA keep
 * their existing content — the result is never worse than the input.
 *
 * REMEDIATION §4.2: eligible fragment calls go through `runGptCallQueue`
 * (concurrency + retries + stage deadline). Application order is sorted by
 * fragmentKey for deterministic artifacts.
 */
export async function enhanceSectionPacksWithGptCopy(input: {
  packs: SectionPackV2[];
  subject: SubjectProfileInput;
  caller: GptJsonCaller;
  caseAnalysis: GptCaseAnalysis | null;
  /** Level 2: validated deck composition plan (fail-safe null). */
  composition?: GptDeckComposition | null;
  bundle: VerifiedFindingBundle;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
  /** Optional queue overrides (tests inject fake sleep / short deadline). */
  queueOptions?: Parameters<typeof runGptCallQueue>[0]["options"];
  /**
   * REMEDIATION §4.3 — only call GPT for FALLBACK_* fragments; others stay
   * SKIPPED_CACHED / deterministic / empty.
   */
  retryOnlyFallback?: boolean;
  /** Fragment keys listed as FALLBACK_* in gpt-report-copy.json (compat). */
  fallbackFragmentKeys?: ReadonlySet<string>;
  /**
   * Full prepare / «Пересобрать»: never short-circuit as SKIPPED_CACHED.
   * Selective gpt-copy retry must leave this false (uses retryOnlyFallback).
   */
  forceRefresh?: boolean;
}): Promise<{ packs: SectionPackV2[]; report: GptSlideCopyReport }> {
  const byKey = new Map<
    string,
    { pack: SectionPackV2; report: GptSlideCopyFragmentReport }
  >();
  const pending: PendingGptPack[] = [];
  const wantCaseAnalysis = Boolean(input.caseAnalysis);
  const fallbackKeys = input.fallbackFragmentKeys;

  for (const pack of input.packs) {
    const prompt = getFragmentPrompt(pack.fragmentKey);
    const report: GptSlideCopyFragmentReport = {
      fragmentKey: pack.fragmentKey,
      status: "NO_CHANGES",
      appliedFields: 0,
      rejectedFields: [],
    };

    if (prompt.deterministic) {
      report.status = "SKIPPED_DETERMINISTIC";
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }
    if (pack.status !== "READY" || pack.slides.length === 0) {
      report.status = "SKIPPED_EMPTY";
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }
    if (input.retryOnlyFallback) {
      if (!packNeedsGptCopyFallbackRetry(pack, fallbackKeys)) {
        report.status = "SKIPPED_CACHED";
        byKey.set(pack.fragmentKey, { pack, report });
        continue;
      }
    } else if (
      !input.forceRefresh &&
      isGptCopyCacheHit(pack, wantCaseAnalysis)
    ) {
      report.status = "SKIPPED_CACHED";
      byKey.set(pack.fragmentKey, { pack, report });
      continue;
    }

    // Never send honest empty-state slides to GPT — it otherwise pulls
    // pack-level findings (other surfaces/regions) into «проверено, пусто».
    const targets = pack.slides.filter(
      (s) => !s.isContinuation && !isHonestEmptyStateSlide(s)
    );
    if (targets.length === 0) {
      report.status = "SKIPPED_EMPTY";
      report.detail = "honest-empty-state";
      byKey.set(pack.fragmentKey, {
        pack: stampGptCopy(pack, {
          status: "SKIPPED_EMPTY",
          detail: "honest-empty-state",
          wantCaseAnalysis,
          cacheable: true,
          appliedSlides: 0,
        }),
        report,
      });
      continue;
    }
    pending.push({
      pack,
      targets,
      systemPrompt: `${prompt.systemPrompt} ${COPY_INSTRUCTIONS}`,
      userPayload: buildFragmentPayload({
        pack,
        subject: input.subject,
        bundle: input.bundle,
        caseAnalysis: input.caseAnalysis,
        targets,
        composition: input.composition,
      }),
      wantCaseAnalysis,
    });
  }

  const defaults = defaultGptCallQueueOptions();
  // Offline smokes must not pay real backoff sleeps when fakes throw 429/5xx.
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;
  const queueResults = await runGptCallQueue({
    tasks: pending.map((p) => ({
      key: p.pack.fragmentKey,
      run: () =>
        input.caller({
          systemPrompt: p.systemPrompt,
          userPayload: p.userPayload,
        }),
    })),
    options: {
      concurrency: defaults.concurrency,
      maxAttempts: defaults.maxAttempts,
      deadlineMs: defaults.deadlineMs,
      sleep: offlineSleep,
      ...input.queueOptions,
    },
  });

  const rawByKey = new Map(queueResults.map((r) => [r.key, r]));

  // PDF-31 B.1a: fields the model wrote over budget get ONE compression retry
  // before the reject/fallback machinery sees them. Any repair failure keeps
  // the round-1 value — the field is then rejected exactly as before.
  const rawToApply = new Map<string, unknown>();
  const repairedByKey = new Map<string, number>();
  const repairPending: Array<{
    item: PendingGptPack;
    overrides: SlideOverride[];
    requested: OverBudgetItem[];
  }> = [];

  for (const item of pending) {
    const queued = rawByKey.get(item.pack.fragmentKey);
    if (!queued || !queued.ok) {
      const reason = queued && !queued.ok ? queued.reason : "FALLBACK_ERROR";
      const status =
        reason === "FALLBACK_TIMEOUT" ? "FALLBACK_TIMEOUT" : "FALLBACK_ERROR";
      const detail =
        queued && !queued.ok
          ? queued.error.message
          : "gpt-queue-missing-result";
      byKey.set(item.pack.fragmentKey, {
        pack: stampGptCopy(item.pack, {
          status,
          detail,
          wantCaseAnalysis: item.wantCaseAnalysis,
          cacheable: false,
        }),
        report: {
          fragmentKey: item.pack.fragmentKey,
          status,
          appliedFields: 0,
          rejectedFields: [],
          detail,
        },
      });
      continue;
    }
    const parsed = parseFragmentCopyResponse(queued.value);
    if (parsed) {
      const knownIds = new Set(item.targets.map((s) => s.slideId));
      const requested = collectOverBudgetItems(parsed.slides, knownIds);
      if (requested.length > 0) {
        repairPending.push({ item, overrides: parsed.slides, requested });
        continue;
      }
    }
    rawToApply.set(item.pack.fragmentKey, queued.value);
  }

  if (repairPending.length > 0) {
    const repairResults = await runGptCallQueue({
      tasks: repairPending.map((r) => ({
        key: r.item.pack.fragmentKey,
        run: () =>
          input.caller({
            systemPrompt: REPAIR_INSTRUCTIONS,
            userPayload: {
              fragmentKey: r.item.pack.fragmentKey,
              items: r.requested,
            },
          }),
      })),
      options: {
        concurrency: defaults.concurrency,
        maxAttempts: defaults.maxAttempts,
        deadlineMs: defaults.deadlineMs,
        sleep: offlineSleep,
        ...input.queueOptions,
      },
    });
    const repairByKey = new Map(repairResults.map((r) => [r.key, r]));
    for (const r of repairPending) {
      const key = r.item.pack.fragmentKey;
      const repaired = repairByKey.get(key);
      if (repaired?.ok) {
        const merged = mergeRepairedFields({
          overrides: r.overrides,
          requested: r.requested,
          raw: repaired.value,
        });
        rawToApply.set(key, { slides: merged.overrides });
        if (merged.repairedFields > 0) {
          repairedByKey.set(key, merged.repairedFields);
        }
      } else {
        // Repair call failed → apply round-1 output; over-budget fields will
        // be rejected individually (pre-B.1a behavior).
        rawToApply.set(key, { slides: r.overrides });
      }
    }
  }

  for (const item of pending) {
    if (byKey.has(item.pack.fragmentKey)) continue;
    const applied = applyGptRawToPack({
      pack: item.pack,
      targets: item.targets,
      raw: rawToApply.get(item.pack.fragmentKey),
      wantCaseAnalysis: item.wantCaseAnalysis,
      evidenceIndex: input.evidenceIndex,
      validatePack: input.validatePack,
    });
    const repairedFields = repairedByKey.get(item.pack.fragmentKey);
    if (repairedFields) applied.report.repairedFields = repairedFields;
    byKey.set(item.pack.fragmentKey, applied);
  }

  // Deterministic artifact order: original pack order for packs, fragmentKey
  // sort for the report (stable across concurrent completion).
  const outPacks = input.packs.map(
    (p) => byKey.get(p.fragmentKey)?.pack ?? p
  );
  const fragments = [...byKey.values()]
    .map((v) => v.report)
    .sort((a, b) => a.fragmentKey.localeCompare(b.fragmentKey));

  return {
    packs: outPacks,
    report: {
      version: "gpt-report-copy-v1",
      promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
      caseAnalysisUsed: wantCaseAnalysis,
      compositionUsed: Boolean(
        input.composition && input.composition.fragments.length > 0
      ),
      fragments,
    },
  };
}
