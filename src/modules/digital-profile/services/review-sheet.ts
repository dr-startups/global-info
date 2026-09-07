/**
 * Лист проверки: что напечатано в черновике и что о нём решила машина.
 *
 * Аналитик не может пройти отчёт глазами: 64 страницы, полторы сотни
 * напечатанных материалов и девять тем, и по PDF не видно, **почему** материал
 * стоит на странице и на каком основании он отнесён к проверяемому лицу.
 * Дефекты отчётов 85 и 86 владелец ловил именно так — по скриншотам страниц.
 *
 * Лист отвечает на три вопроса о каждом напечатанном пункте: что о нём
 * напечатано, на каких он страницах и что о нём решила машина. Действий здесь
 * нет вовсе: решения аналитика — следующий шаг, и лист их только предъявит.
 *
 * **Единица листа — материал, а не наблюдение.** Ключ наблюдения включает
 * запрос, поэтому одна страница, найденная четырьмя запросами, лежит в данных
 * четырьмя ссылками, а клиент видит одну строку. На бандле отчёта 86
 * напечатанных ссылок 399, а строк 160: лист по ссылкам дал бы четыре пункта на
 * одну строку, и решение по одному из них не закрыло бы остальные три. Сводит
 * лист тем же `serpMaterialKey`, каким сводит строки таблица выдачи и рамки
 * снимок, — третьего ответа на «тот же ли это материал» в продукте нет.
 *
 * **Догадок о том, виден ли материал в отчёте, здесь не делается.** У каждого
 * вида пункта точный признак:
 *
 * 1. строка таблицы выдачи — `evidenceRefs` слайдов таблиц: построитель кладёт
 *    туда ровно ссылки напечатанных строк;
 * 2. снимок, сетка изображений, панель — `visibleItems` визуального актива:
 *    это буквально то, что нарисовано, вместе с признаком рамки;
 * 3. тема — `findingIds` слайда;
 * 4. комплаенс — записи инвентаря и слоты снимков отчётов баз.
 *
 * Материал, попавший в отчёт только цитатой внутри блока темы, своей строки не
 * получает: искать цитату в тексте слайда — догадка, и лист обещал бы страницу,
 * на которой материала не найти. Такой материал назван страницами своей темы.
 *
 * Модуль чистый и офлайновый: ни файлов, ни базы, ни сети. Метки времени в
 * листе нет намеренно — два построения одного входа обязаны дать один и тот же
 * файл, а «когда собран» знает сама джоба.
 */

import { serpMaterialKey } from "../serp-observation/material-key";
import {
  REVIEW_DECISION_KINDS,
  activeReviewDecisions,
  reviewDecisionSlot,
  reviewDecisionsDigest,
} from "./review-decision-store";

export const REVIEW_SHEET_ARTIFACT = "review-sheet.json";
export const REVIEW_SHEET_VERSION = "review-sheet-v1" as const;

export type ReviewItemKind = "evidence" | "finding" | "compliance";

/** Где пункт напечатан и чем он там стоит. */
export type ReviewPlace = {
  page: number;
  slideKey: string;
  slideTitle: string;
  as: string;
};

export type ReviewSheetItem = {
  kind: ReviewItemKind;
  key: string;
  /** Машина решить не смогла — ждёт аналитика. */
  open: boolean;
  title: string;
  url?: string;
  domain?: string;
  /** Состояние пункта словами: их читает человек, а не код. */
  state: string;
  /** Почему машина решила так: код из `subject-resolution` и его расшифровка. */
  reason?: { code: string; label: string };
  /** Тема, которой объяснена красная рамка на снимке или сетке. */
  framedAs?: string;
  pages: number[];
  places: ReviewPlace[];
  /** Наблюдения, из которых сложен пункт: у материала их бывает много. */
  refs?: string[];
  /**
   * Ключи материалов темы.
   *
   * «Подтвердить тему» — это подтвердить принадлежность её улик, и ничего
   * сверх того: иначе отчёт объявил бы тему подтверждённой при
   * неподтверждённых материалах. Раскладывает решение вкладка, а ключи даёт
   * лист — второго ответа на «из чего сложена тема» нет.
   */
  materialKeys?: string[];
  /**
   * Действующие решения аналитика по вопросу: «чей материал» и «негативен ли».
   *
   * В отчёт они не попадают ни именем, ни датой (решение владельца 6) — здесь
   * они затем, чтобы вкладка показала, что уже решено, и не предлагала решать
   * заново.
   */
  decisions?: Partial<Record<string, ReviewItemDecision>>;
};

