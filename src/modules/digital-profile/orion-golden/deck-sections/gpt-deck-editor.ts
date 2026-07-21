/**
 * GPT stage 3 — whole-deck editorial pass (GPT levels plan, level 1).
 *
 * After stage 2 rewrites each fragment in isolation, this stage reads the
 * client text of the WHOLE assembled deck in one call and aligns it across
 * pages: consistent terminology, smooth transitions, no verbatim repeats
 * between neighbouring slides, complete final sentences. It edits wording
 * only — the skeleton, metrics, tables and evidence stay untouched.
 *
 * Fail-safe by construction (same gates as stage 2):
 *  - every returned field passes budgets, internal/forbidden-token scans and
 *    the per-slide domain gate; a bad field is rejected individually;
 *  - each edited pack is re-validated by the section QA; a failing pack keeps
 *    its stage-2 content (per-fragment fallback);
 *  - transport errors keep all packs unchanged. The editor can only polish
 *    text, never block or degrade the report.
 */

import { z } from "zod";
import type { FragmentKey, SectionPackV2, SlideContentContract } from "./contracts";
import { getFragmentPrompt } from "./prompts";
import type { ScopedEvidenceIndex, SubjectProfileInput } from "./scoped-input";
import type { GptJsonCaller } from "../gpt/gpt-case-analysis";
import { defaultGptCallQueueOptions, runGptCallQueue } from "../gpt/gpt-call-queue";
import {
  allowedDomainsForSlide,
  contentHashOf,
  GPT_SLIDE_COPY_FIELD_BUDGETS,
  isHonestEmptyStateSlide,
  rejectReason,
} from "./llm-slide-copy";

export const GPT_DECK_EDITOR_PROMPT_VERSION = "gpt-deck-editor-v1";

/** Prompt marker for offline smokes asserting the stage-3 editorial pass. */
export const GPT_DECK_EDITOR_PROMPT_MARKER = "выпускающий редактор всего отчёта";

const TEXT_BUDGETS = GPT_SLIDE_COPY_FIELD_BUDGETS;

const EditorSlideOverrideSchema = z.object({
  slideId: z.string().min(1),
  narrative: z.string().optional(),
  bullets: z.array(z.string().min(1)).min(1).max(8).optional(),
  whatWasFound: z.string().optional(),
  whyItMatters: z.string().optional(),
  whatToCheck: z.string().optional(),
});
const EditorResponseSchema = z.object({
  slides: z.array(EditorSlideOverrideSchema).max(64),
});
type EditorSlideOverride = z.infer<typeof EditorSlideOverrideSchema>;

const EDITOR_INSTRUCTIONS = [
  `Ты — ${GPT_DECK_EDITOR_PROMPT_MARKER} о цифровом профиле субъекта. Тебе передан клиентский текст ВСЕХ страниц уже собранного отчёта.`,
  "Твоя задача — редакторская связность между страницами: единая терминология (одни и те же темы называются одинаково), плавные переходы, отсутствие дословных повторов между соседними страницами, каждый блок заканчивается завершённым предложением с точкой.",
  "НЕ добавляй новых фактов, чисел, имён, компаний и доменов; НЕ меняй смысл выводов и оценки рисков; НЕ вставляй URL.",
  "СТРОГО ЗАПРЕЩЕНО упоминать процесс подготовки отчёта: слова «черновик», «переданный фрагмент», «scoped», «findings» и рассуждения о твоей работе с материалами.",
  "Не трогай страницы, где текст честно сообщает, что поверхность не собиралась или проверена и пуста.",
  `Лимиты длины: narrative до ${Math.floor(TEXT_BUDGETS.narrative * 0.94)}, каждый bullet до ${Math.floor(TEXT_BUDGETS.bullet * 0.94)}, whatWasFound до ${Math.floor(TEXT_BUDGETS.whatWasFound * 0.94)}, whyItMatters до ${Math.floor(TEXT_BUDGETS.whyItMatters * 0.94)}, whatToCheck до ${Math.floor(TEXT_BUDGETS.whatToCheck * 0.94)} символов.`,
  'Верни ТОЛЬКО JSON: {"slides": [{"slideId": string, "narrative"?: string, "bullets"?: [string], "whatWasFound"?: string, "whyItMatters"?: string, "whatToCheck"?: string}]} — и только те слайды и поля, которые ты реально улучшил. Если правки не нужны, верни {"slides": []}.',
].join(" ");

