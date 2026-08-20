/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import type { SurfaceAnalysisUnit } from "../../contracts/surface-analysis";
import { slotsForFragment } from "../canonical-slots";
import { DECK_TEMPLATE_REGISTRY } from "../template-registry";
import { packSentencesNoTruncate } from "../semantic-summary-pagination";
import { ADVERSE_PATTERNS } from "../../analytics/surface-analyzers";
import { pluralRu } from "../../../report/i18n/plural-ru";
import { isMockClientDomain } from "../../../services/composite-serp-merge";
import { formatRuDate } from "../../../services/report-material-freshness";
import type { FragmentBuildOutput } from "./shared";
import { clientLink, serpEngineLabel } from "./serp";
import {
  WIKIPEDIA_ARTICLE_LEAD_PREFIX,
  WIKIPEDIA_ARTICLE_LEAD_PREFIX_CONTINUED,
  WIKIPEDIA_ARTICLE_LEAD_PREFIX_UNCONFIRMED,
  WIKIPEDIA_FRAGMENT_CATEGORY_LABELS,
  WIKIPEDIA_FRAGMENT_RECOMMENDATIONS,
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
  pickWikipediaCheckEntry,
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

/** Почему разбор текста статьи не выполнялся — человеческими словами. */
const NOT_REVIEWED_REASONS: Record<string, string> = {
  offline: "прогон выполнялся без обращения к внешним сервисам",
  "model-unavailable": "языковая модель разбора в этом прогоне недоступна",
};

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
 * Значения, названные **каждой** проверкой, — или ничего.
 *
 * Предложение называет несколько языковых разделов сразу, поэтому приписать
 * всем дату (или запрос) первой записи нельзя: это утверждение о работе,
 * которой в тот день не было. Назвать часть тоже нельзя — названное отнеслось
 * бы и к молчащей проверке. Отсюда правило «все или никто», общее для дат и
 * запросов; повторы схлопываются.
 */
function namedByEveryCheck<T>(
  checks: readonly T[],
  value: (check: T) => string | null | undefined
): string[] | null {
  const named: string[] = [];
  for (const check of checks) {
    const item = String(value(check) ?? "").trim();
    if (!item) return null;
    if (!named.includes(item)) named.push(item);
  }
  return named.length > 0 ? named : null;
}

/** Хвост «проверка выполнена <дата>» для проверок, названных в предложении. */
function checkDatesClause(checks: Array<{ checkedAt?: string }>): string {
  const dates = namedByEveryCheck(checks, (c) => (c.checkedAt ? formatRuDate(c.checkedAt) : null));
  if (!dates) return "";
  return dates.length === 1
    ? `, проверка выполнена ${dates[0]}`
    : `, проверки выполнены ${enumerateRu(dates, dates.length)}`;
}

/**
 * «(Google, позиция 1)» — чем и где увидена строка выдачи.
 *
 * Печатается только то, что сообщил поисковик: без позиции — один поисковик,
 * без обоих — ничего. Приписать «позиция 1» строке, у которой позиции нет, —
 * это утверждение о видимости, которого никто не наблюдал.
 */
function serpSourceParenthetical(row: { engine?: string; rank?: number }): string {
  const parts = [
    serpEngineLabel(row.engine),
    typeof row.rank === "number" && row.rank > 0 ? `позиция ${row.rank}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Хвост «запрос: „…“» для проверок, названных в предложении.
 *
 * Печатается дословно то, чем спрашивали: «статья не найдена» верно ровно про
 * этот запрос. Запрос не записан (старый артефакт) — формула остаётся прежней,
 * «по имени субъекта», без домысла.
 */
function checkQueriesClause(checks: Array<{ query?: string }>): string {
  const queries = namedByEveryCheck(checks, (c) => c.query);
  if (!queries) return "запрос выполнялся по имени субъекта";
  const quoted = queries.map((q) => `«${q}»`);
  return queries.length === 1
    ? `запрос: ${quoted[0]}`
    : `запросы: ${enumerateRu(quoted, quoted.length)}`;
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
  // Какую из записей описывает страница — общий ответ с воротами фрагментов.
  const wikiCheck = pickWikipediaCheckEntry(
    wikiCheckEntries.map(([ref, e]) => ({ ref, ...e }))
  );
  const checkExists = wikiCheck ? Boolean(wikiCheck.wikipediaExists) : null;
  const checkRef = wikiCheck?.ref;
  /*
   * Наличие статьи и её принадлежность — два разных ответа, и оба уже есть в
   * данных. Проверка Википедии сверяет имя, а не личность: на реальном прогоне
   * `exists=true` записала статью «Глинка (дворянский род)», которую
   * subject-resolution оценил как AMBIGUOUS. Писать «статья о проверяемом лице
   * найдена» можно только при подтверждённой принадлежности.
   */
  const checkSubjectConfirmed = wikiCheck?.subjectDecision === "SUBJECT_MATCH";
  /** Разбор текста найденной статьи — единственный источник слов о её содержании. */
  const review = wikiCheck?.articleReview;

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
  const queriesClause = checkQueriesClause(wikiCheckEntries.map(([, e]) => e));
  /*
   * Способ находки — часть метода, и он бывает не один.
   *
   * «Поиск по этому запросу статью не нашёл» и «статья существует» — два разных
   * наблюдения: на живом прогоне en-поиск вернул страницу-дизамбигуацию, а
   * статья лежала за межъязыковой ссылкой ru-статьи. Страница называет оба.
   */
  const langlinkCheck = wikiCheckEntries.find(
    ([, e]) => e.foundVia === "langlink" && e.langlinkOf?.language
  );
  const langlinkClause = langlinkCheck
    ? ` Статья в ${wikipediaSectionPart(langlinkCheck[1].language ?? "")} найдена по` +
      ` межъязыковой ссылке из статьи в ${wikipediaSectionPart(
        langlinkCheck[1].langlinkOf?.language ?? ""
      )}.`
    : "";

  const methodSentence = wikiCheck
    ? `Наличие статьи о проверяемом лице проверено через официальный поисковый API Википедии${
        sectionLabel ? ` ${sectionLabel}` : ""
      }; ${queriesClause}${datesClause}.${langlinkClause}`
    : "";

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

  /*
   * Наблюдение, которое спорит с результатом проверки.
   *
   * На прогоне 76 en-проверка ушла кириллическим запросом и вернула «нет», а
   * `en.wikipedia.org/wiki/Viktor_Rashnikov` стоял первой строкой таблицы
   * выдачи того же отчёта. Отрицать статью, которую документ сам показывает,
   * нельзя — но и выводить наличие статьи из выдачи тоже (§1.4): называется
   * дословное наблюдение с адресом и позицией, а не вывод из него.
   *
   * Ищется только в доказательствах этой страницы и только в разделе, который
   * проверяли: статья другого языкового раздела результату проверки не
   * противоречит.
   */
  const deniedDomains = new Set(
    checkExists === false
      ? wikiCheckEntries
          .map(([, e]) =>
            String(e.language ?? "")
              .toLowerCase()
              .split(/[-_]/u)[0]
          )
          .filter(Boolean)
          .map((language) => `${language}.wikipedia.org`)
      : []
  );
  const contradictingRows = identityRefs
    .map((r) => scoped.evidenceIndex[r])
    .filter(
      (e) =>
        e?.kind !== "wikipedia_check" &&
        e?.subjectDecision === "SUBJECT_MATCH" &&
        deniedDomains.has(String(e?.domain ?? "").toLowerCase()) &&
        /\/wiki\//u.test(String(e?.url ?? ""))
    );
  const contradictingClause = contradictingRows.length
    ? `; при этом в поисковой выдаче ${
        contradictingRows.length === 1 ? "зафиксирована статья" : "зафиксированы статьи"
      } ${enumerateRu(
        contradictingRows.map(
          (row) => `${clientLink(row!.url, row!.domain)}${serpSourceParenthetical(row!)}`
        ),
        contradictingRows.length
      )}`
    : "";

  const articleTitle = wikiCheck?.title ? `«${wikiCheck.title}»` : "";
  const articleUrl = wikiCheck?.url ? clientReadableUrl(wikiCheck.url) : "";
  const articleName = [articleTitle, articleUrl].filter(Boolean).join(", ");
  /*
   * Результат проверки — один на все ветки страницы.
   *
   * При `exists=false` формула сужена до запроса: проверка отвечает за то, что
   * не нашла по своему запросу, а не за отсутствие статьи вообще. Абсолютное
   * «статья о проверяемом лице не найдена» стояло рядом с этой же статьёй в
   * таблице выдачи того же отчёта.
   */
  const resultSentence =
    checkExists === true
      ? checkSubjectConfirmed
        ? `Результат проверки: статья о проверяемом лице найдена${articleName ? ` — ${articleName}` : ""}.`
        : /*
           * Называется способ находки, а не мнимое совпадение.
           *
           * Формула «заголовок которой совпадает с именем субъекта» стала
           * достижимой только после снятия чеканки — и на флагманском кейсе она
           * ложна: у «Глинка (дворянский род)» совпала фамилия, а у находки по
           * межъязыковой ссылке заголовок латиницей может не совпадать с нашей
           * транслитерацией вовсе. Верно и достаточно то, что статья найдена по
           * имени субъекта; чем именно она совпала, страница не знает.
           */
          `Результат проверки: по имени субъекта найдена статья${
            articleTitle ? ` ${articleTitle}` : ""
          }${articleUrl ? ` (${articleUrl})` : ""}; принадлежность статьи проверяемому лицу не подтверждена.`
      : checkExists === false
        ? contradictingClause
          ? `Проверка по этому запросу статью не нашла${contradictingClause}.`
          : "Проверка по этому запросу статью не нашла. Это итог выполненной проверки, а не пропуск сбора."
        : "Результат отдельной проверки наличия статьи в Википедии для этого контура в отчёте отсутствует, поэтому вывод о наличии или отсутствии статьи не делается.";

  if (collectedRows === 0 && checkExists === false) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: {
            narrative: `${methodSentence} ${resultSentence} Энциклопедических материалов о субъекте в поисковой выдаче по этому контуру также не зафиксировано.`,
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

  // Encyclopedia rows actually captured (titles + domains) — shown to the
  // client even when none of them is adverse, so the page reflects reality
  // ("article exists, content neutral") instead of an empty claim list.
  const referenceEntries = identityRefs
    .map((r) => scoped.evidenceIndex[r])
    .filter((e): e is NonNullable<typeof e> => Boolean(e?.title))
    .slice(0, 6)
    .map((e) => clampClientText(`${e.title}${e.domain ? ` — ${e.domain}` : ""}`, 400));
  // OTHER_SUBJECT is identity pollution, never a neutral subject signal.
  //
  // Одинаковые заголовки схлопываются: на живом прогоне строка «Дуров, Павел
  // Валерьевич» стояла трижды подряд, и читатель видел не три сигнала, а один
  // и тот же трижды (шаг 15, E7).
  const foreignBullets = dedupeByText(foreignClaims.map((c) => c.text))
    .slice(0, 3)
    .map((text) =>
      clampClientText(`Риск смешения с другим лицом (не относится к субъекту): ${text}`, 400)
    );

  /*
   * Лид и фрагменты идут буллетами, а не карточкой.
   *
   * Карточка `content_card` при нехватке места **молча** отбрасывает
   * предложения: предупреждение уходит в лог, приёмка остаётся зелёной, а со
   * страницы исчезает дословный текст статьи. Путь буллетов после перехода на
   * меру рендерера слышен — переполнение уходит в продолжение, а не в тишину.
   * Любая попытка «переложить» это в карточку вернёт молчаливое урезание.
   */
  const bulletBudget = DECK_TEMPLATE_REGISTRY["wikipedia-check"].layout.itemCharBudget;
  /*
   * Домен внутри дословного текста статьи не вырезается.
   *
   * Здесь стоял гард: строка с доменом, не выводимым из доказательств
   * страницы, не печаталась. Он был обоснован тем, что иначе доменные ворота
   * уронят обязательную секцию, — и это оказалось неправдой: и секционная
   * валидация, и проверка сборки берут буллеты в разбор только у
   * **унаследованной** области (`inheritedScope && !ownScope`), а
   * `wikipedia-check` — own scope и на базовом листе, и на продолжении. То есть
   * гард ничего не предотвращал, зато удалял дословный текст, а на обычной
   * прозе срабатывал ложно: «предприниматель.Он», «г.Москва», «им.Пушкина»
   * выглядят доменом для `DOMAIN_TOKEN_RE`.
   *
   * По существу правило и не нарушается: домен внутри цитаты — часть текста
   * статьи, а не наша ссылка на источник, и источник этой строки назван на том
   * же слайде адресом самой статьи. Собственную прозу страницы (`sourceNote`,
   * «Что обнаружено», объяснения рамок) ворота по-прежнему проверяют.
   */
  const leadPrefix = checkSubjectConfirmed
    ? WIKIPEDIA_ARTICLE_LEAD_PREFIX
    : WIKIPEDIA_ARTICLE_LEAD_PREFIX_UNCONFIRMED;
  // Метка «дословно» стоит на **каждом** листе лида. Лид биографии — 700–1500
  // знаков, он разъезжается на несколько буллетов, и второй без метки читался
  // бы как утверждение отчёта — рядом со строками «Риск смешения с другим
  // лицом» это прямая подмена авторства.
  const leadBullets =
    review && review.lead.trim()
      ? packSentencesNoTruncate(review.lead, bulletBudget).map(
          (chunk, i) => `${i === 0 ? leadPrefix : WIKIPEDIA_ARTICLE_LEAD_PREFIX_CONTINUED}${chunk}`
        )
      : [];
  // Чужой негатив не работает на профиль субъекта: пока принадлежность статьи
  // не подтверждена, её фрагменты не печатаются вовсе.
  /** Сколько фрагментов разбор выделил, но до листа они не дошли. */
  const droppedFragments = review?.status === "REVIEWED" ? review.audit.dropped : 0;
  const fragmentBullets =
    review?.status === "REVIEWED" && checkSubjectConfirmed
      ? review.fragments
          .map((f) => {
            const section = f.section ? ` (раздел «${f.section}»)` : "";
            return `${WIKIPEDIA_FRAGMENT_CATEGORY_LABELS[f.category]}: «${f.quote}» — ${
              f.gloss
            }${section}. ${WIKIPEDIA_FRAGMENT_RECOMMENDATIONS[f.category]}`;
          })
      : [];

  /*
   * Со статьёй на странице строки выдачи в буллетах не нужны: их состав уже
   * описан числом и доменами в нарративе, а на живом прогоне они выродились в
   * трижды повторённый заголовок. Без разбора состав буллетов прежний.
   */
  const bullets = review
    ? [...leadBullets, ...fragmentBullets, ...foreignBullets]
    : [
        ...dedupeByText(subjectClaims.map((c) => c.text))
          .slice(0, 5)
          .map((text) => clampClientText(text, 400)),
        ...foreignBullets,
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
  /*
   * Словарь заголовков говорит о заголовках строк выдачи — и только о них.
   *
   * Пока фраза звучала как «существенных негативных формулировок в них не
   * выявлено», она читалась как утверждение о статье: на живом прогоне она
   * стояла на той же странице, где вердикт прочитанной статьи нашёл санкции и
   * падение состояния. О тексте статьи говорит разбор, и только он.
   */
  const toneSentence = hasAdverseRow
    ? "В заголовках отдельных строк выдачи есть чувствительные формулировки — их содержание отражено в темах повышенного внимания."
    : "В заголовках зафиксированных строк выдачи существенных негативных или спорных формулировок не выявлено.";
  const identitySentence =
    foreignClaims.length > 0
      ? `Справочные ресурсы (${regionLabel}) содержат материалы об одноимённом лице; ниже они отделены от данных проверяемого субъекта.`
      : unresolvedRows === 0
        ? `Материалов об одноимённых лицах в контуре ${regionLabel} не зафиксировано.`
        : "";
  /*
   * Три состояния разбора различаются словами страницы, а не только метрикой.
   *
   * «Мы не смотрели» и «мы посмотрели и ничего не нашли» — разные утверждения,
   * и пустой разбор не имеет права читаться как чистая статья.
   */
  const articleSentence = !review
    ? ""
    : review.status === "NOT_REVIEWED"
      ? `Разбор текста статьи не выполнялся: ${
          NOT_REVIEWED_REASONS[String(review.notReviewedReason ?? "")] ?? "причина не записана"
        }.`
      : !checkSubjectConfirmed
        ? "Фрагменты текста статьи не приводятся, пока принадлежность статьи не подтверждена."
        : fragmentBullets.length > 0
          ? `В тексте статьи выделено ${fragmentBullets.length} фрагмент${pluralRu(
              fragmentBullets.length,
              "",
              "а",
              "ов"
            )}, требующ${pluralRu(
              fragmentBullets.length,
              "ий",
              "их",
              "их"
            )} внимания; каждый приведён дословно с рекомендацией.${
              droppedFragments > 0
                ? ` Ещё ${droppedFragments} не прош${pluralRu(
                    droppedFragments,
                    "ёл",
                    "ли",
                    "ли"
                  )} сверку с текстом статьи и не приводятся.`
                : ""
            }`
          : /*
             * «Не выделено» разрешено только там, где выделять было нечего.
             *
             * Ветка смотрела на число **напечатанного**, и одна фраза покрывала
             * три исхода: разбор ничего не нашёл, аудит снял всё как выдуманное,
             * подавление сняло всё. Банк читал справку о чистой статье ровно в
             * прогоне, где инструмент отработал, а его вывод выброшен.
             */
            droppedFragments > 0
            ? "Выделенные разбором фрагменты не прошли сверку с текстом статьи и в отчёт не вошли; вывод об отсутствии негатива в тексте статьи из этого не следует."
            : "Негативных или спорных фрагментов в тексте статьи не выделено.";
  const truncatedSentence =
    review?.status === "REVIEWED" && review.truncated
      ? `Статья длиннее предела разбора: разобраны первые ${review.reviewedChars} знаков её текста.`
      : "";

  const narrative = [
    methodSentence,
    resultSentence,
    articleSentence,
    truncatedSentence,
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
            ? // Страница назвала статью из выдачи — советовать создать новую
              // значило бы спорить с собственной оговоркой строкой выше.
              contradictingRows.length > 0
              ? WIKIPEDIA_ADVICE_CONFIRM_OWNERSHIP
              : WIKIPEDIA_ADVICE_CREATE
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
      wikipediaArticleFragments: fragmentBullets.length,
      wikipediaArticleFragmentsDropped: droppedFragments,
    },
  });
  return { slides: withContinuations(base, "wikipedia-check"), status: "READY" };
}