/** Решение аналитика в том виде, в каком его показывает вкладка. */
export type ReviewItemDecision = {
  status: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
};

export type ReviewSheet = {
  version: typeof REVIEW_SHEET_VERSION;
  caseId: string;
  /**
   * Отпечаток решений, вошедших в **эту** сборку.
   *
   * По нему вкладка отличает решение, уже стоящее в документе, от принятого
   * после сборки: иначе аналитик видит своё решение в списке и не понимает,
   * почему его нет в PDF.
   */
  decisionsDigest: string;
  summary: {
    evidence: { total: number; open: number; framed: number };
    finding: { total: number; open: number };
    compliance: { total: number; open: number };
  };
  items: ReviewSheetItem[];
};

// --------------------------------------------------------------------------
// Вход: ровно те артефакты, которые джоба уже пишет
// --------------------------------------------------------------------------

export type ReviewSheetSlide = {
  slideKey?: string | null;
  baseSlotId?: string | null;
  templateId?: string | null;
  pageNumber?: number | null;
  title?: string | null;
  evidenceRefs?: readonly string[] | null;
  findingIds?: readonly string[] | null;
  /** Визуальные активы, нарисованные именно на этой странице. */
  visualAssetRefs?: readonly string[] | null;
};

export type ReviewSheetObservation = {
  url?: string | null;
  title?: string | null;
  domain?: string | null;
  evidenceRefs?: readonly string[] | null;
};

export type ReviewSheetVisualItem = {
  ref?: string | null;
  url?: string | null;
  title?: string | null;
  domain?: string | null;
  adverse?: boolean | null;
  themeTitle?: string | null;
};

export type ReviewSheetVisualAsset = {
  /** Имя актива: по нему слайд и говорит, что нарисовал именно его. */
  assetRef?: string | null;
  kind?: string | null;
  visibleItems?: readonly ReviewSheetVisualItem[] | null;
};

export type ReviewSheetResolution = {
  evidenceRef: string;
  decision: string;
  reasonCode?: string | null;
};

export type ReviewSheetFinding = {
  findingId: string;
  theme: string;
  subjectMatch: string;
  riskLevel?: string | null;
  evidenceRefs?: readonly string[] | null;
};

export type ReviewSheetComplianceItem = {
  inventoryId?: string | null;
  provider?: string | null;
  title?: string | null;
  /** Статус проверки записи аналитиком (`reviewStatus`). */
  classification?: string | null;
};

export type ReviewSheetInput = {
  caseId: string;
  slides: readonly ReviewSheetSlide[];
  observations: readonly ReviewSheetObservation[];
  subjectResolution: readonly ReviewSheetResolution[];
  visualAssets?: Readonly<Record<string, readonly ReviewSheetVisualAsset[]>> | null;
  findings?: readonly ReviewSheetFinding[] | null;
  ambiguousFindings?: readonly ReviewSheetFinding[] | null;
  compliance?: { items?: readonly ReviewSheetComplianceItem[] | null } | null;
  /** Решения аналитика — те же строки, что применяет пересборка. */
  decisions?: readonly ReviewSheetDecision[] | null;
};

export type ReviewSheetDecision = {
  itemKind: string;
  itemKey: string;
  decisionKind: string;
  status: string;
  note?: string | null;
  isActive?: boolean;
  decidedBy?: string | null;
  decidedAt: string | Date;
};

// --------------------------------------------------------------------------
// Словари: машинный код → слова
// --------------------------------------------------------------------------

/** Решение о принадлежности — теми же словами, какими его понимает человек. */
const DECISION_LABELS: Readonly<Record<string, string>> = {
  SUBJECT_MATCH: "отнесён к проверяемому лицу",
  LIKELY_SUBJECT: "вероятно о проверяемом лице",
  AMBIGUOUS: "принадлежность не подтверждена",
  INSUFFICIENT_IDENTIFIERS: "признаков для решения нет",
  OTHER_SUBJECT: "о другом лице",
};

/** Пункт без решения: молчание — не подтверждение и не отказ. */
const NO_DECISION_LABEL = "решения о принадлежности нет";

/**
 * Виды признаков субъекта — для кодов `full_name_with_anchor:<вид>`.
 *
 * Код несёт вид после двоеточия, и без расшифровки лист печатал бы клиенту
 * админки «full_name_with_anchor:birth_date».
 */
const ANCHOR_KIND_LABELS: Readonly<Record<string, string>> = {
  employer: "место работы",
  position: "должность",
  birthPlace: "место рождения",
  birth_date: "дата рождения",
  birthDate: "дата рождения",
  education: "образование",
  fact: "признак, названный оператором",
  inn: "ИНН",
  domain: "площадка субъекта",
};

