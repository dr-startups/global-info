/**
 * Scoped inputs for independent section/surface builders.
 *
 * Allowed shared read-only inputs: SubjectProfile, VerifiedFindingBundle,
 * MetricSnapshot, ThemeSet, TemplateRegistry. Every fragment builder receives
 * ONLY a scoped slice filtered by region / surface / subjectMatch / findingId
 * — never UAE findings inside an RU builder, never the raw observation
 * dataset, never the whole executive summary.
 */

import { createHash } from "node:crypto";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { SurfaceKind } from "../contracts/common";
import type { LinkReadingReport } from "../analytics/link-reading-agent";
import type { WikipediaArticleReview } from "../contracts/wikipedia-article-review";
import { serpMaterialKey } from "../../serp-observation/material-key";
import type { AnalystDecision } from "../../serp-observation/resolve-observation-highlights";

export type SubjectProfileInput = {
  displayName: string;
  aliases: string[];
};

/** Прочитанное и негативное по одному региональному контуру. */
export type LinkReadRegionCounts = {
  /** Отобрано к чтению (включая непрочитанное) — уникальные ссылки корзины. */
  requested: number;
  /** Из них удалось прочитать. */
  read: number;
  /** Из прочитанных признано материалом о другом лице. */
  readOther: number;
  /** Из прочитанных: о субъекте и нежелательно — числитель доли. */
  adverseRead: number;
};

export type MetricSnapshot = {
  metricSnapshotId: string;
  datasetId: string;
  reportRunId: string;
  baseCount: number;
  enrichmentCount: number;
  compositeCount: number;
  /**
   * Предмет аудита: сколько материалов вошло в анализ — ТОП-20 выдачи плюс
   * международные базы (`analysis-scope.json`). Это не то же самое, что
   * `compositeCount`: собрано всегда шире, чем видно в выдаче, и страница
   * обязана называть оба числа своими словами, а не выдавать одно за другое.
   */
  analyzedCount?: number;
  /** Глубина выдачи, объявленная клиенту (обычно 20). */
  analysisTopN?: number;
  /**
   * Разрезы «движок × регион», давшие материал в аудит. Отчёт называет
   * поисковики и страны по этому списку, а не по заготовленной фразе: если
   * выдачу по региону собрать не удалось, обещать её проверку нельзя.
   */
  analysisLanes?: Array<{ engine: string; region: string; analyzed: number }>;
  /**
   * Темы, собранные по прочитанным страницам: формулировка и сколько
   * публикаций её подтверждают. Эталон отрасли показывает такую таблицу сразу
   * после списка ссылок — она отвечает на вопрос «о чём именно нежелательные
   * публикации», и её числа сходятся с метрикой выше.
   */
  linkThemes?: Array<{ theme: string; count: number; adverseCount: number }>;
  /**
   * Те же темы, но по контурам выдачи. Российская страница отчёта обязана
   * показывать российские числа: общий свод отвечал на её вопрос числами из
   * выдачи ОАЭ.
   */
  linkThemesByRegion?: Record<string, Array<{ theme: string; count: number; adverseCount: number }>>;
  /**
   * Прочитанное и негативное по региональным контурам — основание доли
   * негатива на странице региона и в резюме.
   *
   * Числитель — `adverseRead`: прочитанные страницы региона, признанные
   * материалом о субъекте с нежелательным тоном. Знаменатель — `read −
   * readOther`: прочитанные минус признанные чужими. Однофамилец ничего не
   * подтверждает о субъекте и не вправе разбавлять долю — по этому же правилу
   * живут таблица тем, резюме и таблица выдачи. «Вероятно» и «неясно» из
   * знаменателя не выкидываются: они не подтверждены как чужие, и читатель
   * видит их в выдаче; в числитель они не попадают никогда.
   *
   * Поля нет, если страницы в прогоне не читались, — тогда доля не печатается
   * вовсе, словами о причине, а не нулём.
   */
  linkReadByRegion?: Record<string, LinkReadRegionCounts>;
  /** Сколько страниц не удалось прочитать — честная часть покрытия. */
  linkUnreadCount?: number;
  /**
   * Отчёт агента чтения целиком: сколько запрошено, сколько прочитано и по
   * каким причинам отказано.
   *
   * Раньше здесь лежала готовая клиентская строка. Из неё нельзя было собрать
   * ни абсолют при полном чтении, ни оговорку внутри того предложения, которое
   * шаблон печатает: строка была написана до того, как стало известно, куда
   * она попадёт. Состояние — это данные, а слова по ним собирает построитель.
   */
  linkReading?: LinkReadingReport;
  subjectMatchCount: number;
  /** Surname+context / shared domain — visible but not KPI (§2.1). */
  likelySubjectCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  adverseFindingCount: number;
  perRegionCounts: Record<string, number>;
  /** «Вероятно о субъекте» в разрезе региона — глобальное число здесь врёт. */
  perRegionLikelyCounts?: Record<string, number>;
};

