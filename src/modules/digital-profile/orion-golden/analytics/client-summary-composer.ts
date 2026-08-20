/**
 * Stage 5 — deterministic ClientSummaryComposer over ClientSummaryPack.
 *
 * Produces ORION-density Russian client prose; no LLM. The result
 * (`composed-client-summary.json`) is what the deck prints as the executive
 * summary, so this is the single place where the wording of that summary is
 * decided.
 *
 * Два мира тематических блоков. Есть прочитанные страницы — резюме говорит
 * сюжетами из `link-verdicts.json`, теми же строками, что печатает страница «о
 * чём публикации в ТОП-20». Тема претензий, чьи страницы прочитаны, из резюме
 * уходит: прочитанная страница сильнее заголовка выдачи. Не прочитаны —
 * остаётся словарный блок и честно называет своё основание.
 */

import type { ClientReadPlot, ClientSummaryPack } from "../contracts/client-summary-pack";
import {
  COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
  ComposedClientSummarySchema,
  type ComposedClientSummary,
  type ComposedThemeSection,
} from "../contracts/composed-client-summary";
import {
  CLIENT_MATERIAL_QUALIFICATION,
  INTERNAL_CLIENT_TOKEN_RE,
} from "./client-summary-pack-builder";
import { looksLikeSearchQuery } from "./client-quote-hygiene";
import { quoteForClaim } from "./finding-synthesizer";
import { pluralRu } from "../../report/i18n/plural-ru";
import { clientSafeDomain } from "../../services/composite-serp-merge";

/** Lead block keeps this many theme sections; the rest remain full text as continuation. */
const LEAD_THEME_COUNT = 3;

/**
 * Основание словарного блока на прогоне с чтением: его страницы прочитать не
 * удалось. Без этой фразы остаточный блок неотличим от блока, за которым стоит
 * прочитанная страница.
 */
const UNREAD_THEME_BASIS =
  "Страницы по этой теме прочитать не удалось, тема приведена по заголовкам выдачи.";

/**
 * Честный ответ, когда прочитанные страницы негатива не подтвердили.
 *
 * Пустой раздел тем читается как потеря содержимого; строка называет причину и
 * отсылает туда, где перечислены все темы публикаций.
 */
const NO_ADVERSE_PLOTS_NOTE =
  "Существенных негативных сюжетов среди прочитанных страниц не выявлено; " +
  "полный перечень тем публикаций — на страницах «о чём публикации в ТОП-20».";

const INCOMPLETE_SENTENCE_RE =
  /(?:^|[.!?…]\s+)[^.!?…»)]*(?:\b(?:и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|and|or|of|the|to|for|with)\s*|[,:;—–-])$/iu;

export type ComposeClientSummaryInput = {
  pack: ClientSummaryPack;
};

function finishSentence(text: string): string {
  let t = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!t) return "";
  if (!/[.!?…»)]$/u.test(t)) t = `${t}.`;
  return t;
}

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countIncompleteSentences(text: string): number {
  let n = 0;
  for (const s of splitSentences(text)) {
    if (!/[.!?…»)]$/u.test(s)) n += 1;
    else if (INCOMPLETE_SENTENCE_RE.test(s)) n += 1;
  }
  // Also flag dangling whole-text tails without sentence split.
  const flat = text.trim();
  if (flat && !/[.!?…»)]$/u.test(flat)) n += 1;
  return n;
}

function countTechnicalTokens(text: string): number {
  const matches = text.match(new RegExp(INTERNAL_CLIENT_TOKEN_RE.source, "giu"));
  return matches?.length ?? 0;
}