/**
 * Коды причин классификатора принадлежности — словами.
 *
 * Список закрытым не считается: незнакомый код печатается как есть. Так лист
 * не врёт о новом коде и сам показывает, что расшифровку пора дописать.
 */
const REASON_LABELS: Readonly<Record<string, string>> = {
  no_subject_tokens: "в тексте нет ни имени, ни фамилии субъекта",
  conflicting_identity_no_subject_tokens: "в тексте другое лицо, имени субъекта нет",
  partial_name_without_surname: "есть имя, но нет фамилии",
  foreign_birth_date: "в тексте другая дата рождения",
  foreign_inn: "в тексте другой ИНН",
  patronymic_conflict: "другое отчество",
  given_name_conflict: "другое имя",
  namesake_conflict: "признаки указывают на однофамильца",
  mixed_identity_signals: "в одном тексте признаки субъекта и чужие признаки",
  full_name_no_anchor: "полное имя есть, признака субъекта рядом нет",
  full_name_with_weak_anchor: "полное имя и слабый признак субъекта",
  full_name_with_context: "полное имя и слова о занятии субъекта",
  full_name_match: "полное имя субъекта",
  strong_identifier_match: "совпал сильный признак — ИНН или дата рождения",
  registry_inn_unverified: "карточка реестра, ИНН не сверен",
  surname_with_anchor: "фамилия и признак субъекта рядом",
  surname_query_no_anchor:
    "фамилия в материале, найденном по запросу о субъекте; признака рядом нет",
  surname_with_subject_query: "фамилия, найдено по запросу с полным именем",
  surname_with_context: "фамилия и слова о занятии субъекта",
  surname_with_confirmed_domain: "фамилия на площадке, где субъект уже подтверждён",
  surname_only: "одна фамилия",
  paa_full_name: "полное имя в вопросе поисковика",
  suggestion_full_name: "полное имя в подсказке поисковика",
  langlink_inherited: "языковая версия уже разобранной статьи",
  url_inherited: "тот же адрес, что у разобранного материала",
  compliance_match_confirmed: "совпадение подтверждено аналитиком",
  compliance_review_pending: "совпадение ждёт проверки аналитиком",
};

/**
 * Ключ пункта-темы — тема, а не находка.
 *
 * Идентификатор находки хешируется от состава её улик и меняется вместе с ним:
 * решение, привязанное к нему, отвалилось бы на первой же пересборке — ровно
 * тогда, когда должно сработать. Идентификатор устроен как
 * `finding-<тема>-<корзина>-<хеш>`, и тема из него читается; чужую форму
 * разбирать не пытаемся — тогда ключом остаётся сам идентификатор.
 */
export function reviewThemeKeyOf(findingId: string): string {
  const parts = String(findingId ?? "").split("-");
  if (parts.length >= 4 && parts[0] === "finding" && parts[1]) return `theme:${parts[1]}`;
  return findingId;
}

export function reasonLabel(code: string): string {
  const known = REASON_LABELS[code];
  if (known) return known;
  const [head, kind] = code.split(":", 2);
  if (head === "full_name_with_anchor" && kind) {
    return `полное имя и признак субъекта — ${ANCHOR_KIND_LABELS[kind] ?? kind}`;
  }
  return code;
}

/**
 * Шаблоны страниц, у которых `evidenceRefs` — это напечатанные строки.
 *
 * У остальных страниц то же поле означает «основания страницы»: сводка региона
 * несёт 620 ссылок и не печатает ни одной из них. Список именно поимённый:
 * общее правило «брать все ссылки слайда» дало бы каждому материалу выдачи
 * страницу сводки, которой он там не занимает.
 */
const ROW_TEMPLATES: ReadonlySet<string> = new Set(["serp-table", "serp-extra-queries"]);

/** Слоты снимков отчётов баз: у каждого свой пункт «снимок загружен или нет». */
const COMPLIANCE_VISUAL_SLOTS: ReadonlyArray<{ slot: string; label: string }> = [
  { slot: "p34_dow_jones", label: "Снимок отчёта Dow Jones" },
  { slot: "p35_lexis_visual", label: "Снимок отчёта LexisNexis" },
  { slot: "p36_lexis_visual_2", label: "Снимок отчёта LexisNexis (2)" },
];

/** Страница сводки баз: на ней печатаются записи комплаенса. */
const COMPLIANCE_SUMMARY_SLOT = "p33_compliance_toc";