export type FragmentScope = {
  regions: string[] | null; // null = all regions (executive)
  surfaces: SurfaceKind[] | null; // null = all surfaces
  /**
   * Optional override for surface-unit filtering when it must differ from the
   * finding filter (e.g. regional summary: all regional findings + url_audit
   * units only). When omitted, `surfaces` governs both.
   */
  unitSurfaces?: SurfaceKind[] | null;
  subjectMatch: Array<Finding["subjectMatch"]> | null;
  findingIds: string[] | null;
};

/** Point lookup for scoped evidence refs only — never the raw dataset. */
export type ScopedEvidenceIndex = Record<
  string,
  {
    url?: string;
    domain?: string;
    title?: string;
    /**
     * Текст наблюдения.
     *
     * Заведён для нейро-ответов: страница обязана печатать сам ответ, а не его
     * заголовок. Пока индекс нёс только `title`, обещание методики «ответы
     * приводятся полностью, без сокращений» данными не подкреплялось — в claim
     * ехал заголовок, срезанный до 300 знаков.
     */
    snippet?: string;
    /**
     * Явное решение аналитика по материалу — первый источник предиката
     * негативности.
     *
     * Отдельным полем, а не записью в `adverse`: `adverse` значит «прочитанная
     * страница признана нежелательной и подтверждена дословной цитатой» (из
     * него `evidenceRowVerdict` выводит `quoted`), и записать туда решение
     * человека значило бы утверждать, что страницу открыли и процитировали,
     * когда её никто не открывал.
     */
    analystDecision?: AnalystDecision;
    /** Код причины решения разметки — им таблица выдачи отличает «только имя». */
    subjectReason?: string;
    /**
     * Кто добыл наблюдение. Подпись под ответом поискового ИИ выводится из
     * него: «получен официальным Yandex Search API» — утверждение о способе
     * получения, и оно обязано следовать данным, а не схеме адреса.
     */
    provider?: string;
    adverse?: boolean;
    kind?: string;
    region?: string;
    /** Search engine the observation was captured from (YANDEX/GOOGLE). */
    engine?: string;
    /**
     * Ссылка числится примером «прочих материалов» своего региона.
     *
     * Признак принадлежности к перечню, а не описание материала: региональное
     * резюме цитирует такие ссылки, и по этому признаку они попадают в область
     * фрагмента. Раньше признаком служил `kind: "uncategorized"`, который
     * ингестия записывала поверх наблюдения — вместе с ним стирались позиция,
     * запрос и движок строки выдачи.
     */
    uncategorizedExample?: boolean;
    /** Compliance databases: human-readable provider name (Dow Jones, ...). */
    providerLabel?: string;
    /** Compliance databases: match category (PEP / ADVERSE_MEDIA / SANCTIONS). */
    matchCategory?: string;
    /** Compliance databases: match score 0–100. */
    matchScore?: number;
    /** Compliance databases: review status (e.g. PENDING). */
    reviewStatus?: string;
    /**
     * Поля карточки записи комплаенс-базы: они уже лежат в
     * `dp_database_profiles`, и страница базы печатает их вместо счётчика.
     * Каждое опционально: старый артефакт без них читается как «поля нет», а
     * отсутствующее поле не печатается вовсе — прочерк утверждал бы, что поля
     * нет в самой записи.
     */
    aliases?: string[];
    countries?: string[];
    datesOfBirth?: string[];
    /**
     * Собственное имя записи из `dp_database_profiles.matchedName`.
     *
     * `title` для этого не годится: там уже стоит результат подстановки
     * (`pickComplianceClientMatchTitle`), и запись без своего имени неотличима
     * от записи, названной именем субъекта.
     */
    matchedName?: string;
    /**
     * LOW / MEDIUM / HIGH — уверенность сопоставления с субъектом.
     *
     * Клиенту не печатается (шкала ушла из отчёта решением владельца
     * 26.08.2026), но в пакете секции остаётся: пакет читает аналитик, и там
     * это часть ответа на вопрос «почему запись приехала».
     */
    confidence?: string;
    /** Идентификатор записи у провайдера — для запроса полной карточки. */
    profileId?: string;
    /** Сводка записи провайдера (client-safe, без машинных кодов тем). */
    summary?: string;
    /** WikipediaCheck.exists — factual check, not SERP domain inference. */
    wikipediaExists?: boolean;
    /** WikipediaCheck.language (ru / en / …). */
    language?: string;
    /**
     * Как статья нашлась: `search` или `langlink`. Страница называет способ
     * находки словами — «поиск по этому запросу статью не нашёл, статья взята
     * по межъязыковой ссылке» — потому что это два разных наблюдения.
     */
    foundVia?: string;
    /** Раздел-источник межъязыковой ссылки, по которой найдена статья. */
    langlinkOf?: { language?: string; title?: string };
    /**
     * Разбор текста самой статьи: основное описание и фрагменты, требующие
     * внимания.
     *
     * Единственный источник фразы страницы о содержании статьи. Словарь
     * заголовков (`getAdversePatterns`) говорит о заголовках строк выдачи и о
     * тексте статьи ничего не знает: на живом прогоне он писал «существенных
     * негативных формулировок не выявлено» рядом с прочитанной статьёй, где
     * вердикт нашёл санкции и падение состояния.
     */
    articleReview?: Pick<
      WikipediaArticleReview,
      | "status"
      | "notReviewedReason"
      | "lead"
      | "sections"
      | "fragments"
      | "truncated"
      | "reviewedChars"
      | "articleTextChars"
      | "subjectMatch"
      // Отчёт аудита обязателен на этой стороне: без него построитель не может
      // отличить «разбор ничего не нашёл» от «разбор нашёл, а сверка сняла всё»,
      // и печатает «негатива не выделено» в обоих случаях.
      | "audit"
    >;
    /**
     * Когда проверка выполнялась (ISO). Страница печатает эту дату, а не дату
     * подготовки отчёта: пересборка старого прогона не должна выдавать старую
     * проверку за сегодняшнюю.
     */
    checkedAt?: string;
    /** Subject-resolution decision for this evidence ref (§2.1). */
    subjectDecision?: string;
    /**
     * Позиция материала в выдаче — то, что сообщил поисковик. Нужна там, где
     * страница говорит о видимости: таблица выдачи начинается с того, что
     * проверяющий увидит первым, а не с того, что первым собралось.
     */
    rank?: number;
    /**
     * Чья позиция записана в `rank` — yandex, serper, arsenkin или unknown.
     *
     * Таблица ТОП-20 печатает только позиции родного поисковика: список
     * Яндекса — из выдачи Яндекса, список Google — из Serper. Нумерация
     * обогатителя считает выдачу по-своему и в списках не участвует.
     */
    rankSource?: string;
    /**
     * Номера, которые дал каждый измеритель: `{"yandex": 15, "arsenkin": 17}`.
     *
     * Пропуск номера в таблице объясняется этим полем: «позиция 17 занята
     * материалом, показанным выше под другим номером» прослеживается до него,
     * а без него лист сказать этого не может и молчит. Необязательное —
     * наборы, снятые до его проводки, поля не несут.
     */
    ranksByProvider?: Record<string, number>;
    /**
     * Запрос, по которому материал показался. Позиция без запроса не значит
     * ничего: таблица выдачи строится по разрезу «запрос × поисковик», и
     * колонку нечем подписать, если запрос не доехал до клиентского слоя.
     *
     * У записи проверки Википедии — запрос самой проверки: страница печатает
     * его дословно, потому что «статья не найдена» верно ровно про тот запрос,
     * которым спрашивали. Старый артефакт поля не несёт, и страница печатает
     * прежнюю формулу «по имени субъекта».
     */
    query?: string;
    /** Назначение запроса из плана (`subject_lookup`, `adverse_lookup`, …). */
    queryPurpose?: string;
    /**
     * Запрос строки — само имя субъекта, а не производное написание.
     *
     * Все написания ФИО несут один `queryPurpose`, поэтому таблица не может
     * отличить их по назначению. Пометку ставит набор запросов слоя сбора;
     * здесь она только читается — вычислять её заново, сравнивая запрос с
     * именем профиля, нельзя: в латинском контуре запрос транслитерирован.
     */
    subjectNameQuery?: boolean;
    /**
     * Что за площадка стоит за ссылкой: реестр, СМИ, блог, соцсеть. Значение
     * из закрытого списка `analytics/source-type.ts` — его называет модель,
     * прочитавшая страницу, иначе оно выводится по домену.
     */
    sourceType?: string;
    /**
     * Тон прочитанной страницы по вердикту модели: `adverse`, `neutral`,
     * `supportive`. Есть только у страниц, которые удалось прочитать.
     *
     * Отличается от `adverse` тем, что говорит о происхождении оценки. Тема
     * повышенного внимания не вправе цитировать материал, чью страницу
     * прочитали и признали нейтральной: словарь ключевых слов нашёл в
     * заголовке «суд», а на странице оказалось интервью.
     */
    readVerdictTone?: "adverse" | "neutral" | "supportive";
    /**
     * О чём публикация — одной фразой по-русски, из решения по прочитанной
     * странице.
     *
     * Нужно там, где цитируется иноязычный заголовок. Переводить цитату нельзя:
     * в кавычках клиенту показали бы слова, которых источник не писал, и любая
     * неточность перевода стала бы нашим утверждением о факте. Оригинал
     * остаётся дословным, а рядом печатается изложение — явно наше, строкой
     * «О чём: …».
     */
    verdictTheme?: string;
    /**
     * Дословная цитата с прочитанной страницы, проверенная аудитором.
     *
     * Заголовок выдачи поисковик режет по своей ширине, и цитировать его —
     * значит показывать клиенту обрывок вроде «…в отношении него после».
     * Страница даёт целое предложение, и оно всегда предпочтительнее.
     */
    pageQuote?: string;
    /**
     * Почему страницу не удалось прочитать: `blocked`, `not_found`, `timeout`,
     * `empty_text`, `not_fetched`, `analysis_failed`.
     *
     * Пустое состояние честнее выдуманного: страница отчёта, объясняя рамку,
     * обязана сказать, что вывод сделан по заголовку выдачи, и назвать причину.
     * Без этого поля непрочитанная строка и строка, которую не читали вовсе,
     * выглядели для читателя одинаково.
     */
    readFailure?: string;
    /**
     * Что решение по прочитанной странице сказало о принадлежности материала:
     * `subject`, `likely`, `other`, `unclear`.
     *
     * Отдельно от `subjectDecision`: там ответ сопоставления идентификаторов,
     * которым размечена таблица выдачи, здесь — ответ прочитавшего страницу.
     * Нужен ровно для оговорки во фразе «Почему выделено»: утверждать о
     * субъекте по материалу, чья принадлежность лишь вероятна, нельзя.
     */
    verdictSubjectMatch?: string;
  }
