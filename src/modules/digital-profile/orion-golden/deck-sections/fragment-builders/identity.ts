/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import type { SurfaceAnalysisUnit } from "../../contracts/surface-analysis";
import { slotsForFragment } from "../canonical-slots";
import { ADVERSE_PATTERNS } from "../../analytics/surface-analyzers";
import { pluralRu } from "../../analytics/finding-synthesizer";
import { isMockClientDomain } from "../../../services/composite-serp-merge";
import { formatRuDate } from "../../../services/report-material-freshness";
import type { FragmentBuildOutput } from "./shared";
import {
  WIKIPEDIA_ADVICE_CONFIRM_OWNERSHIP,
  WIKIPEDIA_ADVICE_CONTROL,
  WIKIPEDIA_ADVICE_CREATE,
  WIKIPEDIA_ADVICE_UNKNOWN,
  WIKIPEDIA_WHY_ARTICLE_EXISTS,
  WIKIPEDIA_WHY_ARTICLE_NAME_MATCH,
  WIKIPEDIA_WHY_KNOWLEDGE_PANEL,
  WIKIPEDIA_WHY_NO_ARTICLE,
  buildPageEvidenceView,
  clampClientText,
  clientReadableUrl,
  coverageContent,
  emptyStatusForReason,
  enumerateRu,
  makeSlotSlide,
  pageFindingBlocks,
  withContinuations,
} from "./shared";

/**
 * Разные по написанию, одинаковые по сути строки — это один сигнал.
 *
 * Сравнение по нормализованному тексту: регистр и пробелы не делают заголовок
 * другим материалом.
 */