/** Статусы записи комплаенса, при которых решение аналитика ещё не принято. */
const COMPLIANCE_OPEN_STATUSES: ReadonlySet<string> = new Set([
  "",
  "PENDING",
  "NEEDS_REVIEW",
  "REVIEW_REQUIRED",
]);

const COMPLIANCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "совпадение ждёт решения аналитика",
  NEEDS_REVIEW: "совпадение ждёт решения аналитика",
  REVIEW_REQUIRED: "совпадение ждёт решения аналитика",
  MATCH_CONFIRMED: "совпадение подтверждено аналитиком",
  CONFIRMED: "совпадение подтверждено аналитиком",
  FALSE_POSITIVE: "совпадение снято как ложное",
  DISMISSED: "совпадение снято как ложное",
};

/**
 * Сила решения о принадлежности.
 *
 * У наблюдений одного адреса решения расходятся (на бандле отчёта 86 таких
 * материалов пять): страница судьи опознана и датой рождения, и «смешанными
 * признаками». Лист называет **сильнейшее** заявление о принадлежности — то,
 * ради которого аналитик и открывает пункт: «отнесён к лицу» требует проверки
 * настойчивее, чем «о другом лице».
 */
const DECISION_STRENGTH: ReadonlyArray<string> = [
  "SUBJECT_MATCH",
  "LIKELY_SUBJECT",
  "AMBIGUOUS",
  "INSUFFICIENT_IDENTIFIERS",
  "OTHER_SUBJECT",
];

/** Решения, при которых пункт ждёт аналитика. */
const OPEN_DECISIONS: ReadonlySet<string> = new Set([
  "LIKELY_SUBJECT",
  "AMBIGUOUS",
  "INSUFFICIENT_IDENTIFIERS",
]);

/** Как назван вид визуального актива на листе. */
const ASSET_KIND_LABELS: Readonly<Record<string, string>> = {
  serp_screenshot: "строка на снимке выдачи",
  image_grid: "плитка на сетке изображений",
  surface_panel: "строка на панели подсказок",
  knowledge_panel: "строка на панели знаний",
};

// --------------------------------------------------------------------------
// Построитель
// --------------------------------------------------------------------------

type MaterialFields = { url?: string; title?: string; domain?: string };

type Draft = {
  key: string;
  fields: MaterialFields;
  refs: Set<string>;
  places: ReviewPlace[];
  framedAs?: string;
};