>;

/**
 * REMEDIATION §7.4 — why a surface page is empty.
 * - MEASURED_EMPTY: collection ran, zero materials (honest «проверено, пусто»)
 * - MEASURED_PARTIAL: одна поисковая система проверена, другую не спрашивали
 * - NOT_COLLECTED: surface was not gathered in this run
 * - COLLECTION_FAILED: agent/provider failed (client-safe reasonLabel only)
 */
export type EmptySurfaceCollectionKind =
  | "MEASURED_EMPTY"
  | "MEASURED_PARTIAL"
  | "NOT_COLLECTED"
  | "COLLECTION_FAILED";

export type SurfaceCollectionHint = {
  surface: string;
  region?: string;
  /**
   * Поисковая система ячейки покрытия (YANDEX / GOOGLE).
   *
   * Без неё «проверено» одной системы распространялось на все: на прогоне 76
   * разобранная выдача Google превращала страницу в утверждение о проверке
   * нейро-ответов Яндекса, которых никто не спрашивал.
   */
  engine?: string;
  /** Raw coverage status (OK / NO_RESULTS / ERROR / …) — never shown to client. */
  status: string;
  errorCode?: string | null;
  provider?: string;
};

/**
 * Итог скрининга по одной комплаенс-базе — последний ран из
 * `dp_compliance_screening_runs`, переложенный в `compliance-inventory.json`.
 *
 * Признак — данные, а не название: есть строка рана — проверка была, нет
 * строки — не была. Без этого страница базы не могла отличить «проверено,
 * совпадений нет» от «проверка не выполнялась» и печатала первое всегда.
 */
