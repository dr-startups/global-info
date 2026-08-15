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

/**
 * Почему материал попал в приложение, а не в основной отчёт.
 *
 * Приложение перечисляет находки по степени идентификации, и одна тема
 * появляется в нём столько раз, сколько степеней набралось. На прогоне 14.08
 * подряд стояли три блока с одинаковым заголовком «Деловой профиль» — читатель
 * видит повтор и решает, что отчёт собран шаблоном. Материалы при этом разные:
 * в первом блоке вероятное совпадение, во втором однофамилец, в третьем —
 * неразобранное.
 *
 * Поэтому степень идентификации выносится в заголовок. Это и убирает мнимый
 * повтор, и отвечает на вопрос, ради которого страницу открывают: почему
 * материал здесь.
 */
const IDENTIFICATION_LABEL: Record<string, string> = {
  LIKELY_SUBJECT: "вероятно о субъекте",
  OTHER_SUBJECT: "о другом лице",
  AMBIGUOUS: "принадлежность не разобрана",
  INSUFFICIENT_IDENTIFIERS: "признаков для опознания не хватило",
};

/** Дописывает степень идентификации к заголовку темы в первой строке блока. */
export function withIdentificationLabel(claim: string, subjectMatch: string): string {
  const label = IDENTIFICATION_LABEL[subjectMatch];
  if (!label) return claim;
  const lines = claim.split("\n");
  const head = lines[0] ?? "";
  const m = head.match(/^(«[^»]+»)(.*)$/u);
  if (!m) return claim;
  // Пометка уже стоит — второй раз не дописываем.
  if (/—\s*(?:вероятно|о другом|принадлежность|признаков)/u.test(head)) return claim;
  lines[0] = `${m[1]} — ${label}${m[2] ?? ""}`;
  return lines.join("\n");
}

export function buildAppendixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const ambiguous = [...scoped.findings.filter((f) => f.subjectMatch !== "SUBJECT_MATCH")].sort(
    // Одна тема — подряд: читатель видит все её материалы вместе, а не
    // вперемешку с чужими.
    (a, b) => a.theme.localeCompare(b.theme, "ru") || a.findingId.localeCompare(b.findingId)
  );
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
          withIdentificationLabel(themedClaim(f), f.subjectMatch),
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