function dedupeByText(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const key = String(raw ?? "").toLowerCase().replace(/\s+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Языковые разделы Википедии, у которых есть общепринятое русское название. */
const WIKIPEDIA_SECTION_NAMES: Record<string, string> = {
  ru: "русскоязычном разделе (ru.wikipedia.org)",
  en: "англоязычном разделе (en.wikipedia.org)",
};

/**
 * Как назвать языковой раздел клиенту.
 *
 * Незнакомый код превращается в домен, а не в придуманное название: раздела
 * «немецкоязычный» в данных проверки нет, есть код `de` — и в отчёт идёт ровно
 * то, что проверялось.
 */
function wikipediaSectionPart(language: string): string {
  const code = String(language ?? "").toLowerCase().split(/[-_]/u)[0] ?? "";
  if (!code) return "";
  return WIKIPEDIA_SECTION_NAMES[code] ?? `разделе ${code}.wikipedia.org`;
}

/** «в русскоязычном разделе (…)» / «в англоязычном разделе (…) и в разделе ar.wikipedia.org». */
function wikipediaSectionLabel(languages: string[]): string {
  const parts = [...new Set(languages.map(wikipediaSectionPart).filter(Boolean))];
  // Предлог повторяется у каждого раздела: без него второй элемент читается
  // как «и разделе ar.wikipedia.org».
  return parts.length > 0 ? enumerateRu(parts.map((p) => `в ${p}`)) : "";
}

/**
 * Хвост «проверка выполнена <дата>» для проверок, названных в предложении.
 *
 * Дата у каждой записи своя, а предложение называет несколько разделов сразу,
 * поэтому дату первой записи приписать всем нельзя — это утверждение о работе,
 * которой в тот день не было. Даты называются все; если хотя бы у одной
 * проверки даты нет, хвост опускается целиком: назвать часть значило бы
 * отнести названные даты и к недатированной проверке.
 */
function checkDatesClause(checks: Array<{ checkedAt?: string }>): string {
  if (checks.length === 0) return "";
  const dates: string[] = [];
  for (const c of checks) {
    const date = c.checkedAt ? formatRuDate(c.checkedAt) : null;
    if (!date) return "";
    if (!dates.includes(date)) dates.push(date);
  }
  return dates.length === 1
    ? `, проверка выполнена ${dates[0]}`
    : `, проверки выполнены ${enumerateRu(dates, dates.length)}`;
}

/**
 * Измеренное значение метрики по юнитам поверхности.
 *
 * `NOT_COLLECTED`-метрики не складываются: ноль «не собирали» и ноль
 * «собрали, пусто» — разные ответы.
 */
function measuredMetric(units: SurfaceAnalysisUnit[], key: string): number {
  let total = 0;
  for (const unit of units) {
    for (const metric of unit.metrics) {
      if (metric.key !== key || metric.sampleStatus !== "MEASURED") continue;
      if (typeof metric.value === "number") total += metric.value;
    }
  }
  return total;
}

export function buildIdentityFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "wikipedia");
  const subjectClaims = units.flatMap((u) => u.claims.filter((c) => c.subjectMatch === "SUBJECT_MATCH"));
  const foreignClaims = units.flatMap((u) => u.claims.filter((c) => c.subjectMatch === "OTHER_SUBJECT"));

  // §1.4 — prefer factual WikipediaCheck over SERP-domain inference.
  const regionHint = /ОАЭ|UAE|международ/i.test(regionLabel) ? "UAE" : "RU";
  const wikiCheckEntries = Object.entries(scoped.evidenceIndex).filter(([, e]) => {
    if (e.kind !== "wikipedia_check") return false;
    const lang = String(e.language ?? "").toLowerCase();
    const er = String(e.region ?? "").toUpperCase();
    if (regionHint === "RU") {
      return lang.startsWith("ru") || er === "RU";
    }
    // UAE / intl: non-ru languages (en, ar, …).
    return Boolean(lang) && !lang.startsWith("ru");
  });
  // Prefer an exists=true check when several languages/entries match the region.
  const wikiCheck =
    wikiCheckEntries.find(([, e]) => e.wikipediaExists === true) ?? wikiCheckEntries[0];
  const checkExists = wikiCheck ? Boolean(wikiCheck[1].wikipediaExists) : null;
  const checkRef = wikiCheck?.[0];
  /*
   * Наличие статьи и её принадлежность — два разных ответа, и оба уже есть в
   * данных. Проверка Википедии сверяет имя, а не личность: на реальном прогоне
   * `exists=true` записала статью «Глинка (дворянский род)», которую
   * subject-resolution оценил как AMBIGUOUS. Писать «статья о проверяемом лице
   * найдена» можно только при подтверждённой принадлежности.
   */
  const checkSubjectConfirmed = wikiCheck?.[1].subjectDecision === "SUBJECT_MATCH";

  /*
   * Признак присутствия — реально собранные строки, а не число юнитов.
   *
   * Маркер «статья не найдена» тоже создаёт юнит: по `units.length` страница
   * ОАЭ выдавала два таких маркера за «энциклопедические материалы о
   * проверяемом субъекте».
   */
  const collectedRows = measuredMetric(units, "totalCount");
  const subjectRows = measuredMetric(units, "subjectMatchCount");
  const unresolvedRows =
    measuredMetric(units, "ambiguousCount") + measuredMetric(units, "otherSubjectCount");

  const sectionLabel = wikipediaSectionLabel(
    wikiCheckEntries.map(([, e]) => String(e.language ?? ""))
  );
  /*
   * Печатается дата самой проверки, а не дата сборки отчёта: пересобранный
   * через месяц отчёт не вправе выдавать старую проверку за сегодняшнюю.
   * Календарь — общий с остальными датами отчёта (`formatRuDate`), иначе в
   * одном документе соседствовали бы две разные шкалы дат.
   */
  const datesClause = checkDatesClause(wikiCheckEntries.map(([, e]) => e));
  const methodSentence = wikiCheck
    ? `Наличие статьи о проверяемом лице проверено через официальный поисковый API Википедии${
        sectionLabel ? ` ${sectionLabel}` : ""
      }; запрос выполнялся по имени субъекта${datesClause}.`
    : "";

  if (collectedRows === 0 && checkExists === false) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: {
            narrative: `${methodSentence} Результат проверки: статья о проверяемом лице не найдена. Это итог выполненной проверки, а не пропуск сбора; энциклопедических материалов о субъекте в поисковой выдаче по этому контуру также не зафиксировано.`,
            bullets: [WIKIPEDIA_WHY_KNOWLEDGE_PANEL, WIKIPEDIA_WHY_NO_ARTICLE],
            whatToCheck: WIKIPEDIA_ADVICE_CREATE,
          },
          evidenceRefs: checkRef ? [checkRef] : [],
          findingIds: [],
          emptyStateReason: "wikipedia-not-found",
          metrics: { wikipediaCheckExists: 0 },
        }),
      ],
      status: "READY",
    };
  }

  if (collectedRows === 0 && checkExists !== true) {
    /*
     * Результата проверки нет — страница говорит о статусе сбора и молчит о
     * статье: ни метода, ни языкового раздела, ни слов «найдена» / «не
     * найдена». Маркеры «не найдено» доказывают, что зондирование было
     * (MEASURED_EMPTY), но материалами не являются и плитками не печатаются.
     */
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent(
            "no-identity-data",
            emptyStatusForReason(scoped, "no-identity-data")
          ),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-identity-data",
        }),
      ],
      status: "READY",
    };
  }

  // Маркер «статья не найдена» — не строка выдачи: ни плиткой, ни в счёте.
  // Какие ссылки маркерные, знает анализатор (он видел сниппет записи) — здесь
  // читается его ответ, а не выводится второй по заголовку.
  const emptyMarkerRefs = new Set(units.flatMap((u) => u.emptyMarkerRefs ?? []));
  const identityRefs = [
    ...new Set([
      ...units.flatMap((u) => u.evidenceRefs).filter((r) => !emptyMarkerRefs.has(r)),
      ...(checkRef ? [checkRef] : []),
    ]),
  ];
  // Encyclopedia rows actually captured (titles + domains) — shown to the
  // client even when none of them is adverse, so the page reflects reality
  // ("article exists, content neutral") instead of an empty claim list.
  const referenceEntries = identityRefs
    .map((r) => scoped.evidenceIndex[r])
    .filter((e): e is NonNullable<typeof e> => Boolean(e?.title))
    .slice(0, 6)
    .map((e) => clampClientText(`${e.title}${e.domain ? ` — ${e.domain}` : ""}`, 400));
  const bullets = [
    ...subjectClaims.slice(0, 5).map((c) => clampClientText(c.text, 400)),
    // OTHER_SUBJECT is identity pollution, never a neutral subject signal.
    //
    // Одинаковые заголовки схлопываются: на живом прогоне строка «Дуров, Павел
    // Валерьевич» стояла трижды подряд, и читатель видел не три сигнала, а один
    // и тот же трижды (шаг 15, E7).
    ...dedupeByText(foreignClaims.map((c) => c.text))
      .slice(0, 3)
      .map((text) => clampClientText(`Риск смешения с другим лицом (не относится к субъекту): ${text}`, 400)),
  ];
  const shownBullets = bullets.length > 0 ? bullets : referenceEntries;
  const wikiDomains = [
    ...new Set(
      identityRefs
        .map((r) => scoped.evidenceIndex[r]?.domain)
        .filter((d): d is string => Boolean(d) && !isMockClientDomain(d))
    ),
  ].slice(0, 4);
  const hasAdverseRow = identityRefs.some((r) =>
    ADVERSE_PATTERNS.test(String(scoped.evidenceIndex[r]?.title ?? ""))
  );

  const articleTitle = wikiCheck?.[1].title ? `«${wikiCheck[1].title}»` : "";
  const articleUrl = wikiCheck?.[1].url ? clientReadableUrl(wikiCheck[1].url) : "";
  const articleName = [articleTitle, articleUrl].filter(Boolean).join(", ");
  const resultSentence =
    checkExists === true
      ? checkSubjectConfirmed
        ? `Результат проверки: статья о проверяемом лице найдена${articleName ? ` — ${articleName}` : ""}.`
        : `Результат проверки: найдена статья${articleTitle ? ` ${articleTitle}` : ""}${
            articleUrl ? ` (${articleUrl})` : ""
          }, заголовок которой совпадает с именем субъекта; принадлежность статьи проверяемому лицу не подтверждена.`
      : checkExists === false
        ? "Результат проверки: статья о проверяемом лице не найдена. Это итог выполненной проверки, а не пропуск сбора."
        : "Результат отдельной проверки наличия статьи в Википедии для этого контура в отчёте отсутствует, поэтому вывод о наличии или отсутствии статьи не делается.";

  /*
   * Строки выдачи описываются один раз и здесь. Счётная строка «Показано N;
   * из них о субъекте — X» отвечала бы на тот же вопрос второй раз, поэтому на
   * этой странице она не печатается (см. `whatWasFound` ниже).
   */
  const rowsCount = `зафиксирован${pluralRu(collectedRows, "а", "ы", "о")} ${collectedRows} энциклопедическ${pluralRu(
    collectedRows,
    "ая",
    "ие",
    "их"
  )} строк${pluralRu(collectedRows, "а", "и", "")}`;
  const rowsOwnership =
    subjectRows > 0
      ? `из них о субъекте — ${subjectRows}`
      : `принадлежность ${pluralRu(
          collectedRows,
          "материала",
          "материалов",
          "материалов"
        )} проверяемому лицу не подтверждена`;
  const rowsSentence =
    collectedRows > 0
      ? `В поисковой выдаче по контуру ${regionLabel} ${rowsCount}${
          wikiDomains.length ? ` (${enumerateRu(wikiDomains)})` : ""
        }; ${rowsOwnership}.`
      : `Энциклопедических строк в поисковой выдаче по контуру ${regionLabel} не зафиксировано.`;
  const toneSentence = hasAdverseRow
    ? "Отдельные карточки содержат чувствительные формулировки — их содержание отражено в темах повышенного внимания."
    : `Существенных негативных или спорных формулировок в ${
        collectedRows === 1 ? "ней" : "них"
      } не выявлено.`;
  const identitySentence =
    foreignClaims.length > 0
      ? `Справочные ресурсы (${regionLabel}) содержат материалы об одноимённом лице; ниже они отделены от данных проверяемого субъекта.`
      : unresolvedRows === 0
        ? `Материалов об одноимённых лицах в контуре ${regionLabel} не зафиксировано.`
        : "";
  const narrative = [
    methodSentence,
    resultSentence,
    rowsSentence,
    collectedRows > 0 ? toneSentence : "",
    collectedRows > 0 ? identitySentence : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Sidebar strictly scoped to the identity materials displayed on this page.
  const view = buildPageEvidenceView(scoped, identityRefs);
  const pageBlocks = pageFindingBlocks(scoped, view);
  const base = makeSlotSlide({
    slot,
    sectionId,
    content: {
      narrative,
      bullets: shownBullets,
      // Тема повышенного внимания — другой ответ, чем состав строк, и он
      // остаётся. Счётная строка состава — нет: её содержание уже в нарративе.
      whatWasFound: view.findings.length > 0 ? pageBlocks.whatWasFound : undefined,
      whyItMatters:
        checkExists === true
          ? checkSubjectConfirmed
            ? WIKIPEDIA_WHY_ARTICLE_EXISTS
            : WIKIPEDIA_WHY_ARTICLE_NAME_MATCH
          : WIKIPEDIA_WHY_KNOWLEDGE_PANEL,
      whatToCheck:
        checkExists === true
          ? checkSubjectConfirmed
            ? WIKIPEDIA_ADVICE_CONTROL
            : WIKIPEDIA_ADVICE_CONFIRM_OWNERSHIP
          : checkExists === false
            ? WIKIPEDIA_ADVICE_CREATE
            : WIKIPEDIA_ADVICE_UNKNOWN,
      statusNote: pageBlocks.statusNote,
      sourceNote: pageBlocks.sourceNote,
    },
    evidenceRefs: identityRefs,
    findingIds: view.findings.map((f) => f.findingId),
    metrics: {
      subjectClaims: subjectClaims.length,
      identityPollution: foreignClaims.length,
      wikipediaCheckExists: checkExists === true ? 1 : checkExists === false ? 0 : -1,
    },
  });
  return { slides: withContinuations(base, "wikipedia-knowledge"), status: "READY" };
}