export type GptDeckEditorFragmentReport = {
  fragmentKey: FragmentKey;
  appliedFields: number;
  rejectedFields: string[];
  /** Set when the edited pack failed section QA and was rolled back. */
  validationFallback?: string;
};

export type GptDeckEditorReport = {
  version: "gpt-deck-editor-v1";
  promptVersion: string;
  status: "APPLIED" | "NO_CHANGES" | "SKIPPED_EMPTY" | "FALLBACK_ERROR";
  detail?: string;
  editedSlides: number;
  appliedFields: number;
  fragments: GptDeckEditorFragmentReport[];
};

function emptyReport(
  status: GptDeckEditorReport["status"],
  detail?: string
): GptDeckEditorReport {
  return {
    version: "gpt-deck-editor-v1",
    promptVersion: GPT_DECK_EDITOR_PROMPT_VERSION,
    status,
    ...(detail ? { detail } : {}),
    editedSlides: 0,
    appliedFields: 0,
    fragments: [],
  };
}

/** Slides the editor may touch: analytical, base (non-continuation), non-empty. */
function editableSlides(pack: SectionPackV2): SlideContentContract[] {
  if (pack.status !== "READY") return [];
  if (getFragmentPrompt(pack.fragmentKey).deterministic) return [];
  return pack.slides.filter(
    (s) => !s.isContinuation && !isHonestEmptyStateSlide(s)
  );
}

function applyEditorOverridesToPack(input: {
  pack: SectionPackV2;
  overrides: EditorSlideOverride[];
  evidenceIndex: ScopedEvidenceIndex;
  report: GptDeckEditorFragmentReport;
}): { pack: SectionPackV2; changed: boolean } {
  const { pack, overrides, report } = input;
  const overrideById = new Map(overrides.map((o) => [o.slideId, o]));
  const continuationBases = new Set(
    pack.slides.filter((s) => s.isContinuation).map((s) => s.continuationOf)
  );
  let changed = false;

  const slides = pack.slides.map((slide) => {
    if (slide.isContinuation || isHonestEmptyStateSlide(slide)) return slide;
    const o = overrideById.get(slide.slideId);
    if (!o) return slide;
    const allowed = allowedDomainsForSlide(slide, input.evidenceIndex);
    const content = { ...slide.content };
    let slideChanged = false;

    const tryField = (
      field: "narrative" | "whatWasFound" | "whyItMatters" | "whatToCheck",
      value: string | undefined,
      budget: number
    ) => {
      if (value === undefined) return;
      const reason = rejectReason(value, budget, allowed);
      if (reason) {
        report.rejectedFields.push(`${slide.slideId}.${field}:${reason}`);
        return;
      }
      if (content[field] === value.trim()) return;
      content[field] = value.trim();
      report.appliedFields += 1;
      slideChanged = true;
    };

    tryField("narrative", o.narrative, TEXT_BUDGETS.narrative);
    tryField("whatWasFound", o.whatWasFound, TEXT_BUDGETS.whatWasFound);
    tryField("whyItMatters", o.whyItMatters, TEXT_BUDGETS.whyItMatters);
    tryField("whatToCheck", o.whatToCheck, TEXT_BUDGETS.whatToCheck);

    // Chunked bullet sequences stay untouched (same guard as stage 2).
    if (o.bullets && !continuationBases.has(slide.slideId)) {
      const reasons = o.bullets
        .map((b) => rejectReason(b, TEXT_BUDGETS.bullet, allowed))
        .filter((r): r is string => Boolean(r));
      if (reasons.length > 0) {
        report.rejectedFields.push(`${slide.slideId}.bullets:${reasons[0]}`);
      } else {
        content.bullets = o.bullets.map((b) => b.trim());
        report.appliedFields += 1;
        slideChanged = true;
      }
    }

    if (!slideChanged) return slide;
    changed = true;
    return { ...slide, content };
  });

  if (!changed) return { pack, changed: false };
  return {
    pack: { ...pack, slides, contentHash: contentHashOf(slides) },
    changed: true,
  };
}

/**
 * Run the stage-3 editorial pass over enhanced SectionPacks.
 * Never throws; on any failure the input packs are returned unchanged.
 */
