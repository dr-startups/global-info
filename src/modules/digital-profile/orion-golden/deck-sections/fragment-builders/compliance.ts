/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { ComplianceRiskType } from "../../../compliance-providers/types";
import type { SectionType, SlideContentContract } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import {
  isNarrativeOrPlaceholderMatchName,
  pickComplianceClientMatchTitle,
} from "../../../services/compliance-inventory-adapter";
import { formatRuDate } from "../../../services/report-material-freshness";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
// Название базы для читателя живёт в домене провайдеров; здесь только
// переиспользуется, чтобы не держать вторую карту названий.
export { complianceProviderLabel } from "../../../compliance-providers/provider-labels";
import { complianceProviderLabel } from "../../../compliance-providers/provider-labels";
import {
  VISUAL_ASSET_UNAVAILABLE,
  chunk,
  clampClientText,
  countryNamesRu,
  enumerateRu,
  makeSlotSlide,
} from "./shared";
import { buildContinuationSlide, continuationTitle } from "../continuation-slide";
import { pluralRu } from "../../../report/i18n/plural-ru";


/**
 * Клиентские названия типов риска — исчерпывающей картой.
 *
 * `Record<ComplianceRiskType, string>` здесь не украшение: новый тип без метки
 * не пройдёт компилятор, а без этого он доезжает до клиента как «Сигнал
 * комплаенс-базы» (общая ветка `humanizeComplianceCategory` для
 * SCREAMING_SNAKE) — то есть страница перестаёт называть категорию, ничего об
 * этом не сообщая.
 */
const RISK_TYPE_CATEGORY_LABELS: Record<ComplianceRiskType, string> = {
  PEP: "PEP (политически значимое лицо)",
  POLITICAL_EXPOSURE: "Политическая аффилированность",
  ADVERSE_MEDIA: "Негативные публикации",
  SANCTIONS: "Санкционные списки",
  SANCTION_LINKED: "Связь с санкционным лицом",
  WATCHLIST: "Сторожевые списки",
  LEGAL: "Правовые и регуляторные риски",
  LAW_ENFORCEMENT: "Правоохранительные сигналы",
  INSOLVENCY: "Несостоятельность",
  OTHER: "Требует ручной классификации",
};

/** Internal persist tokens — never show raw to the client. */
const INTERNAL_CATEGORY_LABELS: Record<string, string> = {
  LEXISNEXIS_SIGNAL: "Сигнал LexisNexis",
  LEXISNEXIS_IMPORTED_REPORT: "Импортированный отчёт LexisNexis",
};

const COMPLIANCE_CATEGORY_LABELS: Record<string, string> = {
  ...RISK_TYPE_CATEGORY_LABELS,
  ...INTERNAL_CATEGORY_LABELS,
};

/**
 * Заголовки сводной таблицы комплаенса.
 *
 * **Первая колонка — признак ветки ширин в рендерере**
 * (`renderer/orion_golden_render/visual.py`, `_add_search_table`): по словам
 * «База данных» он узнаёт эту таблицу и отдаёт колонкам доли
 * 0.14 / 0.26 / 0.26 / 0.34. Переименование колонки без правки рендерера не
 * ломает ни типы, ни ворота, ни растровую проверку — таблица молча уходит в
 * общую четырёхколоночную ветку, где статусу достаётся 18 % ширины и самая
 * длинная законная ячейка просит три строки вместо двух. Связь закреплена
 * тестом `renderer-finds-the-compliance-table-by-its-first-column`.
 */
export const COMPLIANCE_SUMMARY_HEADERS = [
  "База данных",
  "Тип совпадения",
  "Совпадение по имени",
  "Статус проверки",
] as const;

/**
 * Статус проверки словами. Автоматического подтверждения не бывает, поэтому
 * `MATCH_CONFIRMED` — это «подтверждено аналитиком», а не просто
 * «подтверждено»: разница видна и читателю, и правилу бейджа рендерера.
 */
const COMPLIANCE_STATUS_LABELS: Record<string, string> = {
  PENDING: "Требует ручной проверки",
  NEEDS_REVIEW: "Требует ручной проверки",
  CONFIRMED: "Подтверждено аналитиком",
  MATCH_CONFIRMED: "Подтверждено аналитиком",
  // До деки не доходят (отсеиваются фильтром инвентаря) — ярлыки оставлены
  // защитно, чтобы код статуса не протёк в отчёт дословно.
  DISMISSED: "Отклонено",
  FALSE_POSITIVE: "Ложное срабатывание",
};

/**
 * Статуса в данных нет — так и печатаем.
 *
 * Соблазн упростить это до «Требует ручной проверки» есть всегда, но это имя
 * конкретного статуса (`PENDING`), и приписывать его записи, у которой статус
 * не сохранён, — значит выдумывать факт о проверке.
 */
const STATUS_NOT_RECORDED = "Не подтверждено (статус в артефактах прогона не зафиксирован)";

/** Статусы, означающие «аналитик подтвердил», — решение принимается по коду, а не по ярлыку. */
const CONFIRMED_STATUSES = new Set(["CONFIRMED", "MATCH_CONFIRMED"]);
const PENDING_STATUSES = new Set(["PENDING", "NEEDS_REVIEW"]);

/**
 * Причина отказа — клиентскими словами, без внутренних кодов.
 *
 * До клиента доезжает **код**, а не сообщение провайдера, поэтому словарь
 * обязан знать все коды, которыми отказ приходит. На прогоне 91 OpenSanctions
 * ответил `401 Invalid API key`, а лист печатал «источник не ответил в этом
 * прогоне»: кода `PROVIDER_UNAUTHORIZED` в словаре не было, и запасная фраза
 * говорила неправду — источник ответил, и ответил понятно.
 */
