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
 * Поэтому под названием темы печатается степень идентификации. Это и снимает
 * мнимый повтор, и отвечает на вопрос, ради которого страницу открывают:
 * почему материал здесь, а не в основном отчёте.
 */
const IDENTIFICATION_LABEL: Record<string, string> = {
  LIKELY_SUBJECT: "вероятно о субъекте",
  OTHER_SUBJECT: "о другом лице",
  AMBIGUOUS: "не разобрана",
  INSUFFICIENT_IDENTIFIERS: "признаков для опознания не хватило",
};

/**
 * Почему разметка решила именно так — словами и со значением.
 *
 * «О другом лице» без причины читателю нечем проверить, а проверить он хочет
 * именно это: заказчик прогона DPA-2026-0049 не понимал, почему часть
 * материалов о его однофамильцах. Причина у разметки есть всегда, и значение,
 * по которому она решила, стоит рядом — его можно сверить глазами.
 */
const MEMBERSHIP_REASON: Record<string, { text: string; withValues?: boolean }> = {
  foreign_birth_date: { text: "на странице другая дата рождения", withValues: true },
  foreign_inn: { text: "на странице ИНН другого лица", withValues: true },
  namesake_conflict: { text: "признаки однофамильца", withValues: true },
  mixed_identity_signals: { text: "на странице признаки двух разных людей" },
  full_name_no_anchor: {
    text: "совпало полное имя, других признаков проверяемого лица на странице нет",
  },
  registry_inn_unverified: {
    text: "реестровая запись с ИНН, который нечем сверить: свой ИНН не назван",
  },
};

/**
 * Строка «Принадлежность: …» целиком; `null` — степень неизвестна.
 *
 * Пустых скобок не бывает: причина без значения печатается одной фразой, а
 * причина со значением — фразой и значением. Двоеточие ставится только там,
 * где за ним действительно перечисление.
 */
export function subjectMembershipLine(input: {
  subjectMatch: string;
  reason?: string;
  conflicts?: readonly string[];
}): string | null {
  const word = IDENTIFICATION_LABEL[input.subjectMatch];
  if (!word) return null;
  const reason = input.reason ? MEMBERSHIP_REASON[input.reason] : undefined;
  if (!reason) return `Принадлежность: ${word}.`;
  const values = (input.conflicts ?? []).filter((v) => String(v).trim().length > 0);
  if (!reason.withValues || values.length === 0) {
    return `Принадлежность: ${word} — ${reason.text}.`;
  }
  // Значение к самой фразе цепляется по-разному: дата и ИНН — один признак в
  // скобках, слова тёзки — перечисление после двоеточия.
  const tail =
    values.length === 1 && input.reason !== "namesake_conflict"
      ? ` (${values[0]})`
      : `: ${values.join(", ")}`;
  return `Принадлежность: ${word} — ${reason.text}${tail}.`;
}

/**
 * Ставит степень идентификации отдельной строкой сразу под названием темы.
 *
 * Сначала метка дописывалась в саму строку заголовка — и ломала его разбор:
 * `reflowThemeBullet` узнаёт заголовок по образцу «„Тема" + Найдены…», а с
 * меткой посередине образец не совпадал. В отчёте 72 это дало два разных
 * увечья на одной странице: в одном блоке метка ушла на вторую строку без
 * тире и читалась обрывком фразы, в другом — вместе с рамкой слиплась в один
 * жирный заголовок.
 *
 * Своя строка снимает вопрос: заголовок остаётся заголовком, а метка читается
 * как то, чем она является, — ответом на вопрос «почему материал здесь».
 */
export function withIdentificationLabel(
  claim: string,
  subjectMatch: string,
  membership?: { reason?: string; conflicts?: readonly string[] }
): string {
  const line = subjectMembershipLine({ subjectMatch, ...membership });
  if (!line) return claim;
  const lines = claim.split("\n");
  const head = (lines[0] ?? "").trim();
  if (!/^«[^»]+»$/u.test(head)) return claim;
  // Пометка уже стоит — второй раз не дописываем.
  if (/^Принадлежность:/u.test((lines[1] ?? "").trim())) return claim;
  return [head, line, ...lines.slice(1)].join("\n");
}

/**
 * Причина разметки для находки — по первой улике, у которой она есть.
 *
 * Находка собрана из нескольких материалов, и причина у них может различаться;
 * печатается первая названная. Перебирать все значило бы печатать в карточке
 * список кодов вместо ответа на вопрос «почему материал здесь».
 */
function membershipOf(
  finding: { evidenceRefs: string[] },
  scoped: ScopedFragmentInput
): { reason?: string; conflicts?: string[] } {
  for (const ref of finding.evidenceRefs) {
    const entry = scoped.evidenceIndex[ref];
    if (entry?.subjectReason) {
      return { reason: entry.subjectReason, conflicts: entry.subjectConflicts };
    }
  }
  return {};
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
          withIdentificationLabel(themedClaim(f), f.subjectMatch, membershipOf(f, scoped)),
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