export async function runGptDeckEditorPass(input: {
  packs: SectionPackV2[];
  subject: SubjectProfileInput;
  caller: GptJsonCaller;
  evidenceIndex: ScopedEvidenceIndex;
  validatePack: (pack: SectionPackV2) => { passed: boolean; issues: string[] };
  /** Optional queue overrides (tests inject fake sleep / short deadline). */
  queueOptions?: Parameters<typeof runGptCallQueue>[0]["options"];
}): Promise<{ packs: SectionPackV2[]; report: GptDeckEditorReport }> {
  const slideToFragment = new Map<string, FragmentKey>();
  const deckDigest: Array<Record<string, unknown>> = [];
  for (const pack of input.packs) {
    for (const slide of editableSlides(pack)) {
      slideToFragment.set(slide.slideId, pack.fragmentKey);
      deckDigest.push({
        slideId: slide.slideId,
        title: slide.title,
        subtitle: slide.subtitle,
        narrative: slide.content.narrative,
        bullets: slide.content.bullets,
        whatWasFound: slide.content.whatWasFound,
        whyItMatters: slide.content.whyItMatters,
        whatToCheck: slide.content.whatToCheck,
      });
    }
  }
  if (deckDigest.length === 0) {
    return { packs: input.packs, report: emptyReport("SKIPPED_EMPTY") };
  }

  const defaults = defaultGptCallQueueOptions();
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;
  const [queued] = await runGptCallQueue({
    tasks: [
      {
        key: "deck-editor",
        run: () =>
          input.caller({
            systemPrompt: EDITOR_INSTRUCTIONS,
            userPayload: {
              subject: {
                displayName: input.subject.displayName,
                aliases: input.subject.aliases,
              },
              slides: deckDigest,
            },
          }),
      },
    ],
    options: {
      concurrency: 1,
      maxAttempts: defaults.maxAttempts,
      deadlineMs: defaults.deadlineMs,
      sleep: offlineSleep,
      ...input.queueOptions,
    },
  });

  if (!queued || !queued.ok) {
    const detail =
      queued && !queued.ok ? queued.error.message : "gpt-queue-missing-result";
    return { packs: input.packs, report: emptyReport("FALLBACK_ERROR", detail) };
  }
  const parsed = EditorResponseSchema.safeParse(queued.value);
  if (!parsed.success) {
    return {
      packs: input.packs,
      report: emptyReport("FALLBACK_ERROR", "invalid response schema"),
    };
  }

  // Group returned overrides by owning fragment; unknown slideIds are dropped.
  const byFragment = new Map<FragmentKey, EditorSlideOverride[]>();
  for (const o of parsed.data.slides) {
    const fragmentKey = slideToFragment.get(o.slideId);
    if (!fragmentKey) continue;
    const list = byFragment.get(fragmentKey) ?? [];
    list.push(o);
    byFragment.set(fragmentKey, list);
  }

  const report = emptyReport(byFragment.size === 0 ? "NO_CHANGES" : "APPLIED");
  const outPacks = input.packs.map((pack) => {
    const overrides = byFragment.get(pack.fragmentKey);
    if (!overrides || overrides.length === 0) return pack;
    const fragmentReport: GptDeckEditorFragmentReport = {
      fragmentKey: pack.fragmentKey,
      appliedFields: 0,
      rejectedFields: [],
    };
    const { pack: edited, changed } = applyEditorOverridesToPack({
      pack,
      overrides,
      evidenceIndex: input.evidenceIndex,
      report: fragmentReport,
    });
    if (!changed) {
      if (fragmentReport.rejectedFields.length > 0) {
        report.fragments.push(fragmentReport);
      }
      return pack;
    }
    const validation = input.validatePack(edited);
    if (!validation.passed) {
      fragmentReport.validationFallback = validation.issues.slice(0, 3).join("; ");
      fragmentReport.appliedFields = 0;
      report.fragments.push(fragmentReport);
      return pack;
    }
    report.appliedFields += fragmentReport.appliedFields;
    report.editedSlides += new Set(overrides.map((o) => o.slideId)).size;
    report.fragments.push(fragmentReport);
    return { ...edited, validation: { passed: true, issues: [] } };
  });

  if (report.appliedFields === 0) report.status = "NO_CHANGES";
  return { packs: outPacks, report };
}
