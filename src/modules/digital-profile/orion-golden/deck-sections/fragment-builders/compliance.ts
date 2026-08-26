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
import { continuationTitle } from "../continuation-slide";


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

/** Причина, по которой проверка не состоялась, — словами, без внутренних кодов. */
const SCREENING_FAILURE_REASONS: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "доступ к базе не настроен",
  NOT_CONFIGURED: "доступ к базе не настроен",
  PROVIDER_NOT_IMPLEMENTED: "официальная интеграция с базой не подключена",
  PROVIDER_DISABLED: "проверка по базе отключена в настройках",
  DISABLED: "проверка по базе отключена в настройках",
};

/** Базы с собственной страницей отчёта; остальные печатаются продолжением сводки. */
const PROVIDERS_WITH_OWN_PAGE = new Set(["DOW_JONES", "LEXISNEXIS"]);

/** Сколько записей одной базы помещается на страницу карточек. */
const RECORDS_PER_PAGE = 2;

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

  const summaryRows = hits.map((h) => {
    const l = hitLabel(h);
    // В сводной таблице колонки фиксированы, и «—» здесь читается как «поле
    // есть, значения нет» — структура колонок сообщает это сама.
    return [l.provider, l.category ?? "—", l.name ?? "—", l.status];
  });

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
   * Пустая страница базы называет то, что о проверке известно.
   *
   * Прежняя формула «Проверка по базе X выполнена: записей о субъекте не
   * зафиксировано» печаталась всегда — в том числе там, где проверки не было
   * вовсе (официального доступа к Dow Jones / LexisNexis у контура нет).
   * NOT_CONFIGURED, выданный за «совпадений нет», сообщает банку, что человек
   * проверен, когда он не проверен. Ветвь выбирают данные: есть строка рана —
   * проверка была, нет строки — не была.
   */
  const emptyPageCopy = (
    provider: string,
    providerKey: string
  ): { narrative: string; whatToCheck: string; emptyStateReason: string } => {
    const run = (extras.complianceScreenings ?? []).find(
      (s) => String(s.provider ?? "").toUpperCase() === providerKey
    );
    if (run && String(run.status).toUpperCase() === "SUCCESS") {
      const date = run.finishedAt ? formatRuDate(String(run.finishedAt)) : null;
      const performed = `Проверка по базе ${provider}${date ? ` выполнена ${date}` : " выполнена"}`;
      // Ран нашёл записи, а на странице их нет: они сняты разбором или отсеяны
      // как служебные. Назвать это «совпадений не найдено» — то же ложное
      // утверждение о проверке, что и «выполнена» там, где её не было; поэтому
      // печатаются оба числа, а причина расхождения не выдумывается.
      if (Number(run.hitCount ?? 0) > 0) {
        return {
          narrative:
            `${performed}: найдено записей — ${Number(run.hitCount)}, но в материал отчёта ` +
            "не вошла ни одна. Это результат на дату проверки, а не вывод об отсутствии рисков.",
          whatToCheck:
            `Открыть записи по базе ${provider} в деле и проверить, почему они не вошли в отчёт; ` +
            "снятые по ошибке — вернуть в рассмотрение.",
          emptyStateReason: "compliance-records-excluded",
        };
      }
      return {
        narrative:
          `${performed}: совпадений по субъекту не найдено. Это результат на дату проверки, ` +
          "а не вывод об отсутствии рисков.",
        whatToCheck:
          `Повторить сверку по базе ${provider} при следующем обновлении данных; при появлении ` +
          "записи запросить полную карточку и сверить идентификаторы субъекта.",
        emptyStateReason: "no-compliance-records",
      };
    }
    if (run) {
      const reason =
        SCREENING_FAILURE_REASONS[String(run.errorCode ?? "").toUpperCase()] ??
        SCREENING_FAILURE_REASONS[String(run.status).toUpperCase()] ??
        "источник не ответил в этом прогоне";
      return {
        narrative:
          `Проверка по базе ${provider} не выполнена: ${reason}. ` +
          "Записей ручного импорта по этой базе в деле нет.",
        whatToCheck:
          `Устранить причину и повторить проверку по базе ${provider}; до этого пустая ` +
          "страница не означает «совпадений нет».",
        emptyStateReason: "compliance-check-not-performed",
      };
    }
    return {
      narrative:
        `Записей о субъекте по базе ${provider} в этом прогоне нет. Проверка по официальному ` +
        "API не выполнялась: доступ подключается по договору; ручной импорт записей не содержит.",
      whatToCheck:
        `Подключить официальный доступ к базе ${provider} по договору или импортировать запись ` +
        "вручную; до этого отсутствие записей не является результатом проверки.",
      emptyStateReason: "compliance-check-not-performed",
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
    // теряются: карточка каждой записи занимает до десяти строк таблицы.
    const pages = chunk(input.hits, RECORDS_PER_PAGE);
    return pages.map((pageHits, pageIndex) => {
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
            pageIndex * RECORDS_PER_PAGE
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
    if (hits.length === 0) {
      return (
        "Совпадений по субъекту в комплаенс-базах в этом прогоне не зафиксировано. " +
        "Что проверялось по каждой базе и с каким результатом — на страницах баз."
      );
    }
    const bases = enumerateRu([...new Set(hits.map((h) => hitLabel(h).provider))], 4);
    const collapsed = collapsedCount > 0 ? `; повторные записи объединены: ${collapsedCount}` : "";
    return (
      `Записей, отобранных по имени субъекта в комплаенс-базах: ${hits.length} (${bases}). ` +
      `Совпадение по базе не подтверждается автоматически: ${statusBreakdown(hits).phrase}${collapsed}.`
    );
  };

  const summarySlide = makeSlotSlide({
    slot: summarySlot,
    sectionId,
    templateId: "serp-table",
    content: {
      narrative: summaryNarrative(),
      table: {
        headers: [...COMPLIANCE_SUMMARY_HEADERS],
        rows: summaryRows,
      },
      whatToCheck:
        "Верифицировать каждое потенциальное совпадение вручную: сопоставить идентификаторы субъекта с записью базы.",
      sourceNote: "Источник: комплаенс-базы (существующий контур, без расширения источников).",
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
  const otherBasePages = chunk(otherBaseHits, RECORDS_PER_PAGE);
  const summaryContinuations = otherBasePages.map((pageHits, pageIndex) => ({
    ...makeSlotSlide({
      slot: summarySlot!,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          "Записи баз, у которых нет отдельной страницы отчёта: поля приведены так же, как на " +
          "страницах Dow Jones и LexisNexis.",
        table: providerParamTable(
          pageHits,
          [],
          otherBaseHits.length,
          pageIndex * RECORDS_PER_PAGE
        ),
        sourceNote: "Источник: комплаенс-базы (существующий контур, без расширения источников).",
      },
      evidenceRefs: pageHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: pageHits.length },
    }),
    slideId: `${summarySlot!.slotId}__cont${pageIndex + 1}`,
    isContinuation: true,
    continuationOf: summarySlot!.slotId,
    continuationIndex: pageIndex + 1,
    title: continuationTitle(summarySlot!.title, pageIndex + 2, otherBasePages.length + 1),
  }));

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