const SCREENING_FAILURE_REASONS: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "доступ к базе не настроен",
  NOT_CONFIGURED: "доступ к базе не настроен",
  PROVIDER_NOT_IMPLEMENTED: "официальная интеграция с базой не подключена",
  PROVIDER_DISABLED: "проверка по базе отключена в настройках",
  DISABLED: "проверка по базе отключена в настройках",
  PROVIDER_UNAUTHORIZED: "доступ к базе отклонён: ключ не принят",
  PROVIDER_RATE_LIMITED: "источник ограничил частоту обращений",
  PROVIDER_BAD_RESPONSE: "источник ответил ошибкой",
  PROVIDER_REQUEST_FAILED: "источник не ответил",
  PROVIDER_INVALID_RESPONSE: "ответ источника не удалось разобрать",
  PROVIDER_TIMEOUT: "источник не ответил вовремя",
  PROVIDER_NETWORK_ERROR: "до источника не удалось достучаться",
  // Запрос не отправлялся вовсе: у субъекта не заполнено имя, а имя —
  // единственный обязательный признак проверки. Запасное «источник не ответил»
  // здесь было бы неправдой в другую сторону.
  SUBJECT_NAME_MISSING: "имя субъекта не заполнено, запрос не отправлялся",
};

/** Подпись источника — одна на все страницы раздела. */
const COMPLIANCE_SOURCE_NOTE =
  "Источник: комплаенс-базы (существующий контур, без расширения источников).";

/** Базы с собственной страницей отчёта; остальные печатаются продолжением сводки. */
const PROVIDERS_WITH_OWN_PAGE = new Set(["DOW_JONES", "LEXISNEXIS"]);

/**
 * Ёмкость страницы карточек — в **строках таблицы**, а не в записях.
 *
 * Карточка записи занимает от трёх строк (имя, категория, статус) до восьми
 * (плюс алиасы, страны, даты рождения, сводка и адрес карточки), и «две записи
 * на лист» ставили на страницу то шесть строк, то восемнадцать. На стр. 69
 * живого отчёта вышло 18 строк карточек + 2 полосы-заголовка + шапка, и
 * рендерер обрезал последнюю строку: `requiredHeight 4 627 880` против
 * `availableHeight 4 602 385`, подпись «Также числится как» напечаталась как
 * «Также числится».
 *
 * Единица бюджета — **слот**: строка таблицы или полоса-заголовок. Число
 * выведено из замера настоящей страницы (`renderer/smoke_search_table_layout.py`,
 * Т8ж; тем же приёмом, что ёмкость таблицы выдачи в реестре шаблонов), и
 * страниц у базы две разных:
 *
 *   низ белой сцены                  6 110 200  (фигура orion_card_pNN)
 *   верх таблицы, последний лист     1 903 445  (вводный абзац 351 знак:
 *                                                «почему важно» и «что сделать»
 *                                                стоят в справке, и из абзаца
 *                                                их вычищает дедупликация)
 *   верх таблицы, продолжение        2 270 000  (справки в таблице нет, те же
 *                                                две фразы остаются в абзаце —
 *                                                560 знаков)
 *
 * Потолок обязан быть не меньше, чем **худшая карточка вместе с самой широкой
 * справкой**: девять слотов (восемь строк и полоса) плюс четыре (три строки
 * справки LexisNexis и полоса) — иначе запись, не влезшая в бюджет, уезжает на
 * свой лист «любой ценой», справка ложится сверху, и лист выходит за
 * объявленный потолок. У Dow Jones справка на строку короче, поэтому «три
 * слота под справку» верно только для неё.
 *
 * Отсюда тринадцать. Замер худшего законного листа: предельная карточка плюс
 * справка LexisNexis — низ таблицы 5 586 445 при низе сцены 6 110 200, запас
 * 523 755 EMU. Справка резервируется на **каждой** странице базы: какая из них
 * последняя, набор узнаёт только в конце, а лишний резерв стоит пустоты, тогда
 * как его отсутствие стоит обрезанной карточки.
 *
 * Ошибаться здесь безопаснее в сторону лишней страницы: обрезанная строка
 * теперь останавливает выдачу целиком (`services/render-telemetry-gate.ts`).
 * Поднять число нельзя молча — смок строит из него самый плотный законный лист
 * и меряет его на настоящей странице: на четырнадцати слотах запас падает до
 * 295 155 и проверка краснеет.
 */
export const CARD_PAGE_SLOTS = 13;

/**
 * Ёмкость сводной страницы — в **строках** её таблицы.
 *
 * Полос-заголовков у сводки нет, поэтому слот здесь — строка записи. Потолок ей
 * нужен по той же причине, по какой он нужен карточкам, и даже сильнее: до
 * этого шага строк печаталось столько, сколько записей, а один импортированный
 * PDF LexisNexis кладёт в дело до сорока записей (`uniqueCandidates.slice(0, 40)`
 * в `compliance-providers/lexisnexis-hybrid-import.ts`), и все сорок доезжают до
 * деки со статусом `NEEDS_REVIEW`. Сорок строк не влезают ни при каких именах, а
 * клип на странице комплаенса останавливает выдачу — оплаченный прогон вставал
 * бы в отказ, из которого не выходит ни пересборкой, ни повтором рендера.
 *
 * Число своё, а не `CARD_PAGE_SLOTS`, потому что строка другая: имя записи
 * законно занимает до 90 знаков и ложится в четыре строки, статус «не
 * зафиксирован» — в две, а вводный абзац сводки называет базы и все три статуса.
 * Замер (`renderer/smoke_search_table_layout.py`, Т8е) на худшей законной
 * странице:
 *
 *   пять строк   — низ таблицы 5 555 660, низ сцены 6 110 200, запас 554 540
 *   шесть строк  — сцена пробита
 *
 * То есть двенадцать строк сводки не влезли бы и при обычных именах
 * (переполнение с одиннадцатой), и «тот же потолок, что у карточек» оставил бы
 * ровно тот отказ, ради которого потолок и заводится.
 */
export const SUMMARY_PAGE_ROWS = 5;

