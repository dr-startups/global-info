/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY, RED_MARKER_LABEL } from "../template-registry";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { Finding } from "../../contracts/finding";
import { pluralRu } from "../../analytics/finding-synthesizer";
import { clientSafeDomain, clientSafeDomains } from "../../../services/composite-serp-merge";
import { ADVERSE_PATTERNS, NOT_FOUND_PATTERNS } from "../../analytics/surface-analyzers";
import { resolveSourceType } from "../../analytics/source-type";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  RISK_ORDER,
  VISUAL_ASSET_UNAVAILABLE,
  assetsFor,
  buildPageEvidenceView,
  chunk,
  claimText,
  clampClientText,
  composePageRowComposition,
  coverageContent,
  distribute,
  domainOfUrl,
  emptyStatusForReason,
  fitClientSentences,
  findingForVisibleRow,
  isAdverse,
  makeSlotSlide,
  pageFindingBlocks,
  pageRowCompositionBlocks,
  pageScopedConclusion,
  pageSourceLine,
  riskLabel,
  sourceLine,
  splitClientParagraphs,
  subjectQueriesLine,
  enumerateRu,
  statusLine,
  uniqueRefs,
  visualSlide,
  withContinuations,
} from "./shared";

/**
 * Ключ материала для таблицы выдачи (шаг 13, D7).
 *
 * Один и тот же материал приходит из разных запросов с разными идентификаторами
 * наблюдения, поэтому объединяем по тому, что видит читатель: домен и
 * заголовок. Без заголовка ориентируемся на адрес — иначе в одну строку
 * склеились бы разные страницы одного сайта.
 */
