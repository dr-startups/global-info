/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { pluralRu } from "../../../report/i18n/plural-ru";
import {
  adverseVisualSidebar,
  buildPageEvidenceView,
  claimText,
  clampClientText,
  composePageRowComposition,
  otherSubjectBulletText,
  pageFindingBlocks,
  panelComposition,
  panelCompositionLine,
  panelRows,
  panelStatusLine,
  visualSlide,
} from "./shared";

/** Клиентское имя поисковой системы; для общей страницы — без уточнения. */
function engineLabel(engine: string | null): string {
  if (engine === "YANDEX") return "Яндекс";
  if (engine === "GOOGLE") return "Google";
  return "";
}

export function buildSuggestionsFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "suggestions");
  const slides: SlideContentContract[] = [];
  for (const slot of slots) {
    const engine = slot.slotId.includes("yandex")
      ? "YANDEX"
      : slot.slotId.includes("google")
        ? "GOOGLE"
        : null;
    const slotUnits = engine ? units.filter((u) => (u.engine ?? "").toUpperCase() === engine) : units;
    const refs = slotUnits.flatMap((u) => u.evidenceRefs);
    const claims = slotUnits.flatMap((u) => u.claims);
    const bullets = claims.map((c) => clampClientText(claimText(c), 400));
    const lineRefs = refs.filter((r) => Boolean(scoped.evidenceIndex[r]?.title)).slice(0, 10);
    const suggestionLines = lineRefs.map((r) =>
      otherSubjectBulletText(
        String(scoped.evidenceIndex[r]?.title),
        scoped.evidenceIndex[r]?.subjectDecision
      )
    );
    // Описание считает то, что напечатано на этой странице, а не весь набор
    // ссылок поверхности: печатались отобранные строки, а счёт шёл по всем, и
    // под пятью строками стояло «показано двадцать семь».
    const view = buildPageEvidenceView(
      scoped,
      bullets.length ? claims.flatMap((c) => c.evidenceRefs) : lineRefs
    );
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped);
    /*
     * Числа страницы — про строки панели, потому что панель и есть то, что
     * читатель видит. На приёмке панель рисовала десять подсказок, а описание
     * рядом говорило «показано 7»: текст считал свой набор строк. Разбор по
     * принадлежности тоже обязателен — среди подсказок стоят строки о полных
     * тёзках, и без этого они читаются как запросы о субъекте.
     */
    const shown = panelRows(slot.slotId, extras, scoped);
    const panelStats = panelComposition(shown);
    // Негатив в собранном наборе считается по строкам страницы целиком: если он
    // есть, но на панель не попал, статусная строка скажет об этом отдельно —
    // молча потерять его нельзя, а выдать за увиденное читателем тем более.
    const collectedAdverse = composePageRowComposition(scoped, view.refs).adverseHeadlines;
    const panelBlocks: Partial<SlideBody> =
      shown.length > 0
        ? {
            statusNote: panelStatusLine({
              shownAdverse: panelStats.adverse,
              collectedAdverse,
              excludedOtherSubject: panelStats.adverseOther,
              nounOne: "подсказка",
              nounFew: "подсказки",
              nounMany: "подсказок",
            }),
            whatWasFound: clampClientText(
              panelCompositionLine({
                composition: panelStats,
                collected: refs.length,
                nounOne: "подсказка",
                nounFew: "подсказки",
                nounMany: "подсказок",
              }),
              400
            ),
            whyItMatters: clampClientText(
              panelStats.adverse > 0
                ? "Негативные подсказки видны пользователю ещё до просмотра результатов: они формируют первое впечатление и подталкивают к поиску компрометирующих материалов."
                : panelStats.adverseOther > 0
                  ? // Рядом напечатана негативная строка о другом лице: голое
                    // «негативных формулировок нет» спорило бы с ней на одной
                    // странице.
                    "Подсказки показывают, что чаще всего ищут о субъекте: негативных формулировок о проверяемом лице среди показанных строк нет."
                  : "Подсказки показывают, что чаще всего ищут о субъекте: негативных формулировок среди показанных строк нет.",
              320
            ),
            ...(sidebar.explanations.length
              ? { highlightExplanations: sidebar.explanations }
              : {}),
          }
        : {};
    // Заголовок называет вывод страницы: сколько подсказок и есть ли среди них
    // негативные. Прежде стояло название раздела, и читателю приходилось
    // искать этот же вывод в тексте под картинкой.
    // Заголовок считает по тем же строкам, что и текст под ним: панель после
    // склейки одинаковых строк, а не сырой перечень видимых элементов. Иначе
    // «4 негативные формулировки» в заголовке спорят с «3» в описании.
    const shownCount = shown.length || sidebar.visibleRows.length || suggestionLines.length;
    const adverseCount = shown.length > 0 ? panelStats.adverse : sidebar.adverseRows.length;
    const verdictTitle =
      shownCount > 0
        ? `${slot.title}: ${
            adverseCount > 0
              ? `${adverseCount} ${pluralRu(
                  adverseCount,
                  "негативная формулировка",
                  "негативные формулировки",
                  "негативных формулировок"
                )}`
              : "негативных формулировок нет"
          }`
        : undefined;
    slides.push(
      visualSlide({
        slot,
        sectionId,
        extras,
        scoped,
        ...(verdictTitle ? { title: verdictTitle } : {}),
        content: {
          // Список под панелью — те же строки, что и на панели: два разных
          // перечня на одной странице читатель сверяет вручную.
          bullets: shown.length > 0
            ? shown.map((r) => clampClientText(otherSubjectBulletText(r.text, r.decision), 220))
            : bullets.length
              ? bullets
              : suggestionLines,
          ...pageFindingBlocks(scoped, view),
          ...panelBlocks,
        },
        evidenceRefs: [...new Set([...refs, ...sidebar.gridRefs])],
        findingIds: [
          ...new Set([...view.findings.map((f) => f.findingId), ...sidebar.explainedFindingIds]),
        ],
        // Метрика считает то же, что заголовок: два ответа на «сколько
        // негативных подсказок» разошлись бы при первой правке.
        metrics: { items: refs.length, adverseSuggestions: adverseCount },
        noUnderlyingData: refs.length === 0,
        noDataReason: "no-suggestions",
        // Шаг 13, C11 — страница отвечает за одну поисковую систему в одном
        // регионе, и пустой статус не должен звучать как вывод обо всех
        // подсказках: рядом отчёт цитирует подсказку из другой системы.
        noDataScopeLabel: [engineLabel(engine), regionLabel].filter(Boolean).join(", "),
      })
    );
  }
  return { slides, status: "READY" };
}
