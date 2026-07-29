/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import { createHash } from "node:crypto";
import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY } from "../template-registry";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  clampClientText,
  makeSlotSlide,
  sourceLine,
  themedClaim,
  uniqueRefs,
  withContinuations,
  bulletWithFindingId,
} from "./shared";

export function buildAppendixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const ambiguous = scoped.findings.filter((f) => f.subjectMatch !== "SUBJECT_MATCH");
  if (ambiguous.length === 0) {
    return { slides: [], status: "EMPTY_VALID", emptyStateReason: "no-appendix-material" };
  }
  const base: SlideContentContract = {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: "appendix_main_base",
    baseSlotId: "slot_appendix_main",
    sectionId,
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "finding-cards",
    title: "Приложение: материалы, требующие идентификации",
    content: {
      // Маркер находки приписывается тем же помощником, что и везде.
      //
      // Здесь текст обрезался по 340 знакам, а маркер дописывался **после**:
      // итог всё равно выходил за бюджет, а фраза теряла конец. В отчёте о
      // Тинькове (28.07, стр.54) это выглядело как «…не перекрывает
      // чувствительные темы [finding-…]» — без слова «риска» и без точки.
      // `bulletWithFindingId` резервирует место под маркер заранее и ужимает
      // текст целыми строками, не разрезая предложение.
      // Бюджет берётся у шаблона, а не пишется числом.
      //
      // Здесь стояло 340 при `itemCharBudget: 860` у «finding-cards» — второй
      // ответ на вопрос «сколько знаков помещается в буллет этой карточки», и
      // вдвое меньше настоящего. Из-за него фраза не помещалась вместе с
      // маркером находки (50 знаков) и теряла конец.
      bullets: ambiguous.map((f) =>
        bulletWithFindingId(
          themedClaim(f),
          f.findingId,
          DECK_TEMPLATE_REGISTRY["finding-cards"].layout.itemCharBudget
        )
      ),
      sourceNote: sourceLine(scoped),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: ambiguous.map((f) => f.findingId),
    metrics: { items: ambiguous.length },
    visualAssetRefs: [],
  };
  return { slides: withContinuations(base, "finding-cards"), status: "READY" };
}