export function serpMaterialKey(e: {
  url?: string;
  domain?: string;
  title?: string;
}): string {
  const domain = String(e.domain ?? domainOfUrl(e.url) ?? "")
    .toLowerCase()
    .replace(/^www\./u, "");
  const title = String(e.title ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
  if (title) return `${domain}|${title}`;
  const url = String(e.url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
  return url ? `url:${url}` : `domain:${domain}`;
}

/** Сколько строк выдачи показывает таблица: глубина аудита, не больше. */
export const SERP_TABLE_TOP_N = 20;

/**
 * Колонки таблицы выдачи.
 *
 * Ссылка стоит вместо домена: домен — её начало, а проверяющему нужен адрес,
 * по которому можно открыть материал. Тип источника отвечает на вопрос, ради
 * которого читатель и открывает ссылку: запись в санкционном реестре, статья
 * в СМИ и пост в блоге требуют разной реакции, а в таблице выглядят одинаково.
 */
export const SERP_TABLE_HEADERS = ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"];

/**
 * Оценка материала о другом лице.
 *
 * Однофамилец занимает своё место в выдаче, и вычёркивать его строку нельзя:
 * аудит обещает ТОП-20, а дыра в нумерации читается как потеря данных. Но и
 * «Нейтральный» ему не годится — это оценка материала о субъекте.
 */
export const OTHER_SUBJECT_LABEL = "О другом лице" as const;

/**
 * Номер колонки с оценкой — считается из заголовков, а не пишется числом.
 *
 * Когда в таблицу добавили «Тип источника», счётчики страницы остались смотреть
 * в четвёртую колонку и считали типы источников вместо оценок: на прогоне 14.08
 * `adverseDisplayed` был нулём на всех страницах выдачи.
 */
const RATING_COLUMN = SERP_TABLE_HEADERS.indexOf("Оценка");

/** Длиннее этого адрес перестаёт читаться и ломает ширину колонки. */
const LINK_MAX_CHARS = 62;

/**
 * Адрес для клиента: без протокола и без хвоста параметров, но целиком до
 * последнего значимого сегмента — по нему материал находится вручную.
 */
export function clientLink(url: string | undefined, domain: string | undefined): string {
  const raw = String(url ?? "").trim();
  if (!raw) return domain ?? "—";
  let text = raw.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
  try {
    const parsed = new URL(raw);
    text = `${parsed.hostname.replace(/^www\./u, "")}${parsed.pathname.replace(/\/$/u, "")}`;
    text = decodeURIComponent(text);
  } catch {
    // Не URL — печатаем как есть, обрезав по длине.
  }
  if (text.length <= LINK_MAX_CHARS) return text;
  return `${text.slice(0, LINK_MAX_CHARS - 1)}…`;
}

const SERP_ENGINE_LABELS: Record<string, string> = { YANDEX: "Яндекс", GOOGLE: "Google" };
const SERP_ENGINE_ORDER = ["YANDEX", "GOOGLE"];

/** Ярлык поисковика в том виде, в котором его можно показать клиенту. */
export function normalizeSerpEngine(raw: string | undefined): string | null {
  const e = String(raw ?? "").toUpperCase();
  if (e.includes("YANDEX")) return "YANDEX";
  if (e.includes("GOOGLE") || e.includes("SERPER")) return "GOOGLE";
  return null;
}

/**
 * Запрос, выдачу по которому показывает таблица поисковика.
 *
 * Таблица — это одна страница выдачи, а не сводка по всем запросам сразу.
 * Смешав запросы, мы получили бы две строки с позицией 1 и номер, который
 * ничего не значит. Поэтому на каждый поисковик берётся один запрос: сначала
 * тот, что искал субъекта по имени, при равенстве — давший больше материала,
 * а на совсем равных — первый по алфавиту, чтобы отчёт был воспроизводим.
 */
export function pickSerpTableQuery(
  rows: Array<{ query?: string; queryPurpose?: string }>
): string | null {
  const stats = new Map<string, { count: number; subject: boolean }>();
  for (const r of rows) {
    const q = String(r.query ?? "").trim();
    if (!q) continue;
    const stat = stats.get(q) ?? { count: 0, subject: false };
    stat.count += 1;
    if (String(r.queryPurpose ?? "") === "subject_lookup") stat.subject = true;
    stats.set(q, stat);
  }
  if (stats.size === 0) return null;
  return [...stats.entries()].sort((a, b) => {
    if (a[1].subject !== b[1].subject) return a[1].subject ? -1 : 1;
    if (a[1].count !== b[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0], "ru");
  })[0]![0];
}

/**
 * Одна позиция — один материал.
 *
 * В выдаче не бывает двух третьих строк. В живом отчёте они появились: материал,
 * найденный несколькими запросами, получал подпись одного запроса и номер из
 * другого, и страница показывала две первых позиции и четыре вторых. Позиция
 * теперь считается внутри выбранного запроса, а это — последняя защита на
 * случай данных, где запрос не записан.
 */
export function dropDuplicateRanks<T extends { rank: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.rank)) return false;
    seen.add(row.rank);
    return true;
  });
}

/** Наблюдения одного материала — в одну строку, в порядке первого появления. */
export function mergeSerpRowsByMaterial(
  refs: string[],
  scoped: ScopedFragmentInput
): Array<{ key: string; refs: string[] }> {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const ref of refs) {
    const key = serpMaterialKey(scoped.evidenceIndex[ref] ?? {});
    const list = byKey.get(key);
    if (list) {
      list.push(ref);
      continue;
    }
    byKey.set(key, [ref]);
    order.push(key);
  }
  return order.map((key) => ({ key, refs: byKey.get(key)! }));
}