export type ComplianceScreeningRecord = {
  provider: string;
  /** SUCCESS | FAILED | NOT_CONFIGURED | DISABLED | PROVIDER_ERROR. */
  status: string;
  hitCount: number;
  finishedAt?: string | null;
  errorCode?: string | null;
};

/**
 * Имя артефакта прогона с решением о персоне субъекта.
 *
 * Пишет его подготовка отчёта, читает загрузчик входов деки; ни один из них не
 * должен знать литерал второй раз. База при сборке деки не читается вовсе —
 * решение приезжает снимком, снятым до первой траты.
 */
export const PERSONA_DECISION_ARTIFACT = "persona-decision.json";

/**
 * Решение оператора о том, о ком собираем, — снимок для отчёта.
 *
 * Отчёт читает сам субъект, и ошибка в различении однофамильцев стоит ему
 * денег и действий: он пойдёт добиваться удаления чужого материала. Поэтому в
 * снимке лежит то, чем читатель может **проверить** выбор, — источник карточки
 * и её адрес, а не одно имя. Оценки совпадения здесь нет намеренно: то же
 * решение, по которому шкала ушла из сводной таблицы комплаенса.
 */
export type PersonaDecisionRecord = {
  decision: "PERSONA_SELECTED" | "ANCHORS_CONFIRMED" | "APPROVED_WITHOUT_PERSONA";
  /**
   * Признаки субъекта, названные оператором, и где они нашлись в пробе, —
   * основание решения `ANCHORS_CONFIRMED`. Лист «Кого проверяли» печатает их
   * словами: читатель должен видеть, чем материал отличали от материала тёзки.
   */
  anchors?: {
    birthDate: string | null;
    phrases: Array<{ kind: string; text: string; strong: boolean }>;
    inn: string[];
    domains: string[];
    /** Адреса, на которых признаки нашлись при проверке до сбора. */
    confirmedOn: string[];
  } | null;
  /** Выбранная карточка; null — решение принято без персоны. */
  selected: {
    /** `wikipedia` | `knowledge_graph` | `opensanctions`. */
    source: string;
    title: string;
    /** Адрес карточки; null — источник его не дал. */
    url: string | null;
    /**
     * Структурная дата рождения записи — единственная, которую можно печатать.
     * Дата из прозаического лида статьи сюда не разбирается: неверно
     * разобранная дата рядом с именем это тихая ложь о человеке.
     */
    datesOfBirth: string[];
  } | null;
  /** Состояние источников панели на момент решения. */
  sources: Array<{ source: string; status: string }>;
  /** Сколько различимых карточек панель показала оператору. */
  cardCount: number;
  /**
   * Когда решение приняли. На страницу не печатается — владелец решил, что в
   * блоке стоят источник, заголовок, дата рождения записи и адрес, — но в
   * артефакте прогона остаётся: без неё нельзя сказать, каким решением собран
   * этот отчёт.
   */
  decidedAt: string | null;
};