function composeScope(pack: ClientSummaryPack): string {
  const regions = pack.scope.regions.length
    ? pack.scope.regions.join(", ")
    : "доступные региональные контуры";
  // Глубина выдачи называется там же, где класс источника: клиент должен
  // прочитать «результаты поиска (ТОП-20)», а не «поисковая выдача» — иначе
  // фраза обещает проверку всей выдачи, а проверен её первый разворот.
  const depth = pack.scope.searchDepthTopN;
  const sourceClasses = pack.scope.sourceClasses.map((s) =>
    depth && /^поисковая выдача$/iu.test(s.trim()) ? `результаты поиска (ТОП-${depth})` : s
  );
  const sources = sourceClasses.length ? sourceClasses.join(", ") : "открытые источники";
  const period = pack.scope.period.collectedLabel || "по дате сбора в кейсе";
  const newest = pack.scope.period.newestLabel
    ? ` Наиболее свежий материал в наборе: ${pack.scope.period.newestLabel}.`
    : "";
  const limits =
    pack.scope.coverageLimitations.length > 0
      ? ` Ограничения покрытия: ${pack.scope.coverageLimitations.slice(0, 3).join("; ")}.`
      : "";
  return finishSentence(
    `Исследованы ${sources} по регионам ${regions}. Данные сформированы ${period}.${newest}${limits}`
  );
}