/**
 * Список алиасов записи: разделитель — точка с запятой.
 *
 * Живые данные Dow Jones и OpenSanctions дают алиасы в форме «Фамилия, Имя»,
 * и склейка запятой превращала три имени в шесть.
 */
function aliasList(aliases: string[]): string {
  const shown = aliases.slice(0, 3);
  const rest = aliases.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} и ещё ${rest}` : shown.join("; ");
}

/**
 * Собственное имя записи — или `undefined`.
 *
 * Имя записи и имя субъекта — разные наблюдения. `pickComplianceClientMatchTitle`
 * при пустом `matchedName` подставляет имя субъекта ещё на сборе, поэтому по
 * заголовку инвентаря («title») отличить подстановку от настоящего имени
 * нельзя: в эталоне 72 все три записи так и получили «Глинка Сергей
 * Михайлович», не имея своего имени вовсе. Напечатать его в колонке
 * «Совпадение по имени» значило бы утверждать, что запись найдена по имени
 * субъекта, — утверждение без наблюдения, и ровно та находка, ради видимости
 * которой колонка и заведена.
 *
 * Поэтому решение принимается по данным: у записи есть собственное
 * `matchedName` или его нет. Строкой это не решается — у настоящего совпадения
 * имя записи законно совпадает с именем субъекта.
 */
function recordOwnName(
  e: ScopedFragmentInput["evidenceIndex"][string]
): string | undefined {
  const name = String(e.matchedName ?? "").trim();
  if (!name || isNarrativeOrPlaceholderMatchName(name)) return undefined;
  return name;
}

/** Категория словами; `undefined` — категории у записи нет (а не «нет в записи»). */
function humanizeComplianceCategory(category: string | undefined): string | undefined {
  const key = String(category ?? "")
    .trim()
    .toUpperCase();
  if (!key || key === "—" || key === "-") return undefined;
  if (COMPLIANCE_CATEGORY_LABELS[key]) return COMPLIANCE_CATEGORY_LABELS[key]!;
  // Never leak SCREAMING_SNAKE enums into the PDF.
  if (/^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(key)) return "Сигнал комплаенс-базы";
  return String(category).replace(/_/g, " ").trim() || undefined;
}

type ComplianceHitEntry = [string, ScopedFragmentInput["evidenceIndex"][string]];

/**
 * Collapse duplicate Lexis/Dow rows (same provider+category+score+name).
 *
 * Ключ берёт заголовок инвентаря, а не собственное имя записи: здесь вопрос
 * «это одна и та же строка?», а не «как называется запись». У записей без
 * своего имени собственное имя пусто у всех сразу, и склейка по нему объединила
 * бы разные записи одной базы в одну строку отчёта.
 */
export function dedupeComplianceHits(
  hits: ComplianceHitEntry[],
  subjectDisplayName?: string
): ComplianceHitEntry[] {
  const seen = new Set<string>();
  const out: ComplianceHitEntry[] = [];
  for (const h of hits) {
    const [, e] = h;
    const key = [
      String(e.providerLabel ?? "").toUpperCase(),
      humanizeComplianceCategory(e.matchCategory) ?? "",
      e.matchScore ?? "",
      pickComplianceClientMatchTitle({
        matchedName: e.title,
        subjectName: subjectDisplayName,
        fallback: subjectDisplayName,
      }).toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function buildComplianceFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment("COMPLIANCE_MAIN");
  const [summarySlot, dowSlot, lexisSlot] = slots;
  // p36_lexis_visual_2 is covered via EXPLICIT_SLOT_MERGES → p35_lexis_visual:
  // its v72 content does not justify a standalone page in this dataset.
  const complianceUnits = scoped.surfaceUnits.filter((u) => u.surface === "compliance");
  const refs = complianceUnits.flatMap((u) => u.evidenceRefs);
  const subjectName = scoped.subject.displayName;
  const allHits = Object.entries(scoped.evidenceIndex).filter(
    ([, e]) => e.kind === "compliance_hit"
  );
  const hits = dedupeComplianceHits(allHits, subjectName);
  const collapsedCount = allHits.length - hits.length;

  const hitLabel = ([, e]: ComplianceHitEntry) => ({
    provider: complianceProviderLabel(e.providerLabel),
    providerKey: String(e.providerLabel ?? "").toUpperCase(),
    category: humanizeComplianceCategory(e.matchCategory),
    status:
      COMPLIANCE_STATUS_LABELS[String(e.reviewStatus ?? "").toUpperCase()] ?? STATUS_NOT_RECORDED,
    name: recordOwnName(e),
  });

  const isConfirmed = ([, e]: ComplianceHitEntry): boolean =>
    CONFIRMED_STATUSES.has(String(e.reviewStatus ?? "").toUpperCase());
  const isPendingReview = ([, e]: ComplianceHitEntry): boolean =>
    PENDING_STATUSES.has(String(e.reviewStatus ?? "").toUpperCase());

  const summaryRowOf = (h: ComplianceHitEntry): string[] => {
    const l = hitLabel(h);
    // В сводной таблице колонки фиксированы, и «—» здесь читается как «поле
    // есть, значения нет» — структура колонок сообщает это сама.
    return [l.provider, l.category ?? "—", l.name ?? "—", l.status];
  };

  /**
   * Карточка одной записи: только те строки, под которые есть данные.
   *
   * Пустое поле — отсутствующая строка, а не прочерк: прочерк в «Даты рождения
   * в записи» утверждал бы «в записи даты нет», а мы знаем лишь «поле не
   * перенесено нашим контуром». Обязательны три строки — имя, категория и
   * статус: без них таблица не отвечает на вопрос «что это за совпадение и что
   * с ним делать».
   */
  const recordRows = (h: ComplianceHitEntry): string[][] => {
    const [, e] = h;
    const l = hitLabel(h);
    const rows: string[][] = [
      // Прочерк, а не имя субъекта: «поле есть, значения нет» — то же правило,
      // что у колонок сводной таблицы, и единственное честное здесь.
      ["Совпадение по имени", l.name ?? "—"],
      ["Категория", l.category ?? COMPLIANCE_CATEGORY_LABELS.OTHER!],
      ["Статус проверки", l.status],
    ];
    const aliases = (e.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (aliases.length > 0) {
      rows.push(["Также числится как", clampClientText(aliasList(aliases), 200)]);
    }
    // Страна печатается названием, а не кодом провайдера: «ru, ch» на странице
    // 61 живого прогона — такой же машинный текст посреди клиентского, как коды
    // тем. Список тот же, что печатался раньше; вторым полем записи он не
    // становится.
    const countries = countryNamesRu((e.countries ?? []).map((c) => String(c)));
    // Кламп тот же, что у строки алиасов, и по той же причине: это вторая
    // многозначная строка карточки, а после перевода кодов в названия её
    // значения выросли втрое-вшестеро. Без него ячейка переполнялась на записи
    // с десятком стран.
    if (countries.length > 0) {
      rows.push(["Страны в записи", clampClientText(countries.join(", "), 200)]);
    }
    const dates = (e.datesOfBirth ?? []).map((d) => String(d).trim()).filter(Boolean);
    if (dates.length > 0) rows.push(["Даты рождения в записи", dates.join(", ")]);
    const summary = String(e.summary ?? "").trim();
    if (summary) rows.push(["Сводка записи", clampClientText(summary, 300)]);
    const url = String(e.url ?? "").trim();
    if (url) rows.push(["Карточка записи", url]);
    return rows;
  };

  /**
   * Разложить записи по листам по бюджету слотов.
   *
   * Цена записи — её строки плюс полоса-заголовок; цена справки — её строки
   * плюс своя полоса. Запись не режется между листами: карточка — печатный
   * носитель правила «совпадение уходит аналитику целиком», и половина
   * карточки не отвечает ни на один вопрос. Поэтому запись, которая в остаток
   * не влезла, уезжает на следующий лист целиком, а лист, на котором нет ещё
   * ни одной записи, берёт её при любой цене: пустой страницы быть не должно.
   *
   * Последнее правило сегодня не срабатывает ни разу — потолок выбран так, что
   * худшая карточка влезает в бюджет любой базы (см. `CARD_PAGE_SLOTS`), — но
   * названо, потому что оно и есть выбор между обрезанной карточкой и лишней
   * страницей, если состав карточки когда-нибудь вырастет.
   */
  const packRecordPages = (
    records: ComplianceHitEntry[],
    infoRowCount: number
  ): Array<{ hits: ComplianceHitEntry[]; firstRecordIndex: number }> => {
    const budget = CARD_PAGE_SLOTS - (infoRowCount > 0 ? infoRowCount + 1 : 0);
    const pages: Array<{ hits: ComplianceHitEntry[]; firstRecordIndex: number }> = [];
    let used = 0;
    records.forEach((h, index) => {
      const cost = recordRows(h).length + 1;
      if (pages.length === 0 || used + cost > budget) {
        pages.push({ hits: [], firstRecordIndex: index });
        used = 0;
      }
      pages[pages.length - 1]!.hits.push(h);
      used += cost;
    });
    return pages;
  };

  /** Есть ли у записи хоть одно поле сверх трёх обязательных. */
  const hasSubstantiveFields = (h: ComplianceHitEntry): boolean =>
    recordRows(h).length > 3;

  /** Разбивка записей по статусам — одна формулировка на сводку и на страницу базы. */
  const statusBreakdown = (
    pageHits: ComplianceHitEntry[]
  ): { confirmed: number; pending: number; unrecorded: number; phrase: string } => {
    const confirmed = pageHits.filter(isConfirmed).length;
    const pending = pageHits.filter(isPendingReview).length;
    const unrecorded = pageHits.length - confirmed - pending;
    const parts = [
      `подтверждено аналитиком — ${confirmed}`,
      `требует ручной проверки — ${pending}`,
    ];
    if (unrecorded > 0) parts.push(`статус не зафиксирован — ${unrecorded}`);
    return { confirmed, pending, unrecorded, phrase: parts.join(", ") };
  };

  /**
   * Что именно нашли — выводится из статусов записей, а не пишется заранее.
   *
   * Захардкоженное «совпадение не подтверждено» стояло и на записи, которую
   * аналитик подтвердил: страница спорила со своей же таблицей. По той же
   * причине фраза описывает состав листа, а не первую строку: при двух записях
   * разного статуса вердикт по первой противоречил бы строке второй.
   */
  const whatWasFoundFor = (pageHits: ComplianceHitEntry[]): string => {
    if (pageHits.length > 1) {
      return clampClientText(
        `Записей на странице: ${pageHits.length}; ${statusBreakdown(pageHits).phrase}.`,
        400
      );
    }
    const h = pageHits[0]!;
    const l = hitLabel(h);
    const subject = l.category ? `Совпадение категории «${l.category}»` : "Совпадение по субъекту";
    if (isConfirmed(h)) return clampClientText(`${subject} подтверждено аналитиком.`, 400);
    const potential = l.category
      ? `Потенциальное совпадение категории «${l.category}»`
      : "Потенциальное совпадение по субъекту";
    return clampClientText(
      `${potential}; совпадение не подтверждено и требует ручной проверки.`,
      400
    );
  };

  // C.4 — several records of one provider go into the param table as separate
  // banded blocks («Запись 1 из N — имя»), not one flat list with repeating keys.
  const providerParamTable = (
    provHits: ComplianceHitEntry[],
    infoRows: string[][],
    totalRecords: number,
    firstRecordIndex: number
  ): {
    headers: string[];
    rows: string[][];
    groups?: Array<{ rowStart: number; rowCount: number; queryDisplay: string; qTag?: string }>;
  } => {
    const headers = ["Параметр", "Значение"];
    if (totalRecords <= 1) {
      return { headers, rows: [...provHits.flatMap(recordRows), ...infoRows] };
    }
    const rows: string[][] = [];
    const groups: Array<{ rowStart: number; rowCount: number; queryDisplay: string; qTag?: string }> = [];
    provHits.forEach((h, i) => {
      const rec = recordRows(h);
      const l = hitLabel(h);
      groups.push({
        rowStart: rows.length,
        rowCount: rec.length,
        qTag: `Запись ${firstRecordIndex + i + 1} из ${totalRecords}`,
        // Блок подписан именем записи, а без него — своей базой: подпись «—»
        // ничего не сообщает, а имя субъекта здесь утверждало бы то же, что и
        // в ячейке имени.
        queryDisplay: l.name ?? l.provider,
      });
      rows.push(...rec);
    });
    if (infoRows.length > 0) {
      groups.push({
        rowStart: rows.length,
        rowCount: infoRows.length,
        qTag: "Справка",
        queryDisplay: "значение раздела и рекомендации",
      });
      rows.push(...infoRows);
    }
    return { headers, rows, groups };
  };

  const hitsOfProvider = (key: string): ComplianceHitEntry[] =>
    hits.filter(([, e]) => String(e.providerLabel ?? "").toUpperCase() === key);
  const dowHits = hitsOfProvider("DOW_JONES");
  const lexisHits = hitsOfProvider("LEXISNEXIS");

  /**
   * Исход проверки по одной базе — словами и в одном месте.
   *
   * Тем же исходом базу описывают два листа: страница базы (абзацем) и сводный
   * лист при нуле совпадений (строкой перечня). Вторая формулировка того же
   * исхода означала бы, что одна и та же проверка на двух страницах отчёта
   * названа по-разному, — поэтому слова живут здесь, а листы их только
   * оформляют.
   *
   * Ветвь выбирают данные, а не конфигурация: есть строка рана — проверка
   * была, нет строки — не была. Чтение окружения сделало бы клиентский текст
   * зависимым от машины, на которой собирают отчёт.
   *
   * `result` — продолжение слова «Проверка»: «выполнена 12.05.2026: совпадений
   * по субъекту не найдено», «не выполнена: доступ к базе не настроен».
   */
  const screeningOutcome = (
    providerKey: string
  ): {
    kind: "performed-clean" | "records-excluded" | "not-performed" | "never-run";
    result: string;
    emptyStateReason: string;
  } => {
    const run = (extras.complianceScreenings ?? []).find(
      (s) => String(s.provider ?? "").toUpperCase() === providerKey
    );
    if (run && String(run.status).toUpperCase() === "SUCCESS") {
      const date = run.finishedAt ? formatRuDate(String(run.finishedAt)) : null;
      const performed = date ? `выполнена ${date}` : "выполнена";
      if (Number(run.hitCount ?? 0) > 0) {
        return {
          kind: "records-excluded",
          result:
            `${performed}: найдено записей — ${Number(run.hitCount)}, ` +
            "но в материал отчёта не вошла ни одна",
          emptyStateReason: "compliance-records-excluded",
        };
      }
      return {
        kind: "performed-clean",
        result: `${performed}: совпадений по субъекту не найдено`,
        emptyStateReason: "no-compliance-records",
      };
    }
    if (run) {
      const reason =
        SCREENING_FAILURE_REASONS[String(run.errorCode ?? "").toUpperCase()] ??
        SCREENING_FAILURE_REASONS[String(run.status).toUpperCase()] ??
        "источник не ответил в этом прогоне";
      return {
        kind: "not-performed",
        result: `не выполнена: ${reason}`,
        emptyStateReason: "compliance-check-not-performed",
      };
    }
    return {
      kind: "never-run",
      result: "по официальному API не выполнялась: доступ подключается по договору",
      emptyStateReason: "compliance-check-not-performed",
    };
  };

  /**
   * Пустая страница базы называет то, что о проверке известно.
   *
   * Прежняя формула «Проверка по базе X выполнена: записей о субъекте не
   * зафиксировано» печаталась всегда — в том числе там, где проверки не было
   * вовсе (официального доступа к Dow Jones / LexisNexis у контура нет).
   * NOT_CONFIGURED, выданный за «совпадений нет», сообщает читателю, что его
   * профиль по этой базе чист, когда он по ней не проверен.
   */
  const emptyPageCopy = (
    provider: string,
    providerKey: string
  ): { narrative: string; whatToCheck: string; emptyStateReason: string } => {
    const outcome = screeningOutcome(providerKey);
    // Ран нашёл записи, а на странице их нет: они сняты разбором или отсеяны
    // как служебные. Назвать это «совпадений не найдено» — то же ложное
    // утверждение о проверке, что и «выполнена» там, где её не было; поэтому
    // печатаются оба числа, а причина расхождения не выдумывается.
    if (outcome.kind === "records-excluded" || outcome.kind === "performed-clean") {
      return {
        // Оговорка «результат на дату проверки» одна на обе выполненные
        // проверки: расхождение этой фразы между ними было бы разницей без
        // причины.
        narrative:
          `Проверка по базе ${provider} ${outcome.result}. Это результат на дату проверки, ` +
          "а не вывод об отсутствии рисков.",
        whatToCheck:
          outcome.kind === "records-excluded"
            ? `Открыть записи по базе ${provider} в деле и проверить, почему они не вошли в ` +
              "отчёт; снятые по ошибке — вернуть в рассмотрение."
            : `Повторить сверку по базе ${provider} при следующем обновлении данных; при ` +
              "появлении записи запросить полную карточку и сверить идентификаторы субъекта.",
        emptyStateReason: outcome.emptyStateReason,
      };
    }
    if (outcome.kind === "not-performed") {
      return {
        narrative:
          `Проверка по базе ${provider} ${outcome.result}. ` +
          "Записей ручного импорта по этой базе в деле нет.",
        whatToCheck:
          `Устранить причину и повторить проверку по базе ${provider}; до этого пустая ` +
          "страница не означает «совпадений нет».",
        emptyStateReason: outcome.emptyStateReason,
      };
    }
    return {
      narrative:
        `Записей о субъекте по базе ${provider} в этом прогоне нет. Проверка ${outcome.result}; ` +
        "ручной импорт записей не содержит.",
      whatToCheck:
        `Подключить официальный доступ к базе ${provider} по договору или импортировать запись ` +
        "вручную; до этого отсутствие записей не является результатом проверки.",
      emptyStateReason: outcome.emptyStateReason,
    };
  };

  /**
   * Страница одной комплаенс-базы.
   *
   * Шаг 13, C13 — при нуле записей страница печатала таблицу «Параметр /
   * Значение», где значениями была проза («Категория PEP влияет на уровень
   * комплаенс-контроля…»), и подавала это как содержание профиля. Утверждать
   * значимость категории PEP, не имея ни одной записи, нельзя: пустая база —
   * это результат проверки, и выглядеть он должен как результат проверки.
   */
  const providerSlides = (input: {
    slot: (typeof slots)[number];
    provider: string;
    providerKey: string;
    hits: ComplianceHitEntry[];
    infoRows: string[][];
    narrative: string;
    whyWithRecords: string;
    whyWithoutRecords: string;
    whatToCheckWithRecords: string;
    sourceNote: string;
    emptyStateReason?: string;
  }): SlideContentContract[] => {
    if (input.hits.length === 0) {
      const copy = emptyPageCopy(input.provider, input.providerKey);
      return [
        makeSlotSlide({
          slot: input.slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: {
            narrative: copy.narrative,
            bullets: [input.whyWithoutRecords],
            whatToCheck: copy.whatToCheck,
            sourceNote: input.sourceNote,
          },
          evidenceRefs: [],
          findingIds: [],
          metrics: { hits: 0 },
          emptyStateReason: copy.emptyStateReason,
        }),
      ];
    }
    // Записей больше, чем помещается на лист, — они уходят на продолжения, а не
    // теряются и не режутся: карточка приезжает к аналитику целиком.
    const pages = packRecordPages(input.hits, input.infoRows.length);
    return pages.map(({ hits: pageHits, firstRecordIndex }, pageIndex) => {
      const isCont = pageIndex > 0;
      const base = makeSlotSlide({
        slot: input.slot,
        sectionId,
        templateId: "serp-table",
        content: {
          narrative: input.narrative,
          table: providerParamTable(
            pageHits,
            // Справка печатается один раз — на последней странице базы.
            pageIndex === pages.length - 1 ? input.infoRows : [],
            input.hits.length,
            firstRecordIndex
          ),
          whatWasFound: whatWasFoundFor(pageHits),
          whyItMatters: input.whyWithRecords,
          whatToCheck: input.whatToCheckWithRecords,
          sourceNote: input.sourceNote,
        },
        evidenceRefs: pageHits.map(([r]) => r),
        findingIds: [],
        metrics: { hits: pageHits.length },
        ...(input.emptyStateReason ? { emptyStateReason: input.emptyStateReason } : {}),
      });
      if (!isCont) return base;
      return {
        ...base,
        slideId: `${input.slot.slotId}__cont${pageIndex}`,
        isContinuation: true,
        continuationOf: input.slot.slotId,
        continuationIndex: pageIndex,
        title: continuationTitle(base.title, pageIndex + 1, pages.length),
      };
    });
  };

  /**
   * Нарратив сводной страницы — два предложения: чего нашли и что это значит.
   *
   * Рекомендация ручной верификации в него не входит — она отдельным полем
   * `whatToCheck` и печатается под ними своим абзацем.
   *
   * Счётчик «Проверено записей комплаенс-контура» отсюда убран: он цитировал
   * метрику поверхности (`totalCount`), в которую входят внутренние находки, и
   * выдавал их за записи комплаенс-баз. Число записей считается по самим
   * записям и совпадает с числом строк таблицы.
   */
  const summaryNarrative = (): string => {
    const bases = enumerateRu([...new Set(hits.map((h) => hitLabel(h).provider))], 4);
    const collapsed = collapsedCount > 0 ? `; повторные записи объединены: ${collapsedCount}` : "";
    return (
      `Записей, отобранных по имени субъекта в комплаенс-базах: ${hits.length} (${bases}). ` +
      `Совпадение по базе не подтверждается автоматически: ${statusBreakdown(hits).phrase}${collapsed}.`
    );
  };

  /**
   * Сводная таблица разбивается на листы так же, как карточки.
   *
   * Полос-заголовков у неё нет, поэтому разбивка простая — по числу строк. При
   * пустом наборе листов таблицы нет вовсе: страница остаётся, но говорит
   * словами (см. `emptySummarySlide`).
   */
  const summaryTablePages = chunk(hits, SUMMARY_PAGE_ROWS);
  const summaryTable = (pageHits: ComplianceHitEntry[]) => ({
    headers: [...COMPLIANCE_SUMMARY_HEADERS],
    rows: pageHits.map(summaryRowOf),
  });

  /**
   * Сводный лист при нуле совпадений — то же решение, что уже принято для
   * страницы базы (шаг 13, C13): таблицы нет вовсе, и лист говорит словами.
   *
   * Пока лист объявлял `table` с пустым `rows`, рендерер шёл запасной веткой
   * `if not rows and bullets`: ставил заголовки таблицы поиска «Поз. / Домен /
   * Заголовок / Риск» и разбирал в строки то, что подвернулось. Клиент читал
   * выдуманную таблицу поиска на странице комплаенса — и одну строку прочерков
   * вместо ответа проверки.
   *
   * Перечень баз — из ранов скрининга: базы, по которой рана нет, лист не
   * называет, потому что о ней и сказать нечего, кроме «не проверяли», и это
   * говорит её собственная страница. Строк не больше четырёх — столько баз, по
   * которым бывает ран (`ComplianceProviderName` без `MANUAL_IMPORT`), и ровно
   * столько печатает карточка листа.
   */
  const emptySummarySlide = (): SlideContentContract => {
    const outcomes = (extras.complianceScreenings ?? []).map((run) => {
      const providerKey = String(run.provider ?? "").toUpperCase();
      return { provider: complianceProviderLabel(run.provider), ...screeningOutcome(providerKey) };
    });
    // Перечень строится по самим ранам, поэтому «рана нет» здесь не бывает:
    // непроверенная база — это ран с отказом.
    const unchecked = outcomes.filter((o) => o.kind === "not-performed");
    /*
     * Смысл пустоты — читателю, и ровно один раз.
     *
     * Отчёт читает сам субъект, и рекомендации вида «подключить официальный
     * доступ по договору» или «повторить сверку при следующем обновлении
     * данных» описывают нашу работу: выполнить их читатель не может. Поэтому
     * на месте рекомендации стоит то, что отсутствие совпадений значит и чего
     * не значит, — и стоит в абзаце, а не отдельным полем: макет печатает
     * `whatToCheck` карточкой «Что проверить», то есть под заголовком,
     * обещающим действие. Оговорка при этом печатается один раз: на коротком
     * листе она стояла в обеих карточках из двух.
     *
     * Порядок фраз тоже смысловой. Там, где не проверяли ни одной базы, лист
     * начинается состоянием проверки: «совпадений не зафиксировано» первым
     * читается как вывод, которого у непроверенной базы нет.
     *
     * Внутренних слов здесь быть не может по той же причине: «записей о
     * проверках в артефактах прогона нет» — наша лексика, читателю она не
     * говорит ничего. Состояние называется тем, что он понимает: база не
     * проверялась.
     */
    /*
     * Вывод делается только по **состоявшейся** проверке.
     *
     * Ветка выбиралась по наличию записи о попытке, и одна провалившаяся
     * попытка давала лист, начинающийся словами «Совпадений по субъекту в
     * комплаенс-базах в этом прогоне не зафиксировано». Это утверждение о
     * человеке при нуле выполненных проверок — ровно то, что правило «состояние
     * это данные, а не название» запрещает. Прогон 91: единственная работающая
     * база ответила 401, и лист сообщил клиенту, что он чист.
     */
    const performed = outcomes.filter((o) => o.kind === "performed-clean");
    /*
     * Найденные записи, не доехавшие до отчёта, выводом о чистоте не бывают.
     *
     * `records-excluded` — это проверка **с совпадениями**, которых на листе
     * нет: их отсеяла разметка или они не прошли отбор. Первое предложение
     * «совпадений не зафиксировано» опровергалось бы вторым — буллетом
     * «найдено записей — 3, но в материал отчёта не вошла ни одна» — на той же
     * странице.
     */
    const excluded = outcomes.filter((o) => o.kind === "records-excluded");
    const narrative =
      excluded.length > 0
        ? "По части комплаенс-баз записи найдены, но ни одна не вошла в материал отчёта — " +
          "ниже сказано, по какой именно. Вывода об отсутствии совпадений здесь нет: " +
          "найденное требует разбора аналитиком, а не молчания."
        : performed.length === 0
        ? "Ни одна комплаенс-база в этом прогоне не проверялась. Поэтому вывода об " +
          "отсутствии записей здесь нет: отсутствие совпадений результатом проверки не является."
        : unchecked.length > 0
          ? "Совпадений по субъекту в комплаенс-базах в этом прогоне не зафиксировано. " +
            "Ниже — что проверялось по каждой базе: там, где проверка не состоялась, вывода " +
            "нет, и её молчание результатом проверки не является."
          : "Совпадений по субъекту в комплаенс-базах в этом прогоне не зафиксировано. " +
            "Ниже — что проверялось по каждой базе: это результат на дату проверки, а не " +
            "вывод об отсутствии рисков.";
    return makeSlotSlide({
      slot: summarySlot,
      sectionId,
      templateId: "coverage-empty-state",
      content: {
        narrative,
        // Строк не больше четырёх — столько баз, по которым бывает ран, и
        // столько же печатает карточка листа. Равенство не на глаз: его
        // сверяет `empty-compliance-summary-speaks-in-words.test.ts` по
        // перечню провайдеров и ёмкости шаблона.
        bullets: outcomes.map((o) => `${o.provider} — проверка ${o.result}.`),
        sourceNote: COMPLIANCE_SOURCE_NOTE,
      },
      evidenceRefs: [...refs],
      findingIds: scoped.findings.map((f) => f.findingId),
      metrics: { complianceItems: refs.length, hits: 0 },
      // «Проверено, записей нет» и «проверка не выполнялась» — разные ответы
      // читателю: первый говорит, что по базе его нет, второй — что о базе мы
      // ничего не знаем. Разбор качества отчёта различает их по этому признаку.
      emptyStateReason:
        unchecked.length === 0 && outcomes.length > 0
          ? "no-compliance-records"
          : "compliance-check-not-performed",
    });
  };

  const summarySlide =
    summaryTablePages.length === 0
      ? emptySummarySlide()
      : makeSlotSlide({
          slot: summarySlot,
          sectionId,
          templateId: "serp-table",
          content: {
            narrative: summaryNarrative(),
            table: summaryTable(summaryTablePages[0]!),
            whatToCheck:
              "Верифицировать каждое потенциальное совпадение вручную: сопоставить идентификаторы субъекта с записью базы.",
            sourceNote: COMPLIANCE_SOURCE_NOTE,
          },
          evidenceRefs: [...refs, ...hits.map(([r]) => r)],
          findingIds: scoped.findings.map((f) => f.findingId),
          metrics: { complianceItems: refs.length, hits: hits.length },
        });

  /**
   * Карточки баз, у которых нет своей страницы (OpenSanctions, World-Check).
   *
   * Слоты p34/p35 закреплены за Dow Jones и LexisNexis, поэтому поля
   * единственного живого провайдера не печатались бы нигде. Продолжение
   * появляется только у записи с содержательными полями: страница ради трёх
   * обязательных строк читателю ничего не даёт.
   */
  const otherBaseHits = hits.filter(
    (h) => !PROVIDERS_WITH_OWN_PAGE.has(hitLabel(h).providerKey) && hasSubstantiveFields(h)
  );
  // Тот же бюджет строк, что и у страниц баз: здесь печатаются такие же
  // карточки, и «две записи на лист» переполняло бы лист ровно так же.
  // Справки на этих листах нет, поэтому её слоты бюджет не резервирует.
  const otherBasePages = packRecordPages(otherBaseHits, 0);

  /**
   * Продолжения сводной страницы — одна цепочка на один слот.
   *
   * Сначала хвост сводной таблицы, потом карточки баз без своей страницы.
   * Нумерация общая не для красоты: индексы продолжений одного слота обязаны
   * идти подряд от единицы (`section-validation`), а подпись — называть длину
   * всей цепочки, а не одной её половины.
   */
  const summarySlotPages = summaryTablePages.length + otherBasePages.length;
  const summaryContinuations: SlideContentContract[] = [];
  const pushSummaryContinuation = (
    pageHits: ComplianceHitEntry[],
    content: SlideContentContract["content"]
  ): void => {
    summaryContinuations.push({
      ...buildContinuationSlide({
        base: summarySlide,
        index: summaryContinuations.length + 2,
        totalPages: summarySlotPages,
        content,
      }),
      evidenceRefs: pageHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: pageHits.length },
    });
  };

  summaryTablePages.slice(1).forEach((pageHits, pageIndex) => {
    const from = (pageIndex + 1) * SUMMARY_PAGE_ROWS + 1;
    // Что на листе — говорят сами записи: и слово, и номера выводятся из их
    // числа. На последнем листе запись бывает одна (шесть записей, одиннадцать,
    // шестнадцать…), и «записи 6–6 из 6» — диапазон, у которого один конец, во
    // множественном числе про одну строку. Клиент банка читает это буквально.
    const span =
      pageHits.length === 1 ? `${from}` : `${from}–${from + pageHits.length - 1}`;
    pushSummaryContinuation(pageHits, {
      // Лист называет свои записи, а не повторяет счёт всей сводки: «записей 40»
      // на третьем листе не отвечает, что именно на нём стоит. Рекомендацию с
      // продолжений снимает общий конструктор — поэтому отсылка обязана назвать
      // и её: иначе лист выглядит как строки без вывода.
      narrative:
        `Продолжение сводки комплаенс-баз: ${pluralRu(pageHits.length, "запись", "записи", "записи")} ` +
        `${span} из ${hits.length}. Состав баз, разбивка по статусам и рекомендация по проверке ` +
        "названы на первой странице сводки.",
      table: summaryTable(pageHits),
      sourceNote: COMPLIANCE_SOURCE_NOTE,
    });
  });

  otherBasePages.forEach(({ hits: pageHits, firstRecordIndex }) => {
    pushSummaryContinuation(pageHits, {
      narrative:
        "Записи баз, у которых нет отдельной страницы отчёта: поля приведены так же, как на " +
        "страницах Dow Jones и LexisNexis.",
      table: providerParamTable(pageHits, [], otherBaseHits.length, firstRecordIndex),
      sourceNote: COMPLIANCE_SOURCE_NOTE,
    });
  });

  const slides: SlideContentContract[] = [
    summarySlide,
    ...summaryContinuations,
    ...providerSlides({
      slot: dowSlot!,
      provider: "Dow Jones",
      providerKey: "DOW_JONES",
      hits: dowHits,
      narrative:
        "Профиль по данным Dow Jones: существующий комплаенс-контент, источники не расширялись.",
      infoRows: [
        [
          "Почему важно",
          "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
        ],
        [
          "Что сделать",
          "Запросить полную карточку записи Dow Jones, включая связанных лиц (RCA), и сверить идентификаторы субъекта.",
        ],
      ],
      whyWithRecords:
        "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
      whyWithoutRecords:
        "База Dow Jones отвечает на вопрос о статусе политически значимого лица: запись в ней подняла бы уровень контроля при онбординге и мониторинге. В текущем наборе такой записи по субъекту нет.",
      whatToCheckWithRecords:
        "Запросить полную карточку записи Dow Jones, включая связанных лиц (RCA), и сверить идентификаторы субъекта.",
      sourceNote: "Источник: Dow Jones (существующий контур).",
    }),
    ...providerSlides({
      slot: lexisSlot!,
      provider: "LexisNexis",
      providerKey: "LEXISNEXIS",
      hits: lexisHits,
      narrative:
        "Страница профиля LexisNexis. Визуальный экспорт страницы в текущем наборе недоступен; содержимое записи приведено в текстовом виде без потерь. Вторая страница профиля из отчёта v72 объединена с этой: отдельного содержимого у неё нет.",
      infoRows: [
        [
          "Почему важно",
          "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
        ],
        [
          "Что сделать",
          "Запросить полную карточку записи LexisNexis, включая связанных лиц (RCA), и проверить первоисточники публикаций.",
        ],
        [
          "Визуальный экспорт",
          "Недоступен в текущем наборе; данные приведены в текстовом виде без потерь.",
        ],
      ],
      whyWithRecords:
        "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
      whyWithoutRecords:
        "База LexisNexis собирает негативные публикации и правовые сюжеты: запись в ней потребовала бы проверки первоисточников. В текущем наборе такой записи по субъекту нет.",
      whatToCheckWithRecords:
        "Запросить полную карточку записи LexisNexis, включая связанных лиц (RCA), и проверить первоисточники публикаций.",
      sourceNote: "Источник: LexisNexis (существующий контур).",
      emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
    }),
  ];
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// APPENDIX (non-canonical, optional)
// ---------------------------------------------------------------------------