export type EmptySurfaceCollectionStatus = {
  kind: EmptySurfaceCollectionKind;
  /** Human-readable cause for NOT_COLLECTED / FAILED; never internal codes. */
  reasonLabel?: string;
  /**
   * Поисковые системы частичного состояния — ключами (YANDEX / GOOGLE).
   * Клиентские имена подставляет слой текста: здесь данные, не формулировки.
   */
  measuredEngines?: string[];
  notCollectedEngines?: string[];
};

export type ScopedFragmentInput = {
  subject: SubjectProfileInput;
  findings: Finding[];
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  /** Evidence details restricted to refs reachable from the scoped slice. */
  evidenceIndex: ScopedEvidenceIndex;
  /** Optional coverage/provider hints for empty-state copy (§7.4). */
  surfaceCollectionHints?: SurfaceCollectionHint[];
};

const REGION_ALIASES: Record<string, string[]> = {
  RU: ["RU"],
  UAE: ["UAE", "INTERNATIONAL", "GLOBAL"],
};

/**
 * Normalize evidence refs so a run's asset refs (`serp_observation:<id>`,
 * `ru_search_results-sf-<id>`) and finding refs (`inventory:serp-obs-<id>`,
 * `inventory:ss-<id>`) compare by the underlying observation/result id.
 */
export function normalizeEvidenceRef(ref: string): string {
  return ref
    .replace(/^serp_observation:/u, "")
    .replace(/^inventory:serp-obs-/u, "")
    .replace(/^inventory:ss-/u, "")
    .replace(/^[a-z]+_search_results-sf-/u, "");
}

/**
 * Какой материал стоит за строкой индекса доказательств — один ответ на слой деки.
 *
 * Ключ наблюдения включает запрос, поэтому одна и та же страница, найденная
 * двумя запросами, лежит в индексе двумя ссылками. Читателю она при этом одна:
 * и решение по прочитанной странице, и счёт материалов темы считают её один раз.
 *
 * Запись без адреса и без домена материалом ни с кем не делится. В индексе
 * живёт не только выдача: у записи комплаенс-базы нет ни адреса, ни домена, а
 * заголовок — имя субъекта, одинаковое у всех баз. На корпусе `report-72` три
 * записи (Dow Jones, LexisNexis, World-Check) сошлись бы в один ключ `|имя`.
 *
 * Спрашивают отсюда все, кому единицей служит материал: счёт темы на
 * региональной странице, разнос решений по прочитанным страницам и сведение
 * строк печатной таблицы выдачи (`mergeSerpRowsByMaterial`). У последней был
 * свой вызов без запасного ключа — на строках выдачи неотличимый (у них всегда
 * есть адрес) и всё же второй ответ.
 */
export function evidenceMaterialKey(
  entry: ScopedEvidenceIndex[string] | undefined,
  ref: string
): string {
  if (!entry?.url && !entry?.domain) return ref;
  return serpMaterialKey(entry, ref);
}

export function regionMatches(scopeRegion: string, value: string | undefined): boolean {
  if (!value) return false;
  const aliases = REGION_ALIASES[scopeRegion] ?? [scopeRegion];
  return aliases.includes(value.toUpperCase());
}

export function scopeFindings(bundle: VerifiedFindingBundle, scope: FragmentScope): Finding[] {
  return bundle.findings.filter((f) => {
    if (scope.findingIds && !scope.findingIds.includes(f.findingId)) return false;
    if (scope.subjectMatch && !scope.subjectMatch.includes(f.subjectMatch)) return false;
    if (scope.regions) {
      const hit = scope.regions.some((r) => (f.regions ?? []).some((fr) => regionMatches(r, fr)));
      if (!hit) return false;
    }
    // Empty surfaces array means "no surface units, but findings unfiltered"
    // (summary/executive scopes depend on findings, not per-surface claims).
    if (scope.surfaces && scope.surfaces.length > 0) {
      const kinds = (f.surfaceKinds ?? []) as string[];
      // Findings without surface tags stay visible to summary-level scopes only.
      if (kinds.length > 0 && !kinds.some((k) => (scope.surfaces as string[]).includes(k))) {
        return false;
      }
    }
    return true;
  });
}