export function buildSerpFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const organic = scoped.surfaceUnits.filter((u) => u.surface === "organic");
  // NO_RESULTS / «не найден» markers are not real SERP rows — treat as empty
  // so GPT cannot later paint global findings over a phantom table.
  const refs = organic
    .flatMap((u) => u.evidenceRefs)
    .filter((ref) => {
      const e = scoped.evidenceIndex[ref];
      if (!e) return true;
      return !NOT_FOUND_PATTERNS.test(`${e.title ?? ""} ${e.domain ?? ""}`);
    });
  if (refs.length === 0) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent(
            "no-organic-data",
            emptyStatusForReason(scoped, "no-organic-data")
          ),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-organic-data",
        }),
      ],
      status: "READY",
    };
  }
  const adverseRefSet = new Set<string>();
  for (const f of scoped.findings.filter(isAdverse)) for (const r of f.evidenceRefs) adverseRefSet.add(r);
  // Шаг 13, D7 — одна и та же страница, найденная несколькими запросами,
  // печаталась как несколько разных «позиций» (ru.wikipedia.org на 1 и 19,
  // instagram.com на 2, 21 и 28), а у одного ролика соседние строки несли
  // противоположные оценки. Материал в таблице один; оценка у него —
  // сильнейшая из всех наблюдений этого материала.
  const merged = mergeSerpRowsByMaterial(refs, scoped);
  // Таблица выдачи читается сверху вниз как сама выдача: сначала то, что
  // проверяющий увидит первым. Материалы без позиции (старые прогоны,
  // поверхности без номеров) в таблицу не попадают — придумывать им место в
  // выдаче нельзя.
  const engineOfGroup = (group: { refs: string[] }): string | null => {
    for (const ref of group.refs) {
      const e = normalizeSerpEngine(scoped.evidenceIndex[ref]?.engine);
      if (e) return e;
    }
    return null;
  };
  /**
   * Все запросы, которыми найден материал, а не первый попавшийся.
   *
   * Материал в выдаче виден по нескольким запросам сразу: «suleyman kerimov»,
   * «kerimov suleyman» и «Suleyman Abusaidovich Kerimov» приводят к одной и той
   * же странице. Сведение по материалу оставляло за ним запрос того наблюдения,
   * что оказалось первым, и таблица ТОП-20 показывала семь строк из двадцати:
   * остальные восемнадцать материалов «принадлежали» другим запросам. Из
   * двадцати материалов первой двадцатки по «suleyman kerimov» первым
   * наблюдением этот запрос был записан ровно у одного.
   */
  const queriesOfGroup = (group: { refs: string[] }): Map<string, string | undefined> => {
    const out = new Map<string, string | undefined>();
    for (const ref of group.refs) {
      const e = scoped.evidenceIndex[ref];
      if (e?.query && !out.has(e.query)) out.set(e.query, e.queryPurpose);
    }
    return out;
  };
  /**
   * Входит ли материал в выдачу по выбранному запросу.
   *
   * Наблюдения без записанного запроса относим к любому: у старых наборов
   * данных запроса нет вовсе, и отбрасывать их значит потерять таблицу целиком.
   */
  const groupInQuery = (group: { refs: string[] }, query: string | null): boolean => {
    if (!query) return true;
    const queries = queriesOfGroup(group);
    return queries.size === 0 || queries.has(query);
  };
  /**
   * Позиция материала в выдаче по конкретному запросу.
   *
   * Считать её «лучшей по всем наблюдениям» нельзя: материал, найденный
   * несколькими запросами, получал подпись одного запроса и номер из другого —
   * и в таблице появлялись две первых позиции и четыре вторых. В выдаче по
   * одному запросу позиция уникальна, и таблица обязана это сохранять.
   */
  const rankInQuery = (group: { refs: string[] }, query: string | null): number => {
    const rankOf = (ref: string): number | undefined => {
      const r = scoped.evidenceIndex[ref]?.rank;
      return typeof r === "number" && r > 0 ? r : undefined;
    };
    const best = (refs: string[]): number => {
      const ranks = refs.map(rankOf).filter((r): r is number => r !== undefined);
      return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
    };
    if (!query) return best(group.refs);

    /*
     * Позиция берётся у наблюдения по этому самому запросу.
     *
     * Раньше к выбранному запросу относили и наблюдения без записанного запроса
     * — ради старых наборов данных. На прогоне 14.08 это дало таблице чужие
     * места: страница Википедии стояла второй по запросу таблицы, но у неё было
     * наблюдение без запроса с позицией 1, и в отчёте она встала первой. Место
     * 2 при этом никем не занималось, и в нумерации ТОП-20 зияли дыры 2, 11 и
     * 12 — клиент видел семнадцать строк там, где обещано двадцать.
     */
    const exact = group.refs.filter((ref) => scoped.evidenceIndex[ref]?.query === query);
    if (exact.length > 0) return best(exact);
    // Материал, у которого запрос записан, но другой, к этой таблице не
    // относится: показывать его здесь значит придумать ему место в выдаче.
    if (group.refs.some((ref) => scoped.evidenceIndex[ref]?.query)) {
      return Number.MAX_SAFE_INTEGER;
    }
    // Запроса нет ни у одного наблюдения — набор данных собран до того, как
    // запрос стал сохраняться. Такой материал в таблице нужен.
    return best(group.refs);
  };

  // Одна таблица — один поисковик и один запрос: это страница выдачи, которую
  // видит человек. Сводка по всем запросам сразу давала номера, за которыми
  // не стоит ничего: две первых позиции в одном столбце и «36-я строка» там,
  // где аудит обещает ТОП-20.
  //
  // Материалы, у которых поисковик не записан (прогоны до того, как источник
  // стал сохраняться), собираются в таблицу без имени движка. Выбросить их
  // значило бы отдать клиенту пустую страницу там, где выдача есть.
  const byEngine = new Map<string, typeof merged>();
  for (const group of merged) {
    const engine = engineOfGroup(group) ?? "";
    const list = byEngine.get(engine) ?? [];
    list.push(group);
    byEngine.set(engine, list);
  }
  const engineTables = [...byEngine.entries()]
    .sort(
      (a, b) =>
        (SERP_ENGINE_ORDER.indexOf(a[0]) + 1 || 99) - (SERP_ENGINE_ORDER.indexOf(b[0]) + 1 || 99)
    )
    .map(([engine, groups]) => {
      // Запрос выбирается по числу материалов, которые он показал, поэтому в
      // счёт идёт каждая пара «материал — запрос», а не один запрос на материал.
      const query = pickSerpTableQuery(
        groups.flatMap((g) =>
          [...queriesOfGroup(g)].map(([q, queryPurpose]) => ({ query: q, queryPurpose }))
        )
      );
      const scopedGroups = groups.filter((g) => groupInQuery(g, query));
      const ranked = dropDuplicateRanks(
        scopedGroups
          .map((group, index) => ({ group, index, rank: rankInQuery(group, query) }))
          .filter((x) => x.rank <= SERP_TABLE_TOP_N)
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
      ).slice(0, SERP_TABLE_TOP_N);
      if (ranked.length > 0) return { engine, query, displayed: ranked, positional: true };
      // Прогоны, собранные до того, как позиция стала сохраняться, позиций не
      // несут вовсе. Показать такую выдачу можно, назвать её ТОП-20 — нет:
      // строки нумеруются порядком сбора, и заголовок это признаёт.
      const unranked = scopedGroups
        .map((group, index) => ({ group, index, rank: index + 1 }))
        .slice(0, SERP_TABLE_TOP_N);
      return { engine, query, displayed: unranked, positional: false };
    })
    .filter((t) => t.displayed.length > 0);

  // Материалы без поисковика показываются только когда показывать больше
  // нечего. Рядом с названными таблицами такая страница ничего не сообщает:
  // ни где стоял материал, ни в каком поисковике его видно.
  const namedTables = engineTables.filter((t) => t.engine);
  const tables = namedTables.length > 0 ? namedTables : engineTables;

  const displayed = tables.flatMap((t) => t.displayed.map((x) => x.group));
  const displayedRefs = displayed.flatMap((g) => g.refs);
  const rowOf = (group: { refs: string[] }, rank: number): string[] => {
    const e = scoped.evidenceIndex[group.refs[0]!] ?? {};
    // A row is marked when its evidence backs an adverse finding OR its own
    // title carries an adverse pattern (sanctions/criminal/court wording) —
    // clearly negative rows must never show a green "Нейтральный" badge.
    const adverse = group.refs.some((ref) => {
      const ev = scoped.evidenceIndex[ref] ?? {};
      return (
        ev.adverse === true ||
        adverseRefSet.has(ref) ||
        ADVERSE_PATTERNS.test(String(ev.title ?? ""))
      );
    });
    const likely = group.refs.some(
      (ref) => scoped.evidenceIndex[ref]?.subjectDecision === "LIKELY_SUBJECT"
    );
    /*
     * Материал о другом лице занимает своё место в выдаче и называется прямо.
     *
     * Аудит обещает ТОП-20 и обязан показать двадцать строк: строка, вычеркнутая
     * из таблицы, оставляет дыру в нумерации, и читатель считает её потерей
     * данных. Однофамилец при этом не должен выглядеть материалом о субъекте —
     * поэтому у него своя оценка, а не «Нейтральный».
     */
    const other =
      group.refs.length > 0 &&
      group.refs.every((ref) => scoped.evidenceIndex[ref]?.subjectDecision === "OTHER_SUBJECT");
    // Red marker must always carry its label; domain comes from evidence URL.
    // LIKELY (§2.1) → «Вероятно» — visible but not confirmed-subject KPI.
    const rating = other
      ? OTHER_SUBJECT_LABEL
      : adverse
        ? RED_MARKER_LABEL
        : likely
          ? "Вероятно"
          : "Нейтральный";
    // Номер строки — настоящая позиция в выдаче, а не счётчик строк таблицы.
    // Счётчик выдавал «24-е место в Яндексе» там, где материал стоял третьим
    // по другому запросу.
    return [
      String(rank),
      clientLink(e.url, e.domain),
      e.title ?? "(без заголовка)",
      resolveSourceType({ fromVerdict: e.sourceType, domain: e.domain ?? domainOfUrl(e.url) }) ?? "—",
      rating,
    ];
  };
  // §7.1: each continuation page gets its own row-scoped sidebar (not a blank
  // strip of the first page's finding blocks).
  const maxRows =
    DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide > 0
      ? DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide
      : 12;
  // Страницы не смешивают поисковики: каждая таблица листается отдельно и
  // подписана своим поисковиком и запросом.
  const pages: Array<{ title: string; rows: string[][]; refs: string[] }> = [];
  for (const table of tables) {
    const label = table.engine ? SERP_ENGINE_LABELS[table.engine] ?? table.engine : null;
    const tableRows = table.displayed.map((x) => rowOf(x.group, x.rank));
    const tableRefs = table.displayed.map((x) => x.group.refs);
    const rowChunks = chunk(tableRows, maxRows);
    const refChunks = chunk(tableRefs, maxRows).map((c) => c.flat());
    for (let i = 0; i < rowChunks.length; i += 1) {
      const suffix = rowChunks.length > 1 ? ` (${i + 1}/${rowChunks.length})` : "";
      // Заголовок начинается с региона, и он же начинает предложение: «ОАЭ»
      // приходит меткой раздела, а «международный» — строчным.
      const region = regionLabel.charAt(0).toUpperCase() + regionLabel.slice(1);
      const depth = table.positional ? `, ТОП-${SERP_TABLE_TOP_N}` : ": собранная выдача";
      const head = label ? `${region} — ${label}${depth}` : `${region} — выдача${table.positional ? `, ТОП-${SERP_TABLE_TOP_N}` : ""}`;
      pages.push({
        title: `${head}${suffix}`,
        rows: rowChunks[i] ?? [],
        refs: refChunks[i] ?? [],
      });
    }
  }
  const queriesLine = subjectQueriesLine(scoped);
  /*
   * Страница тем: о чём именно нежелательные публикации.
   *
   * Эталон отрасли ставит её сразу после списка ссылок и печатает рядом с
   * каждой темой число публикаций. Числа сходятся с метрикой выше — это и
   * делает таблицу проверяемой, а не декоративной.
   *
   * Темы приходят из чтения страниц. Если чтение выключено, страницы нет:
   * рубрики из справочника показывать под таким заголовком нельзя, они не
   * отвечают на вопрос «о чём публикация».
   */
  /*
   * Темы берутся по своему контуру.
   *
   * Свод по всему прогону стоял и на российской странице, и на странице ОАЭ —
   * одинаковый. Российский раздел отвечал на вопрос «о чём публикации в ТОП-20
   * России» числами, в которых половина материала из международной выдачи.
   * Общего свода нет только у старых прогонов — тогда берём его как раньше.
   */
  const regionKey = key.startsWith("RU_") ? "RU" : "UAE";
  const byRegion = scoped.metricSnapshot.linkThemesByRegion?.[regionKey];
  const linkThemes = (byRegion ?? scoped.metricSnapshot.linkThemes ?? []).filter(
    (t) => t.count > 0
  );
  const themesPage =
    linkThemes.length > 0
      ? {
          title: `${regionLabel.charAt(0).toUpperCase()}${regionLabel.slice(1)} — о чём публикации в ТОП-${SERP_TABLE_TOP_N}`,
          rows: linkThemes
            .slice(0, 12)
            .map((t) => [t.theme, String(t.count), String(t.adverseCount)]),
          unread: scoped.metricSnapshot.linkUnreadCount ?? 0,
        }
      : null;

  const slides: SlideContentContract[] = [];
  const baseSlideId = slot.slotId;
  for (let i = 0; i < pages.length; i += 1) {
    const pageRefs = pages[i]!.refs;
    const pageRows = pages[i]!.rows;
    const view = buildPageEvidenceView(scoped, pageRefs);
    // Renderer `orion_golden_search_table` paints only `narrative` above the
    // table (not whatWasFound/bullets when rows exist) — put the §7.1 sidebar
    // conclusion there so the page composition is visible in PDF/PPTX.
    const pageBlocks = pageFindingBlocks(scoped, view);
    const slide = makeSlotSlide({
      slot,
      sectionId,
      title: pages[i]!.title,
      content: {
        table: { headers: [...SERP_TABLE_HEADERS], rows: pageRows },
        ...pageBlocks,
        // Клиент должен видеть, по чему смотрели: без набора запросов позиция
        // в таблице — число без знаменателя (см. `docs/etalon-orion-razbor.md`).
        narrative: [queriesLine, pageBlocks.whatWasFound].filter(Boolean).join(" "),
      },
      evidenceRefs: pageRefs,
      findingIds: view.findings.map((f) => f.findingId),
      metrics: {
        datasetCount: refs.length,
        uniqueMaterials: merged.length,
        displayedCount: pageRows.length,
        adverseDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === RED_MARKER_LABEL).length,
        likelyDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === "Вероятно").length,
        otherSubjectDisplayed: pageRows.filter((r) => r[RATING_COLUMN] === OTHER_SUBJECT_LABEL)
          .length,
        pageIndex: i + 1,
        pageCount: pages.length,
      },
    });
    if (i === 0) {
      slides.push(slide);
    } else {
      slides.push({
        ...slide,
        slideId: `${baseSlideId}__cont${i}`,
        isContinuation: true,
        continuationOf: baseSlideId,
        continuationIndex: i,
      });
    }
  }
  if (themesPage) {
    const adverseTotal = linkThemes.reduce((n, t) => n + t.adverseCount, 0);
    // Покрытие называется словами агента чтения: сколько прочитано и почему
    // остальные — нет. «N не открылись» скрывает разницу между отказом сайта
    // и поломкой у нас, а эталон отрасли пишет причины прямо.
    const readingLine = scoped.metricSnapshot.linkReadingLine;
    const unreadNote = readingLine
      ? ` ${readingLine}`
      : themesPage.unread > 0
        ? ` ${themesPage.unread} ${pluralRu(themesPage.unread, "страница", "страницы", "страниц")} не открылись — они в подсчёт тем не вошли.`
        : "";
    slides.push({
      ...makeSlotSlide({
        slot,
        sectionId,
        title: themesPage.title,
        content: {
          narrative:
            `Публикации из ТОП-${SERP_TABLE_TOP_N} прочитаны, и каждая отнесена к теме по своему содержанию. ` +
            `Нежелательных публикаций: ${adverseTotal}.${unreadNote}`,
          table: {
            headers: ["Тема", "Публикаций", "Из них нежелательных"],
            rows: themesPage.rows,
          },
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: { themes: linkThemes.length, adverseTotal, unread: themesPage.unread },
      }),
      slideId: `${baseSlideId}__themes`,
      isContinuation: true,
      continuationOf: baseSlideId,
      continuationIndex: slides.length,
    });
  }
  return { slides, status: "READY" };
}