function nonEmpty(value: string | null | undefined): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/** Страницы слота: сам слайд и все его продолжения. */
function pagesBySlot(slides: readonly ReviewSheetSlide[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const slide of slides) {
    const page = Number(slide.pageNumber ?? 0);
    if (!page) continue;
    for (const id of [slide.slideKey, slide.baseSlotId]) {
      const slot = nonEmpty(id);
      if (!slot) continue;
      const list = out.get(slot) ?? [];
      if (!list.includes(page)) list.push(page);
      out.set(slot, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/** Слайды слота в порядке страниц — им подписываются места пункта. */
function slidesBySlot(slides: readonly ReviewSheetSlide[]): Map<string, ReviewSheetSlide[]> {
  const out = new Map<string, ReviewSheetSlide[]>();
  for (const slide of slides) {
    for (const id of [slide.slideKey, slide.baseSlotId]) {
      const slot = nonEmpty(id);
      if (!slot) continue;
      const list = out.get(slot) ?? [];
      if (!list.includes(slide)) list.push(slide);
      out.set(slot, list);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => Number(a.pageNumber ?? 0) - Number(b.pageNumber ?? 0));
  }
  return out;
}

function placeOf(slide: ReviewSheetSlide, as: string): ReviewPlace {
  return {
    page: Number(slide.pageNumber ?? 0),
    slideKey: String(slide.slideKey ?? slide.baseSlotId ?? ""),
    slideTitle: String(slide.title ?? ""),
    as,
  };
}

export function buildReviewSheet(input: ReviewSheetInput): ReviewSheet {
  /*
   * Решения аналитика: действующие — по одному на пару «пункт + вопрос».
   * Считает их то же хранилище, что применяет пересборка, — второго ответа на
   * «что решено» в продукте нет.
   */
  const decisionRows = (input.decisions ?? []).map((d) => ({
    id: `${d.itemKind}|${d.itemKey}|${d.decisionKind}|${String(d.decidedAt)}`,
    caseId: input.caseId,
    itemKind: d.itemKind,
    itemKey: d.itemKey,
    decisionKind: d.decisionKind,
    status: d.status,
    note: d.note ?? null,
    isActive: d.isActive !== false,
    decidedBy: d.decidedBy ?? null,
    decidedAt: d.decidedAt,
  }));
  const activeBySlot = activeReviewDecisions(decisionRows);
  const decisionsOf = (key: string): Partial<Record<string, ReviewItemDecision>> | undefined => {
    const out: Record<string, ReviewItemDecision> = {};
    for (const kind of REVIEW_DECISION_KINDS) {
      const row = activeBySlot.get(reviewDecisionSlot(key, kind));
      if (!row) continue;
      out[kind] = {
        status: row.status,
        ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
        decidedAt: row.decidedAt instanceof Date ? row.decidedAt.toISOString() : String(row.decidedAt),
        ...(row.note ? { note: row.note } : {}),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const slides = input.slides ?? [];
  const bySlotSlides = slidesBySlot(slides);
  const slotPages = pagesBySlot(slides);

  // Поля материала по ссылке: наблюдение — первый ответ, видимая строка
  // визуального актива — запасной. У панели знаний наблюдения нет вовсе, и без
  // запасного ответа её строка осталась бы без заголовка.
  const fieldsByRef = new Map<string, MaterialFields>();
  for (const obs of input.observations ?? []) {
    const fields: MaterialFields = {
      url: nonEmpty(obs.url),
      title: nonEmpty(obs.title),
      domain: nonEmpty(obs.domain),
    };
    for (const ref of obs.evidenceRefs ?? []) {
      if (!fieldsByRef.has(ref)) fieldsByRef.set(ref, fields);
    }
  }

  const resolutionByRef = new Map<string, ReviewSheetResolution>();
  for (const row of input.subjectResolution ?? []) {
    if (!resolutionByRef.has(row.evidenceRef)) resolutionByRef.set(row.evidenceRef, row);
  }

  /*
   * Поля материала по его ключу — по всем наблюдениям набора, а не только по
   * напечатанным. Снятый материал в деке не встречается, а назвать его адресом
   * и заголовком лист обязан.
   */
  const fieldsByKey = new Map<string, MaterialFields>();
  for (const [ref, fields] of fieldsByRef) {
    const key = serpMaterialKey(fields, ref);
    if (!fieldsByKey.has(key)) fieldsByKey.set(key, fields);
  }

  const drafts = new Map<string, Draft>();
  const touch = (ref: string, fields: MaterialFields, place: ReviewPlace): Draft => {
    const known = fieldsByRef.get(ref) ?? fields;
    if (!fieldsByRef.has(ref)) fieldsByRef.set(ref, known);
    const key = serpMaterialKey(known, ref);
    const draft = drafts.get(key) ?? { key, fields: known, refs: new Set<string>(), places: [] };
    draft.refs.add(ref);
    if (!draft.places.some((p) => p.page === place.page && p.as === place.as)) {
      draft.places.push(place);
    }
    if (!draft.fields.title && known.title) draft.fields = { ...draft.fields, ...known };
    drafts.set(key, draft);
    return draft;
  };

  // 1. Строки таблиц выдачи.
  for (const slide of slides) {
    if (!ROW_TEMPLATES.has(String(slide.templateId ?? ""))) continue;
    const place = placeOf(slide, "строка таблицы выдачи");
    if (!place.page) continue;
    for (const ref of slide.evidenceRefs ?? []) {
      touch(ref, fieldsByRef.get(ref) ?? {}, place);
    }
  }

  // 2. Всё, что нарисовано: снимок выдачи, сетка изображений, панели.
  for (const [slot, assets] of Object.entries(input.visualAssets ?? {})) {
    const slotSlides = bySlotSlides.get(slot) ?? [];
    if (slotSlides.length === 0) continue;
    for (const asset of assets ?? []) {
      const as = ASSET_KIND_LABELS[String(asset.kind ?? "")] ?? "строка на странице снимка";
      /*
       * Страница у строки та, на которой актив нарисован, — а не весь слот.
       *
       * За снимком выдачи идут страницы «почему выделено», и они называют
       * только обведённые строки: обещать их каждой видимой строке значило бы
       * назвать страницу, на которой строки не найти. Слайд говорит о себе сам
       * (`visualAssetRefs`); молчит он только у старых дек, и тогда берётся
       * слот целиком — как раньше.
       */
      const assetRef = nonEmpty(asset.assetRef);
      const drawnOn = assetRef
        ? slotSlides.filter((slide) => (slide.visualAssetRefs ?? []).includes(assetRef))
        : [];
      const pagesOfAsset = drawnOn.length > 0 ? drawnOn : slotSlides;
      for (const visible of asset.visibleItems ?? []) {
        const ref = nonEmpty(visible.ref);
        if (!ref) continue;
        const fields: MaterialFields = {
          url: nonEmpty(visible.url),
          title: nonEmpty(visible.title),
          domain: nonEmpty(visible.domain),
        };
        let draft: Draft | null = null;
        for (const slide of pagesOfAsset) {
          const place = placeOf(slide, as);
          if (!place.page) continue;
          draft = touch(ref, fields, place);
        }
        if (draft && visible.adverse) {
          draft.framedAs = draft.framedAs ?? nonEmpty(visible.themeTitle) ?? "";
        }
      }
    }
  }

  const items: ReviewSheetItem[] = [];
  let framedCount = 0;
  for (const draft of drafts.values()) {
    const refs = [...draft.refs].sort();
    let decision = "";
    let reason: { code: string; label: string } | undefined;
    for (const ref of refs) {
      const row = resolutionByRef.get(ref);
      if (!row) continue;
      const rank = DECISION_STRENGTH.indexOf(row.decision);
      const current = decision ? DECISION_STRENGTH.indexOf(decision) : Number.MAX_SAFE_INTEGER;
      if (rank >= 0 && rank < current) {
        decision = row.decision;
        const code = nonEmpty(row.reasonCode);
        reason = code ? { code, label: reasonLabel(code) } : undefined;
      }
    }
    const places = [...draft.places].sort((a, b) => a.page - b.page);
    if (draft.framedAs !== undefined) framedCount += 1;
    const decisions = decisionsOf(draft.key);
    items.push({
      kind: "evidence",
      key: draft.key,
      // Отвеченная принадлежность закрывает пункт: решать по нему больше
      // нечего. Решение о негативе принадлежность не закрывает — это другой
      // вопрос, и открытым пункт остаётся по своему.
      open: (!decision || OPEN_DECISIONS.has(decision)) && !decisions?.belonging,
      title: draft.fields.title ?? draft.fields.url ?? draft.key,
      ...(draft.fields.url ? { url: draft.fields.url } : {}),
      ...(draft.fields.domain ? { domain: draft.fields.domain } : {}),
      state: decision ? (DECISION_LABELS[decision] ?? decision) : NO_DECISION_LABEL,
      ...(reason ? { reason } : {}),
      ...(draft.framedAs ? { framedAs: draft.framedAs } : {}),
      pages: [...new Set(places.map((p) => p.page))],
      places,
      refs,
      ...(decisions ? { decisions } : {}),
    });
  }

  /*
   * Снятые материалы — из решений, а не из напечатанного.
   *
   * Лист строится по деке, а снятого в деке нет по построению: без этого
   * прохода решение исчезло бы вместе со своей кнопкой, и аналитик не смог бы
   * ни увидеть его, ни вернуть материал. Решение, которое нельзя отменить, —
   * ловушка.
   */
  for (const [slot, row] of activeBySlot) {
    if (row.decisionKind !== "presence" || row.status !== "EXCLUDED") continue;
    if (row.itemKind !== "evidence") continue;
    void slot;
    if (items.some((i) => i.key === row.itemKey)) continue;
    const fields = fieldsByKey.get(row.itemKey) ?? {};
    items.push({
      kind: "evidence",
      key: row.itemKey,
      // Решение принято — решать нечего.
      open: false,
      title: fields.title ?? fields.url ?? row.itemKey,
      ...(fields.url ? { url: fields.url } : {}),
      ...(fields.domain ? { domain: fields.domain } : {}),
      state: "снят из отчёта решением проверки",
      // Страниц у него нет: он нигде не напечатан, и обещать страницу нельзя.
      pages: [],
      places: [],
      ...(decisionsOf(row.itemKey) ? { decisions: decisionsOf(row.itemKey) } : {}),
    });
  }

  // 3. Темы: страницы у них точные — их называет сам слайд.
  const findingPages = new Map<string, ReviewSheetSlide[]>();
  for (const slide of slides) {
    for (const id of slide.findingIds ?? []) {
      const list = findingPages.get(id) ?? [];
      list.push(slide);
      findingPages.set(id, list);
    }
  }
  /*
   * Одна тема — один пункт, сколькими бы корзинами она ни жила.
   *
   * Подтверждённая тема стоит в матрице, «принадлежность не подтверждена» — в
   * приложении, и это одна и та же тема. Аналитик думает темой, а не корзиной:
   * два пункта на неё заставляли бы решать дважды и по-разному.
   */
  const themeDrafts = new Map<
    string,
    {
      title: string;
      states: string[];
      places: ReviewPlace[];
      open: boolean;
      materialKeys: Set<string>;
    }
  >();
  for (const finding of [...(input.findings ?? []), ...(input.ambiguousFindings ?? [])]) {
    const onSlides = findingPages.get(finding.findingId);
    // Тема, которую не печатает ни одна страница, на листе не стоит: решать по
    // ней нечего, а пункт обещал бы клиенту то, чего он не увидит.
    if (!onSlides || onSlides.length === 0) continue;
    const key = reviewThemeKeyOf(finding.findingId);
    const draft = themeDrafts.get(key) ?? {
      title: finding.theme,
      states: [],
      places: [],
      open: false,
      materialKeys: new Set<string>(),
    };
    const state = findingState(finding.subjectMatch);
    if (!draft.states.includes(state)) draft.states.push(state);
    if (finding.subjectMatch === "LIKELY_SUBJECT") draft.open = true;
    for (const slide of onSlides) {
      const place = placeOf(slide, "блок темы");
      if (place.page > 0 && !draft.places.some((p) => p.page === place.page)) {
        draft.places.push(place);
      }
    }
    // Ключи материалов темы: по ним «подтвердить тему» раскладывается на
    // решения о принадлежности её улик — иначе тема объявлялась бы
    // подтверждённой при неподтверждённых уликах.
    for (const ref of finding.evidenceRefs ?? []) {
      const fields = fieldsByRef.get(ref);
      if (fields) draft.materialKeys.add(serpMaterialKey(fields, ref));
    }
    themeDrafts.set(key, draft);
  }
  const findingItems: ReviewSheetItem[] = [];
  for (const [key, draft] of themeDrafts) {
    const places = [...draft.places].sort((a, b) => a.page - b.page);
    const decisions = decisionsOf(key);
    findingItems.push({
      kind: "finding",
      key,
      open: draft.open && !decisions?.presence,
      title: draft.title,
      state: draft.states.join("; "),
      pages: [...new Set(places.map((p) => p.page))],
      places,
      ...(draft.materialKeys.size > 0 ? { materialKeys: [...draft.materialKeys].sort() } : {}),
      ...(decisions ? { decisions } : {}),
    });
  }
  /*
   * Снятая тема — из решений, а не из напечатанного: в деке её нет по
   * построению, и без этого прохода решение исчезло бы вместе со своей кнопкой.
   */
  for (const row of activeBySlot.values()) {
    if (row.itemKind !== "finding" || row.decisionKind !== "presence") continue;
    if (row.status !== "EXCLUDED") continue;
    if (findingItems.some((i) => i.key === row.itemKey)) continue;
    findingItems.push({
      kind: "finding",
      key: row.itemKey,
      open: false,
      title: row.itemKey.replace(/^theme:/u, ""),
      state: "снята из отчёта решением проверки",
      pages: [],
      places: [],
      ...(decisionsOf(row.itemKey) ? { decisions: decisionsOf(row.itemKey) } : {}),
    });
  }

  // 4. Комплаенс: записи и слоты снимков отчётов баз.
  const complianceItems: ReviewSheetItem[] = [];
  const summarySlides = bySlotSlides.get(COMPLIANCE_SUMMARY_SLOT) ?? [];
  const summaryPlaces = summarySlides
    .map((slide) => placeOf(slide, "сводка баз данных"))
    .filter((p) => p.page > 0);
  for (const record of input.compliance?.items ?? []) {
    const key = nonEmpty(record.inventoryId);
    if (!key) continue;
    const status = String(record.classification ?? "").toUpperCase();
    complianceItems.push({
      kind: "compliance",
      key,
      open: COMPLIANCE_OPEN_STATUSES.has(status),
      title: nonEmpty(record.title) ?? key,
      state: COMPLIANCE_STATUS_LABELS[status] ?? (status || "статус записи не назван"),
      pages: summaryPlaces.map((p) => p.page),
      places: summaryPlaces,
    });
  }
  for (const { slot, label } of COMPLIANCE_VISUAL_SLOTS) {
    const slotSlides = bySlotSlides.get(slot) ?? [];
    if (slotSlides.length === 0) continue;
    const hasAsset = (input.visualAssets?.[slot] ?? []).length > 0;
    const places = slotSlides
      .map((slide) => placeOf(slide, "страница снимка"))
      .filter((p) => p.page > 0);
    complianceItems.push({
      kind: "compliance",
      key: slot,
      open: !hasAsset,
      title: label,
      state: hasAsset ? "снимок стоит в отчёте" : "снимок не загружен",
      pages: slotPages.get(slot) ?? places.map((p) => p.page),
      places,
    });
  }

  const byPageThenKey = (a: ReviewSheetItem, b: ReviewSheetItem): number => {
    const pa = a.pages[0] ?? Number.MAX_SAFE_INTEGER;
    const pb = b.pages[0] ?? Number.MAX_SAFE_INTEGER;
    return pa === pb ? a.key.localeCompare(b.key) : pa - pb;
  };
  items.sort(byPageThenKey);
  findingItems.sort(byPageThenKey);
  complianceItems.sort(byPageThenKey);

  return {
    version: REVIEW_SHEET_VERSION,
    caseId: input.caseId,
    decisionsDigest: reviewDecisionsDigest(decisionRows),
    summary: {
      evidence: {
        total: items.length,
        open: items.filter((i) => i.open).length,
        framed: framedCount,
      },
      finding: { total: findingItems.length, open: findingItems.filter((i) => i.open).length },
      compliance: {
        total: complianceItems.length,
        open: complianceItems.filter((i) => i.open).length,
      },
    },
    items: [...items, ...findingItems, ...complianceItems],
  };
}

/**
 * Сколько пунктов листа ждут аналитика — один счёт на весь продукт.
 *
 * Число попадает в запись выпуска, то есть в юридически значимый документ:
 * второй обход по пунктам разошёлся бы с этой сводкой ровно тогда, когда цена
 * расхождения выше всего. Листа нет — числа нет: ноль и «не считали» разные
 * утверждения.
 */
export function openItemsOf(sheet: ReviewSheet | null | undefined): number | null {
  if (!sheet?.summary) return null;
  const s = sheet.summary;
  return s.evidence.open + s.finding.open + s.compliance.open;
}

/**
 * Наложить действующие решения на уже собранный лист.
 *
 * Отпечаток в файле отвечает на «что вошло в сборку», а вкладке нужен ответ на
 * «что решено сейчас»: пересобирать лист ради этого не надо — меняются только
 * признак открытости и сами решения. Пересчёт живёт здесь, а не в маршруте,
 * чтобы правило «отвеченная принадлежность закрывает пункт» осталось одним.
 */
export function applyDecisionsToSheet(
  sheet: ReviewSheet,
  decisions: readonly ReviewSheetDecision[]
): ReviewSheet {
  const rows = decisions.map((d) => ({
    id: `${d.itemKind}|${d.itemKey}|${d.decisionKind}|${String(d.decidedAt)}`,
    caseId: sheet.caseId,
    itemKind: d.itemKind,
    itemKey: d.itemKey,
    decisionKind: d.decisionKind,
    status: d.status,
    note: d.note ?? null,
    isActive: d.isActive !== false,
    decidedBy: d.decidedBy ?? null,
    decidedAt: d.decidedAt,
  }));
  const active = activeReviewDecisions(rows);
  const items = sheet.items.map((item) => {
    const out: Record<string, ReviewItemDecision> = {};
    for (const kind of REVIEW_DECISION_KINDS) {
      const row = active.get(reviewDecisionSlot(item.key, kind));
      if (!row) continue;
      out[kind] = {
        status: row.status,
        ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
        decidedAt:
          row.decidedAt instanceof Date ? row.decidedAt.toISOString() : String(row.decidedAt),
        ...(row.note ? { note: row.note } : {}),
      };
    }
    const has = Object.keys(out).length > 0;
    // Машинная открытость пункта записана в файле; решение аналитика её
    // закрывает, но снять решение — значит вернуть её как была, поэтому
    // исходный признак берётся из листа, а не пересчитывается.
    const machineOpen = item.open || Boolean(item.decisions?.belonging);
    return {
      ...item,
      open: item.kind === "evidence" ? machineOpen && !out.belonging : item.open,
      ...(has ? { decisions: out } : {}),
      ...(has ? {} : { decisions: undefined }),
    };
  });
  const count = (kind: ReviewItemKind) => {
    const rowsOfKind = items.filter((i) => i.kind === kind);
    return { total: rowsOfKind.length, open: rowsOfKind.filter((i) => i.open).length };
  };
  return {
    ...sheet,
    items,
    summary: {
      evidence: { ...count("evidence"), framed: sheet.summary.evidence.framed },
      finding: count("finding"),
      compliance: count("compliance"),
    },
  };
}

function findingState(subjectMatch: string): string {
  switch (subjectMatch) {
    case "SUBJECT_MATCH":
      return "тема подтверждена";
    case "LIKELY_SUBJECT":
      return "требует подтверждения";
    case "AMBIGUOUS":
      return "в приложении: принадлежность не подтверждена";
    case "OTHER_SUBJECT":
      return "в приложении: о другом лице";
    default:
      return subjectMatch;
  }
}