export function scopeSurfaceUnits(
  units: SurfaceAnalysisUnit[],
  scope: FragmentScope
): SurfaceAnalysisUnit[] {
  const unitFilter = scope.unitSurfaces !== undefined ? scope.unitSurfaces : scope.surfaces;
  return units.filter((u) => {
    if (unitFilter && !unitFilter.includes(u.surface)) return false;
    if (scope.regions && !scope.regions.some((r) => regionMatches(r, u.region))) return false;
    return true;
  });
}

/** Map Arsenkin/coverage surface tokens onto SurfaceKind keys. */
export function normalizeCoverageSurface(raw: string): string {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return s;
  if (s === "paa" || s === "related" || s === "paa_related") return "paa_related";
  // `knowledge_block` группируется сюда же: ровно так группирует анализатор
  // поверхности, и без этого измеренная ячейка панели знаний не гасила пробел
  // «ответы ИИ-поиска» в сводке — два грейдера мерили разными линейками.
  if (
    s === "ai_answer" ||
    s === "ai" ||
    s === "ai_answers" ||
    s === "knowledge" ||
    s === "knowledge_block"
  ) {
    return "ai_answers";
  }
  if (s === "autocomplete" || s === "suggest" || s === "suggestions") return "suggestions";
  if (s === "indexation" || s === "page_meta" || s === "url_audit") return "url_audit";
  if (s === "wiki" || s === "wikipedia") return "wikipedia";
  if (s === "image" || s === "images") return "images";
  if (s === "organic" || s === "serp" || s === "search") return "organic";
  if (s === "compliance" || s === "databases") return "compliance";
  return s;
}

/**
 * Поисковая система, которую клиентский текст умеет назвать.
 *
 * Один ответ на вопрос «что это за движок»: по нему и группируются состояния
 * сбора, и подставляются имена в текст. Всё прочее (MULTI, имя провайдера)
 * — внутренний токен, и в отчёт он не попадает.
 */
export function clientNamedSearchEngine(raw: string | undefined): string | null {
  const e = String(raw ?? "").toUpperCase();
  if (e.includes("YANDEX")) return "YANDEX";
  if (e.includes("GOOGLE") || e.includes("SERPER")) return "GOOGLE";
  return null;
}

/** Статус ячейки: сбор по ней состоялся. */
function isMeasuredStatus(status: string | undefined): boolean {
  return /^(OK|NO_RESULTS|EMPTY_VALID|SUCCESS|MEASURED)$/i.test(String(status ?? ""));
}

/**
 * Статус ячейки: вопрос не задавали.
 *
 * Это не сбой: сбоем считается всё, что не белый список и не эти два статуса,
 * — и «не спрашивали» попало бы в ветвь «не удалось собрать», то есть в другую
 * ложь.
 */
function isNotCollectedStatus(status: string | undefined): boolean {
  return /^(NOT_COLLECTED|DISABLED)$/i.test(String(status ?? ""));
}

/**
 * Насколько причина «не собирали» пригодна для печати, когда их несколько.
 *
 * На составе по умолчанию по одной паре «регион + поверхность» приходят две
 * ячейки: «инструмент не входил в состав» (решение, которое никто не менял) и
 * «провайдер не настроен» (то, что владелец может исправить одной переменной).
 * Печатать надо ту, по которой можно действовать, — и выбор обязан быть
 * правилом, а не порядком конкатенации ячеек в `coverageRows`.
 */
function notCollectedCauseRank(errorCode?: string | null): number {
  const code = String(errorCode ?? "");
  if (/NOT_CONFIGURED/i.test(code)) return 2;
  if (/DISABLED/i.test(code)) return 1;
  return 0;
}

/** Самая пригодная к действию причина среди ячеек «не спрашивали». */
function strongestNotCollectedCause(hints: SurfaceCollectionHint[]): string | null {
  let best: { rank: number; code?: string | null } | null = null;
  for (const h of hints) {
    if (!isNotCollectedStatus(h.status)) continue;
    const rank = notCollectedCauseRank(h.errorCode);
    if (!best || rank > best.rank) best = { rank, code: h.errorCode };
  }
  return best ? clientNotCollectedLabel(best.code) : null;
}

/** Причина «не собирали» для клиента — без внутренних кодов. */
function clientNotCollectedLabel(errorCode?: string | null): string {
  const code = String(errorCode ?? "");
  if (/NOT_CONFIGURED/i.test(code)) return "провайдер не настроен";
  if (/DISABLED/i.test(code)) return "инструмент сбора не входил в состав прогона";
  // Вопрос задан, провайдер отказал (Topvisor не собирает подсказки Google по
  // российским регионам): это не «не спрашивали».
  if (/NOT_SUPPORTED/i.test(code)) return "провайдер не собирает эту поверхность для региона";
  return "поверхность не собиралась в этом прогоне";
}