export function buildSerpScreenshotFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const screenshots = Object.entries(scoped.evidenceIndex).filter(
    ([, e]) => e.kind === "serp_screenshot"
  );
  // Rows actually rendered on the bound snapshot, with the SAME red-frame
  // marking the snapshot generator produced. Sidebar copy is derived from
  // these rows only — never from region- or bundle-level findings.
  const visibleRows = (extras.visualAssets?.[slot.slotId] ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  const boundAssetRefs = assetsFor(extras, slot.slotId);
  // Fail-closed: no bound visual → never invent «на этом снимке / деловые материалы».
  if (boundAssetRefs.length === 0 && visibleRows.length === 0) {
    const slide = visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        narrative: `Снимок первой страницы выдачи (${regionLabel}) недоступен в текущем наборе.`,
        whatWasFound:
          "Визуальный снимок выдачи недоступен; текстовые выводы по содержимому снимка не формируются.",
        whyItMatters:
          "Без снимка нельзя подтвердить, что именно видит пользователь на первой странице в этом регионе.",
        whatToCheck:
          "Повторить сбор скриншота выдачи или сверить органическую таблицу результатов на соседних страницах.",
        sourceNote: "Источник: снимок поисковой выдачи недоступен.",
      },
      evidenceRefs: screenshots.map(([ref]) => ref),
      findingIds: [],
      metrics: { screenshots: screenshots.length, adverseHighlights: 0 },
      noUnderlyingData: false,
    });
    return { slides: [slide], status: "READY" };
  }
  const adverseRows = visibleRows.filter((v) => v.adverse);

  // One explanation per red-framed row, attributed to the finding whose
  // evidence that row is (dedup by finding+domain).
  const seenExplanation = new Set<string>();
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const explainedFindings: Finding[] = [];
  const explainedDomains: string[] = [];
  const explainedRefs: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const theme = f?.theme ?? row.themeTitle ?? "Потенциально нежелательный материал";
    const domain = row.domain ?? "—";
    const dedupKey = `${f?.findingId ?? theme}|${domain}`;
    if (seenExplanation.has(dedupKey)) continue;
    seenExplanation.add(dedupKey);
    const level = f
      ? `уровень: ${riskLabel(f.riskLevel).toLowerCase()}`
      : "требует ручной проверки";
    explanations.push({
      clientReason: clampClientText(`«${theme}» — выделенный результат ${domain}; ${level}.`, 300),
      frameTone: "red" as const,
    });
    if (f && !explainedFindings.some((x) => x.findingId === f.findingId)) explainedFindings.push(f);
    // Демо-домен не называется клиенту даже как подпись к снимку.
    const safeRowDomain = clientSafeDomain(row.domain);
    if (safeRowDomain && !explainedDomains.includes(safeRowDomain)) explainedDomains.push(safeRowDomain);
    if (scoped.evidenceIndex[row.ref]) explainedRefs.push(row.ref);
  }
  explainedFindings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  const top = explainedFindings[0];

  // Engine coverage limitation visible on the snapshot itself (e.g. Google
  // holds the highlighted result while the Yandex panel has no stored rows).
  const engines = new Set(visibleRows.map((v) => (v.engine ?? "").toUpperCase()).filter(Boolean));
  const engineNote = !engines.has("YANDEX")
    ? " Выделенные результаты — в выдаче Google; по Яндексу сохранённых результатов в наборе нет."
    : !engines.has("GOOGLE")
      ? " Выделенные результаты — в выдаче Яндекса; по Google сохранённых результатов в наборе нет."
      : "";

  // Headline: page-specific summary of what is framed on THIS snapshot —
  // details per theme live in the highlight explanations (no duplication).
  const headlineDomains = explainedDomains.slice(0, 4);
  const whatWasFound = adverseRows.length
    ? clampClientText(
        `На снимке выделено результатов повышенного внимания: ${explanations.length}` +
          (headlineDomains.length
            ? ` (${headlineDomains.join(", ")}${explainedDomains.length > headlineDomains.length ? " и др." : ""})`
            : "") +
          "; остальные результаты — нейтральные или деловые.",
        400
      )
    : visibleRows.length > 0
      ? "Выделенных результатов повышенного внимания на этом снимке нет; зафиксированы деловые и справочные материалы."
      : "На снимке нет сохранённых строк выдачи для описания состава страницы.";

  const neutralVisibleDomains = [
    ...new Set(clientSafeDomains(visibleRows.map((v) => v.domain))),
  ].slice(0, 3);
  // The sidebar footer is narrow: cap the listed domains so the note always
  // ends with a complete phrase instead of clipping mid-sentence.
  // Перечисление через `enumerateRu`: союз перед последним доменом отличает
  // предложение от выгрузки списка (тот же приём, что в pageSourceLine).
  const sourceNote = explainedDomains.length
    ? `Источники на снимке — ${enumerateRu(explainedDomains)}.`
    : neutralVisibleDomains.length
      ? `Видимые на снимке источники — ${enumerateRu(neutralVisibleDomains)}.`
      : "Источник — снимок поисковой выдачи.";

  const slide = visualSlide({
    slot,
    sectionId,
    extras,
    scoped,
    content: {
      narrative: `Состояние первой страницы выдачи (${regionLabel}).${engineNote}`,
      whatWasFound,
      // Coverage limitation is part of "why it matters": it is rendered in the
      // sidebar on adverse pages, unlike the narrative (dropped there).
      whyItMatters: clampClientText(
        (explanations.length
          ? `Выделенные материалы (${explanations.length}) видны при первичной проверке субъекта в этом регионе.`
          : "Первая страница выдачи не формирует негативного фона вокруг субъекта в этом регионе.") +
          engineNote,
        320
      ),
      whatToCheck: clampClientText(
        top?.recommendedAction ?? "Проверить первоисточники выделенных результатов.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote,
      // Every red highlight on the snapshot is explained by the finding whose
      // evidence that row is — strictly page-scoped.
      highlightExplanations: explanations.length ? explanations : undefined,
    },
    evidenceRefs: [
      ...new Set([
        ...screenshots.map(([ref]) => ref),
        ...visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r])),
        ...explainedRefs,
      ]),
    ],
    findingIds: explainedFindings.map((f) => f.findingId),
    metrics: {
      screenshots: screenshots.length,
      adverseHighlights: explanations.length,
    },
    noUnderlyingData: false,
  });
  return { slides: [slide], status: "READY" };
}