function composeOverall(pack: ClientSummaryPack): string {
  const reasons = pack.overallAssessment.reasons.slice(0, 4).map(finishSentence);
  const limitations = pack.overallAssessment.limitations.slice(0, 2).map(finishSentence);
  /*
   * На пути сюжетов основания называет сама оценка, и второй раз они не
   * печатаются.
   *
   * `reasons` — это темы претензий, собранные по заголовкам выдачи. Рядом с
   * оценкой, которая уже перечислила сюжеты прочитанных страниц, они и лишние,
   * и не о том: карточка выходила с названиями дважды подряд, а числа сюжета
   * стояли и в ней, и в его же блоке ниже. Признак — данные пакета, а не разбор
   * собственного текста.
   */
  const parts = [
    /*
     * Вывод печатается тем, чем его написала оценка пакета: своей ступени
     * композитор не приписывает.
     *
     * Приписывал: пакет без единой существенной темы пишет «существенных
     * рисковых тем не выделено; вывод ограничен доступностью данных», а префикс
     * ставил перед этим «Итоговая оценка: низкий риск» — оценка и следом отказ
     * от неё в соседнем предложении. Вердикт аналитики на этом пути не
     * участвовал вовсе: плашка говорила «Недостаточно данных», а текст под ней
     * — «низкий риск». Ступень называет тот, кто её вычислил.
     */
    finishSentence(pack.overallAssessment.conclusion),
    reasons.length > 0 && pack.readPlots.length === 0
      ? `Главные основания. ${reasons.join(" ")}`
      : "",
    limitations.length ? `Ограничения. ${limitations.join(" ")}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * Скобочная отсылка к источнику; опускается, если домен неизвестен или его
 * нельзя называть клиенту (демо-данные).
 */
function sourceSuffix(domain: string | undefined): string {
  const d = clientSafeDomain(domain);
  return d ? ` (${d})` : "";
}

/**
 * Sentence for one representative article, or null when the same material was
 * already described in this summary.
 *
 * A repeat used to produce «Тот же материал «X» также относится к этой теме» —
 * a sentence that carries no information and, on a thin corpus, filled whole
 * slides. Repetition of a source is not a finding; it means the theme has one
 * material, which the caller states once instead.
 */
function articleSentence(
  title: string,
  domain: string,
  description: string,
  alreadyUsedTitles: Set<string>
): string | null {
  const key = title.trim().toLowerCase();
  if (alreadyUsedTitles.has(key)) return null;
  alreadyUsedTitles.add(key);
  /*
   * Обрезанный поисковиком заголовок в кавычки не берётся.
   *
   * В резюме для руководства — на третьей странице отчёта — стояло «Михельсон
   * Леонид Викторович (ИНН 773600432474): в каких...». Многоточие поисковика
   * снималось, и обрывок выглядел законченной цитатой; читатель первым делом
   * видит фразу, из которой ничего не следует. Правило то же, что и в блоках
   * тем: цитируем целое или не цитируем вовсе — описание темы рядом остаётся.
   */
  const quotable = quoteForClaim(title, 220);
  if (!quotable) return finishSentence(description);
  // Prefer concrete description when it already names title/domain.
  if (description.includes(title) || description.includes(domain)) {
    return finishSentence(description);
  }
  // Строка автодополнения — не публикация: у неё нет ни автора, ни адреса, и
  // называть её «материалом» значит выдавать запрос пользователя за источник
  // (шаг 13, C2). Называем тем, что она есть.
  if (looksLikeSearchQuery(title)) {
    return finishSentence(
      `Среди поисковых подсказок встречается запрос «${title}». ${description}`
    );
  }
  return finishSentence(
    `В выборке присутствует материал «${quotable}»${sourceSuffix(domain)}. ${description}`
  );
}

/**
 * Форма фразы: имя темы и перечень доменов не делают её другой.
 *
 * Шаг 13, C5 — оговорка «Публикация (…) содержит утверждения источника…»
 * печаталась шесть раз, а «Сверить первоисточники… по теме «X»» — пять.
 * Отличались они только подставленным именем темы и списком доменов, то есть
 * читателю сообщали одно и то же.
 */
export function boilerplateShape(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/«[^»]*»/gu, "«»")
    .replace(/(?:«»)(?:\s*,\s*«»)+/gu, "«»")
    .replace(/\([^)]*\)/gu, "()")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Оговорка и общий совет печатаются один раз на резюме.
 *
 * Читатель уже видел их в предыдущем блоке — повторять дословно значит
 * превращать резюме в бланк. Отбор общий для блоков сюжетов и словарных тем:
 * оговорка у них одна и та же строка.
 */
function makeOnce(seenBoilerplate: Set<string>): (sentence: string) => string {
  return (sentence: string): string => {
    const s = finishSentence(sentence);
    if (!s) return "";
    const shape = boilerplateShape(s);
    if (seenBoilerplate.has(shape)) return "";
    seenBoilerplate.add(shape);
    return s;
  };
}

/**
 * Блок сюжета: название, счётная фраза, источники, цитаты, оговорка.
 *
 * Числа берутся из пакета, а тот — из строки артефакта: пересчитывать их здесь
 * нельзя, иначе таблица тем и резюме разойдутся на первом краевом случае.
 *
 * Цитат в блоке столько, сколько отобрал пакет, — и если их меньше, чем
 * прочитанных публикаций, блок называет это числом. Пока срез был молчаливым,
 * «по сюжету прочитано 9 публикаций, 9 из них нежелательных» с двумя цитатами
 * читалось как «это всё, что нашли», хотя ровно там и терялись материалы,
 * ради которых сюжет собирался.
 */
function composeReadPlotSection(
  plot: ClientReadPlot,
  once: (sentence: string) => string
): ComposedThemeSection {
  const publications = `${plot.count} ${pluralRu(
    plot.count,
    "публикация",
    "публикации",
    "публикаций"
  )}`;
  const counted =
    plot.adverseCount > 0
      ? `По сюжету прочитано ${publications}, ${plot.adverseCount} из них ${pluralRu(
          plot.adverseCount,
          "нежелательная",
          "нежелательные",
          "нежелательных"
        )}.`
      : `По сюжету прочитано ${publications}.`;
  // Процитированы не все — сказать это числом. Фраза появляется только там, где
  // добавляет сведение: когда цитат столько же, сколько публикаций, она пуста.
  const quotedShare =
    plot.quotes.length > 0 && plot.quotes.length < plot.count
      ? `${pluralRu(
          plot.quotes.length,
          "Процитирована",
          "Процитированы",
          "Процитировано"
        )} ${plot.quotes.length} ${pluralRu(
          plot.quotes.length,
          "публикация",
          "публикации",
          "публикаций"
        )} сюжета из ${plot.count} ${pluralRu(
          plot.count,
          "прочитанной",
          "прочитанных",
          "прочитанных"
        )}.`
      : "";
  const body = [
    counted,
    plot.sourceDomains.length > 0 ? `Источники: ${plot.sourceDomains.join(", ")}.` : "",
    ...plot.quotes.map((q) =>
      q.domain ? `«${q.text}» — источник ${q.domain}.` : `«${q.text}».`
    ),
    quotedShare,
    once(CLIENT_MATERIAL_QUALIFICATION),
  ]
    .filter(Boolean)
    .map(finishSentence)
    .join(" ");

  return {
    themeId: plot.plotId,
    kind: "read_plot",
    heading: plot.title,
    body,
    evidenceRefs: [...plot.evidenceRefs],
    // Заголовков публикаций у сюжета нет: цитаты сверены аудитором дословно по
    // тексту страницы, и заголовок выдачи им не нужен.
    articleTitles: [],
    articleDomains: [...plot.sourceDomains],
  };
}

function composeThemeSection(
  theme: ClientSummaryPack["materialThemes"][number],
  alreadyUsedTitles: Set<string>,
  once: (sentence: string) => string,
  coveredCheckShapes: Set<string>,
  /** Основание блока на прогоне с чтением; пусто на прогоне без него. */
  basisLine = ""
): ComposedThemeSection {
  const articles = theme.representativeArticles.slice(0, 2);
  /*
   * Заголовок, уже названный в выводе темы, отдельным предложением не
   * повторяется.
   *
   * Вывод звучит как «Найдены конкретные материалы, в том числе «X»», а следом
   * шло предложение про тот же «X» — с названием темы в придачу. Читатель
   * получал один и тот же заголовок дважды подряд. `articleSentence` умеет
   * пропускать повторы, но про заголовок из вывода ему никто не сообщал.
   *
   * Проверяется вхождение, а не позиция: при наличии проверенных фактов вывод
   * заголовка не называет, и тогда предложение о нём нужно оставить.
   */
  const leadTitle = articles[0]?.title?.trim();
  if (leadTitle && theme.conclusion.includes(leadTitle)) {
    alreadyUsedTitles.add(leadTitle.toLowerCase());
  }
  const articleBits = articles
    .map((a) => articleSentence(a.title, a.domain, a.conciseCompleteDescription, alreadyUsedTitles))
    .filter((s): s is string => Boolean(s));
  const allegation = articles[0]
    ? once(articles[0].sourceAllegationOrStatus)
    : once(theme.concreteClaims[0] ?? theme.conclusion);
  // Проверки, уже перечисленные разделом «Следующие проверки», в теле темы
  // не повторяются: там они собраны по всем темам одной строкой.
  const ownChecks = theme.recommendedChecks.filter(
    (c) => !coveredCheckShapes.has(boilerplateShape(c))
  );
  const body = [
    // Тема не дублируется: она уже заголовок блока, и `formatSemanticBullet`
    // припишет её к телу, если тело с неё не начинается.
    finishSentence(theme.conclusion),
    articleBits.join(" "),
    allegation,
    once(theme.whyItMatters),
    ownChecks.length ? once(`Что проверить: ${ownChecks.join(" ")}`) : "",
    once(theme.qualification),
    // Основание не проходит через `once`: оно объясняет **этот** блок, и
    // читатель следующего остаточного блока обязан прочитать его снова.
    basisLine,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    themeId: theme.themeId,
    kind: "claims",
    heading: theme.clientTitle,
    body,
    materialityLevel: theme.materialityLevel,
    evidenceRefs: [...theme.evidenceRefs],
    articleTitles: articles.map((a) => a.title),
    articleDomains: articles.map((a) => a.domain),
  };
}

function composeIsolated(pack: ClientSummaryPack): string {
  /*
   * Нечего сказать — блок не пишется.
   *
   * Здесь стояло «Единичные существенные публикации вне устойчивых тем в
   * текущем наборе отдельно не выделены» — отдельный пункт резюме, который
   * сообщает читателю ровно ничего. Правило «пустое состояние честнее
   * выдуманного» относится к собранным поверхностям: если источник не дал
   * данных, страница называет это словами и объясняет причину. Отсутствие
   * единичных публикаций — не сбой сбора и не ограничение, а обычное течение
   * дел, и занимать им строку в резюме руководителя незачем.
   */
  if (pack.isolatedSignificantItems.length === 0) return "";
  const lines = pack.isolatedSignificantItems.slice(0, 5).map((item) =>
    finishSentence(
      `«${item.title}»${sourceSuffix(item.domain)}. ${item.description} ${item.qualification}`
    )
  );
  return [`Единичные существенные публикации.`, ...lines].join(" ");
}

function composeDatabases(pack: ClientSummaryPack): string {
  if (pack.internationalDatabases.length === 0) {
    return finishSentence(
      "Отдельные подтверждённые карточки международных баз в клиентском резюме не сформированы либо требуют отдельной сверки"
    );
  }
  const lines = pack.internationalDatabases.map((d) =>
    finishSentence(
      `${d.databaseName}. ${d.statusSummary} ${d.qualification}`
    )
  );
  return [`Международные базы и официальные источники.`, ...lines].join(" ");
}

function composeChanges(pack: ClientSummaryPack): string {
  const base = finishSentence(pack.changesSinceBaseline.summary);
  const counts = [
    pack.changesSinceBaseline.addedCount != null
      ? `новых материалов: ${pack.changesSinceBaseline.addedCount}`
      : null,
    pack.changesSinceBaseline.removedCount != null
      ? `ушедших из выдачи: ${pack.changesSinceBaseline.removedCount}`
      : null,
  ].filter(Boolean);
  /*
   * Обещание отчёта, которого может не быть, — не содержание.
   *
   * Без счётчиков блок печатал «Изменения относительно baseline. Сравнение с
   * baseline отражено в отдельном отчёте об изменениях, если он доступен» —
   * оговорка «если он доступен» и означает, что сказать нечего. Читатель
   * получал заголовок раздела и отсылку в никуда.
   */
  if (counts.length === 0) {
    const meaningful = base.trim() && !/если он доступен/iu.test(base);
    return meaningful ? `Изменения относительно baseline. ${base}` : "";
  }
  return finishSentence(
    `Изменения относительно baseline (${counts.join(", ")}). ${base}`
  );
}

function composeNextSteps(pack: ClientSummaryPack): string {
  const steps = pack.nextSteps.slice(0, 8).map((s, i) => `${i + 1}) ${finishSentence(s)}`);
  return [`Следующие проверки.`, ...steps].join(" ");
}

/**
 * Заголовок темы и её текст — одной строкой, без повтора заголовка.
 *
 * Ответ на этот вопрос жил в двух местах: дека приписывала заголовок к телу
 * (`formatSemanticBullet`), а сборка полного текста резюме — нет. Пока тело
 * начиналось с названия темы, расхождение было незаметно; стоило убрать оттуда
 * дубль — и в полном тексте темы остались без названий.
 */
export function themeBlockText(heading: string | undefined, body: string): string {
  const h = (heading ?? "").trim();
  if (!h) return body;
  return body.startsWith(h) ? body : `${h}. ${body}`;
}

function assembleFullText(
  sections: ComposedClientSummary["sections"],
  continuationThemeIds: string[]
): string {
  const themeBlocks = sections.themes.map((t) => themeBlockText(t.heading, t.body));
  const lead = themeBlocks.slice(0, LEAD_THEME_COUNT);
  const rest = themeBlocks.slice(LEAD_THEME_COUNT);
  const parts = [
    sections.overallAssessment,
    sections.scope,
    sections.auditShortHeading,
    ...lead,
  ];
  if (rest.length > 0) {
    parts.push("Продолжение резюме — остальные существенные темы.");
    parts.push(...rest);
  }
  parts.push(sections.isolatedItems);
  parts.push(sections.internationalDatabases);
  parts.push(sections.changesSinceBaseline);
  parts.push(sections.nextSteps);
  void continuationThemeIds;
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Count assertions that mention a publication/domain but lack evidenceRefs on the section.
 * Composer only emits theme bodies bound to pack evidence — unsupported = missing refs.
 *
 * Правило «цитата без заголовка публикации» на блок сюжета не распространяется:
 * его цитаты взяты с прочитанной страницы и сверены с её текстом аудитором
 * вердиктов дословно, а заголовка выдачи у сюжета нет вовсе.
 */
function countUnsupportedAssertions(sections: ComposedThemeSection[]): number {
  let n = 0;
  for (const s of sections) {
    if (s.evidenceRefs.length === 0) n += 1;
    if (s.kind !== "read_plot" && /«[^»]{8,}»/.test(s.body) && s.articleTitles.length === 0) {
      n += 1;
    }
  }
  return n;
}

export function composeClientSummary(
  input: ComposeClientSummaryInput
): ComposedClientSummary {
  const pack = input.pack;
  const alreadyUsedTitles = new Set<string>();
  const once = makeOnce(new Set<string>());
  const coveredCheckShapes = new Set(pack.nextSteps.map(boilerplateShape));

  // Предикат пути — данные артефакта, а не флаг конфигурации: есть сюжеты
  // прочитанных страниц — резюме говорит ими.
  const hasReadPlots = pack.readPlots.length > 0;
  const plotRefs = new Set(pack.readPlots.flatMap((p) => p.evidenceRefs));
  const plotSections = pack.readPlots
    .filter((p) => p.adverseCount > 0)
    .map((p) => composeReadPlotSection(p, once));

  // Тема, чьи наблюдения вошли в сюжет (в том числе нейтральный), уже
  // прочитана — печатать её по заголовкам выдачи значило бы вернуть
  // «телеинтервью в криминальной рубрике» на уровень резюме.
  const residualThemes = pack.materialThemes.filter(
    (t) => !t.evidenceRefs.some((r) => plotRefs.has(r))
  );
  // Sort themes: CRITICAL/HIGH first, then by title — deterministic.
  const rank = (m: string | undefined) =>
    m === "CRITICAL" ? 0 : m === "HIGH" ? 1 : m === "MEDIUM" ? 2 : 3;
  const themesSorted = [...residualThemes].sort((a, b) => {
    const d = rank(a.materialityLevel) - rank(b.materialityLevel);
    if (d !== 0) return d;
    return a.themeId.localeCompare(b.themeId);
  });

  const themeSections = [
    ...plotSections,
    ...themesSorted.map((t) =>
      composeThemeSection(
        t,
        alreadyUsedTitles,
        once,
        coveredCheckShapes,
        // Блок комплаенс-базы держится на записи базы, а не на публикациях:
        // «страницы прочитать не удалось» о нём сказало бы неправду.
        hasReadPlots && t.representativeArticles[0]?.claimKind !== "DATABASE_STATUS"
          ? UNREAD_THEME_BASIS
          : ""
      )
    ),
  ];
  const continuationThemeIds = themeSections
    .slice(LEAD_THEME_COUNT)
    .map((t) => t.themeId);

  const sections = {
    scope: composeScope(pack),
    overallAssessment: [
      composeOverall(pack),
      // Материалы были, а печатать в тематических блоках нечего — это надо
      // сказать словами, а не оставить пустое место.
      hasReadPlots && themeSections.length === 0 ? NO_ADVERSE_PLOTS_NOTE : "",
    ]
      .filter(Boolean)
      .join("\n"),
    auditShortHeading: "Коротко по итогам аудита" as const,
    themes: themeSections,
    isolatedItems: composeIsolated(pack),
    internationalDatabases: composeDatabases(pack),
    changesSinceBaseline: composeChanges(pack),
    nextSteps: composeNextSteps(pack),
  };

  const fullText = assembleFullText(sections, continuationThemeIds);

  /*
   * Тема пакета покрыта, если у неё есть свой блок **или** её наблюдения вошли
   * в сюжет. Сравнение ссылок точное: обе стороны пишет один конвейер в одном
   * пространстве `inventory:*` (`run-link-verdicts` и канонические претензии
   * строятся из тех же материалов). Изменится форма ссылки хоть с одной
   * стороны — покрытие станет нулевым, и все темы уйдут в остаток; проверять
   * при смене формата надо именно это.
   */
  const covered = pack.materialThemes.filter(
    (t) =>
      themeSections.some((s) => s.themeId === t.themeId && s.evidenceRefs.length > 0) ||
      t.evidenceRefs.some((r) => plotRefs.has(r))
  );
  const coverage =
    pack.materialThemes.length === 0
      ? 100
      : Math.round((covered.length / pack.materialThemes.length) * 10000) / 100;

  // Блок сюжета конкретен доменами своих страниц: заголовков публикаций у него
  // нет по построению.
  const concreteExamples =
    themeSections.length === 0 ||
    themeSections.every(
      (s) =>
        (s.kind === "read_plot" ? s.articleDomains.length > 0 : s.articleTitles.length > 0) ||
        /«[^»]{8,}»/.test(s.body)
    );

  const techTokens = countTechnicalTokens(fullText);
  const incomplete = countIncompleteSentences(fullText);
  const unsupported = countUnsupportedAssertions(themeSections);

  // Sparse honest path: no invented themes. Печатать нечего и не из чего:
  // ни блоков, ни тем претензий за ними.
  if (themeSections.length === 0 && pack.materialThemes.length === 0) {
    const sparseText = [
      sections.overallAssessment,
      sections.scope,
      sections.auditShortHeading,
      finishSentence(
        "Существенных рисковых тем с репрезентативными материалами в текущей выборке недостаточно для развёрнутого тематического резюме"
      ),
      sections.nextSteps,
    ].join("\n\n");
    return ComposedClientSummarySchema.parse({
      schemaVersion: COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
      caseId: pack.caseId,
      datasetId: pack.datasetId,
      sourceHashes: pack.sourceHashes,
      evidenceRefs: pack.evidenceRefs,
      subjectId: pack.subjectId,
      fullText: sparseText,
      sections: {
        ...sections,
        themes: [],
      },
      continuationThemeIds: [],
      gates: {
        SUMMARY_MATERIAL_THEME_COVERAGE: 100,
        // Vacuous true: no material themes ⇒ no missing concrete examples.
        SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
        SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
        SUMMARY_TECHNICAL_COPY_TOKENS: countTechnicalTokens(sparseText),
        SUMMARY_INCOMPLETE_SENTENCES: countIncompleteSentences(sparseText),
      },
    });
  }

  return ComposedClientSummarySchema.parse({
    schemaVersion: COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
    caseId: pack.caseId,
    datasetId: pack.datasetId,
    sourceHashes: pack.sourceHashes,
    evidenceRefs: pack.evidenceRefs,
    subjectId: pack.subjectId,
    fullText,
    sections,
    continuationThemeIds,
    gates: {
      SUMMARY_MATERIAL_THEME_COVERAGE: coverage,
      SUMMARY_CONCRETE_EXAMPLES_PRESENT: concreteExamples,
      SUMMARY_UNSUPPORTED_ASSERTIONS: unsupported,
      SUMMARY_TECHNICAL_COPY_TOKENS: techTokens,
      SUMMARY_INCOMPLETE_SENTENCES: incomplete,
    },
  });
}

export function assertComposedSummaryGatesPass(summary: ComposedClientSummary): void {
  const g = summary.gates;
  if (g.SUMMARY_MATERIAL_THEME_COVERAGE !== 100) {
    throw new Error(`SUMMARY_MATERIAL_THEME_COVERAGE=${g.SUMMARY_MATERIAL_THEME_COVERAGE}`);
  }
  if (!g.SUMMARY_CONCRETE_EXAMPLES_PRESENT) {
    throw new Error("SUMMARY_CONCRETE_EXAMPLES_PRESENT=false");
  }
  if (g.SUMMARY_UNSUPPORTED_ASSERTIONS !== 0) {
    throw new Error(`SUMMARY_UNSUPPORTED_ASSERTIONS=${g.SUMMARY_UNSUPPORTED_ASSERTIONS}`);
  }
  if (g.SUMMARY_TECHNICAL_COPY_TOKENS !== 0) {
    throw new Error(`SUMMARY_TECHNICAL_COPY_TOKENS=${g.SUMMARY_TECHNICAL_COPY_TOKENS}`);
  }
  if (g.SUMMARY_INCOMPLETE_SENTENCES !== 0) {
    throw new Error(`SUMMARY_INCOMPLETE_SENTENCES=${g.SUMMARY_INCOMPLETE_SENTENCES}`);
  }
}