/** Client-safe failure cause — internal status/errorCode never leak. */
export function clientCollectionFailureLabel(
  status: string,
  errorCode?: string | null
): string {
  const code = String(errorCode ?? "").toUpperCase();
  const st = String(status ?? "").toUpperCase();
  if (/DISABLED|SKIPPED|UNAVAILABLE|NOT_ENABLED/i.test(code) || /DISABLED|SKIPPED|UNAVAILABLE/i.test(st)) {
    return "агент отключён в этом прогоне";
  }
  if (/NOT_SUPPORTED/i.test(st) || /NOT_SUPPORTED/i.test(code)) {
    return "поверхность не поддерживается выбранным провайдером";
  }
  if (/FAILED_PARSE|PARSE/i.test(st) || /FAILED_PARSE|PARSE/i.test(code)) {
    return "ответ провайдера не удалось разобрать";
  }
  if (/RESULT_FETCH_FAILED|FETCH/i.test(st) || /FETCH/i.test(code)) {
    return "не удалось получить результат у провайдера";
  }
  if (/HTTP_?5|TIMEOUT|ERROR|FAIL/i.test(st) || /HTTP_?5|TIMEOUT|ERROR/i.test(code)) {
    return "ошибка при сборе данных";
  }
  return "сбор по поверхности завершился с ошибкой";
}

/**
 * Decide empty-state kind for a surface from unit metrics + coverage hints.
 * Prefer MEASURED (incl. empty markers / NO_RESULTS) over NOT_COLLECTED.
 */
export function resolveEmptySurfaceCollection(
  scoped: Pick<ScopedFragmentInput, "surfaceUnits" | "scope" | "surfaceCollectionHints">,
  surface: string
): EmptySurfaceCollectionStatus {
  const surfaceKey = normalizeCoverageSurface(surface);
  const units = scoped.surfaceUnits.filter((u) => u.surface === surfaceKey);
  const regionScope = scoped.scope.regions;

  const hints = (scoped.surfaceCollectionHints ?? []).filter((h) => {
    if (normalizeCoverageSurface(h.surface) !== surfaceKey) return false;
    if (!regionScope || !h.region) return true;
    return regionScope.some((r) => regionMatches(r, h.region));
  });

  // Состояние сбора считается по каждой поисковой системе отдельно: «проверено»
  // печатается только про ту, которую действительно спрашивали. Подсказки без
  // движка (все прочие поверхности) в разбиение не входят и ведут себя как
  // раньше.
  const partial = partialByEngine(hints);
  if (partial) return partial;

  const failedHint = hints.find((h) => isFailedHint(h));
  if (failedHint) {
    return {
      kind: "COLLECTION_FAILED",
      reasonLabel: clientCollectionFailureLabel(failedHint.status, failedHint.errorCode),
    };
  }

  const notCollectedReason =
    strongestNotCollectedCause(hints) ?? clientNotCollectedLabel(undefined);
  const measuredHint = hints.some((h) => isMeasuredStatus(h.status));

  let anyMeasured = measuredHint;
  let anyNotCollected = false;
  for (const u of units) {
    for (const m of u.metrics) {
      if (m.sampleStatus === "MEASURED") anyMeasured = true;
      if (m.sampleStatus === "NOT_COLLECTED") anyNotCollected = true;
    }
  }

  if (anyMeasured || units.some((u) => u.evidenceRefs.length > 0)) {
    return { kind: "MEASURED_EMPTY" };
  }

  // B.4 — «сбор не запускался» и «сбор выполнен, для региона данных нет» —
  // разные состояния. Если по этой же поверхности в прогоне есть измеренный
  // сбор за пределами регионального скоупа, страница региона честно говорит
  // «выполнено, по региону пусто», а не «не собиралась».
  const measuredElsewhere = (scoped.surfaceCollectionHints ?? []).some(
    (h) => normalizeCoverageSurface(h.surface) === surfaceKey && isMeasuredStatus(h.status)
  );
  if (measuredElsewhere) {
    return {
      kind: "MEASURED_EMPTY",
      reasonLabel: "сбор по поверхности выполнен; материалов по данному региону не получено",
    };
  }

  if (anyNotCollected || hints.length > 0 || units.length === 0) {
    return { kind: "NOT_COLLECTED", reasonLabel: notCollectedReason };
  }
  return { kind: "MEASURED_EMPTY" };
}

/** Сбой сбора — всё, что не измерение, не «не спрашивали» и не пустой статус. */
function isFailedHint(hint: SurfaceCollectionHint): boolean {
  const st = String(hint.status ?? "").toUpperCase();
  return (
    st.length > 0 &&
    !isMeasuredStatus(st) &&
    !isNotCollectedStatus(st) &&
    !/^N\/?A$/i.test(st)
  );
}

/**
 * Частичное состояние: по одной поисковой системе сбор был, по другой — нет.
 *
 * Внутри одной системы приоритет прежний: сбой сильнее измерения, а измерение
 * сильнее «не спрашивали» (на прогоне 76 по Google одновременно есть
 * разобранная выдача и невыполненный запрос к инструменту провайдера — и
 * разобранная выдача остаётся фактом).
 */
function partialByEngine(
  hints: SurfaceCollectionHint[]
): EmptySurfaceCollectionStatus | null {
  const byEngine = new Map<string, SurfaceCollectionHint[]>();
  for (const h of hints) {
    const engine = clientNamedSearchEngine(h.engine);
    if (!engine) continue;
    const group = byEngine.get(engine);
    if (group) group.push(h);
    else byEngine.set(engine, [h]);
  }
  if (byEngine.size < 2) return null;

  const measuredEngines: string[] = [];
  const notCollectedEngines: string[] = [];
  let reasonLabel: string | undefined;
  for (const engine of [...byEngine.keys()].sort()) {
    const group = byEngine.get(engine)!;
    const failed = group.find((h) => isFailedHint(h));
    if (!failed && group.some((h) => isMeasuredStatus(h.status))) {
      measuredEngines.push(engine);
      continue;
    }
    notCollectedEngines.push(engine);
    if (reasonLabel) continue;
    reasonLabel = failed
      ? clientCollectionFailureLabel(failed.status, failed.errorCode)
      : strongestNotCollectedCause(group) ?? undefined;
  }
  if (measuredEngines.length === 0 || notCollectedEngines.length === 0) return null;
  return { kind: "MEASURED_PARTIAL", reasonLabel, measuredEngines, notCollectedEngines };
}

export function buildScopedInput(input: {
  subject: SubjectProfileInput;
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  scope: FragmentScope;
  evidenceIndex?: ScopedEvidenceIndex;
  surfaceCollectionHints?: SurfaceCollectionHint[];
}): ScopedFragmentInput {
  const findings = scopeFindings(input.bundle, input.scope);
  const surfaceUnits = scopeSurfaceUnits(input.surfaceUnits, input.scope);
  // Restrict the evidence index to refs reachable from the scoped slice.
  const reachable = new Set<string>();
  for (const f of findings) for (const r of f.evidenceRefs) reachable.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) reachable.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) reachable.add(r);
  }
  const evidenceIndex: ScopedEvidenceIndex = {};
  const unitFilter =
    input.scope.unitSurfaces !== undefined ? input.scope.unitSurfaces : input.scope.surfaces;
  const wantsSurface = (s: string): boolean =>
    unitFilter == null || (unitFilter as string[]).includes(s);
  // Region+surface-scoped observation evidence not reachable through claims
  // (e.g. the exact observation rows a bound visual asset was built from).
  // `kind` carries the surface for composite observations; visual/structured
  // kinds map onto their owning surface explicitly.
  const KIND_TO_SURFACE: Record<string, string> = {
    serp_screenshot: "organic",
    knowledge_block: "ai_answers",
  };
  for (const [ref, entry] of Object.entries(input.evidenceIndex ?? {})) {
    if (reachable.has(ref)) {
      evidenceIndex[ref] = entry;
      continue;
    }
    // REMEDIATION §3.2 — themeless subject materials are not attached to
    // findings/units; admit them by region so regional summaries can cite them
    // without failing sidebar-scope QA.
    if (entry.uncategorizedExample === true) {
      if (
        input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region))
      ) {
        evidenceIndex[ref] = entry;
      }
      continue;
    }
    const surfaceOfKind = entry.kind ? KIND_TO_SURFACE[entry.kind] ?? entry.kind : undefined;
    if (
      surfaceOfKind &&
      wantsSurface(surfaceOfKind) &&
      (input.scope.regions == null ||
        input.scope.regions.some((r) => regionMatches(r, entry.region)))
    ) {
      evidenceIndex[ref] = entry;
    }
  }
  return {
    subject: input.subject,
    findings,
    surfaceUnits,
    metricSnapshot: input.metricSnapshot,
    scope: input.scope,
    evidenceIndex,
    surfaceCollectionHints: input.surfaceCollectionHints,
  };
}

/** Deterministic hash of the scoped input (cache key with promptVersion). */
export function scopedInputHash(scoped: ScopedFragmentInput): string {
  const payload = JSON.stringify({
    subject: scoped.subject,
    findings: scoped.findings.map((f) => ({
      id: f.findingId,
      claim: f.claim,
      risk: f.riskLevel,
      match: f.subjectMatch,
      refs: f.evidenceRefs,
      priority: f.promotionPriority,
    })),
    units: scoped.surfaceUnits.map((u) => ({
      surface: u.surface,
      region: u.region,
      metrics: u.metrics,
      claims: u.claims.map((c) => ({ id: c.claimId, text: c.text, match: c.subjectMatch })),
    })),
    snapshot: scoped.metricSnapshot,
    scope: scoped.scope,
    evidence: scoped.evidenceIndex,
    surfaceCollectionHints: scoped.surfaceCollectionHints ?? [],
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
