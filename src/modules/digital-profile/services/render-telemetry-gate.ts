/**
 * Ворота потерь рендерера на живом пути.
 *
 * Судят телеметрию **не** здесь: строки классифицирует
 * `classifyLayoutTelemetryRows` — тот же код, которым пользуется TS-инспектор
 * геометрии. Этот модуль только решает, что делать с его выдачей.
 *
 * Приборов при этом всё ещё два, и это надо знать. Приёмка деки читает
 * телеметрию своим python-инспектором (`scripts/inspect-first36-pptx-geometry.py`),
 * и совпадают они только на ветке потери (`CONTENT_DROPPED_BY_RENDERER` —
 * закреплено `tests/unit/telemetry-inspectors-agree.test.ts`). Дальше ответы
 * расходятся: TS зовёт клип `text-clipping`/`TABLE_*` по имени фигуры, python —
 * своими кодами, а `TABLE_WORD_BREAK` живого пути на приёмке не появляется
 * вовсе. Сведение инспекторов в один — отдельная работа; пока верно только то,
 * что блокирующее правило у обоих одно.
 *
 * Правило:
 *
 *   · потеря целых блоков (`CONTENT_DROPPED_BY_RENDERER`) — блокер: отчёт с
 *     молча потерянными находками клиенту не выдаётся;
 *   · клипы — предупреждения, а не блок: клип означает «защита сработала»
 *     (карточке понижен кегль, предложение подрезано ножницами), а не «текст
 *     пропал» — пропавшее считается отдельно в `dropped*` и блокирует по
 *     правилу выше. На остальных текстовых путях `clipped` к тому же остаётся
 *     предсказанием консервативной меры (запас ×1,18 в `measure_text_height`),
 *     и блокировка по нему останавливала бы здоровые прогоны;
 *   · **исключение — страница комплаенс-раздела** (`COMPLIANCE_CARD_CLIPPED`):
 *     там обрезается не хвост предложения, а строка записи — карточки на
 *     странице базы или сводной таблицы, — а запись комплаенса печатный
 *     носитель правила «совпадение не подтверждается автоматически и уходит
 *     аналитику целиком». На стр. 69 живого отчёта так пропала строка «Также
 *     числится как», и прогон доехал до готового документа. Страница узнаётся
 *     по разделу слайда (его называет вызывающий, `compliancePages`), а не по
 *     номеру: номера двигает любая пересборка. Раздел неизвестен — правило
 *     прежнее, потому что сказать «это строка записи» на таком входе не может
 *     никто. Блокировать можно только то, у чего есть ёмкость: **обе** страницы
 *     раздела разбиваются на листы по своему потолку
 *     (`fragment-builders/compliance.ts`), иначе отказ был бы отказом без
 *     выхода — рендер детерминирован, и повтор дал бы тот же клип;
 *   · нет файла, файл не читается или список записей пуст — тоже блокер:
 *     на таком входе сказать «потерь нет» не может никто, а обязательные
 *     текстовые секции деки всегда дают записи (на эталоне их 41).
 */

import { join } from "node:path";
import {
  classifyLayoutTelemetryRows,
  readLayoutTelemetryRows,
  type LayoutTelemetryRow,
} from "../orion-golden/classic/generate-first36-geometry-artifacts";
import type { ReportDeckManifest } from "../orion-golden/deck-sections/contracts";
import type { CanonicalPrepareBlockerCode } from "./canonical-report-prepare";
import { LAYOUT_TELEMETRY_FILE } from "./render-deck-artifacts";

export type RenderTelemetryBlocker = Extract<
  CanonicalPrepareBlockerCode,
  "CONTENT_DROPPED_BY_RENDERER" | "RENDER_TELEMETRY_MISSING" | "COMPLIANCE_CARD_CLIPPED"
>;

/** Что судья знает о деке помимо телеметрии: пока — только её разделы. */
export type RenderTelemetryContext = {
  /**
   * Страницы комплаенс-раздела — по манифесту деки, а не по номеру из бандла.
   *
   * Пусто или не передано: раздел неизвестен, и клип судится общим правилом.
   */
  compliancePages?: Iterable<number>;
};

/** Стабильные токены `warnings` — для `job.warnings`: без времени и без дублей. */
export type RenderTelemetryVerdict =
  | { blocker: RenderTelemetryBlocker; detail: string; warnings: string[] }
  | { blocker: null; detail: null; warnings: string[] };

/**
 * Клип — «видно не всё»; `TABLE_WORD_BREAK` — «мера шрифта не сработала,
 * обрезка не доказана». Один префикс на оба врал бы про второе.
 */
const CLIP_CODES = new Set(["text-clipping", "TABLE_ROW_PARTIALLY_VISIBLE", "TABLE_STATUS_CLIPPED"]);

/**
 * Клипы таблицы: не влезла строка записи или её статус.
 *
 * Обрезана в обоих случаях ячейка записи, и разница только в том, какое поле не
 * влезло, — поэтому судятся они одинаково. `TABLE_STATUS_CLIPPED` сегодня живым
 * рендерером не производится вовсе: имена фигур телеметрии — закрытый набор
 * (`orion_text_body_pNN`, `orion_search_table_pNN`, `orion_risk_matrix_pNN`,
 * `orion_bullets_*_pNN`, `orion_footnote_dropped_pNN`), слова «status» в нём
 * нет, а классификатор ставит этот код именно по имени фигуры. Код оставлен,
 * потому что правило судит **словарь классификатора**, а не сегодняшние имена
 * фигур: исключить один из двух клипов таблицы значило бы объявить между ними
 * разницу по существу, которой нет.
 */
const TABLE_CLIP_CODES = new Set(["TABLE_ROW_PARTIALLY_VISIBLE", "TABLE_STATUS_CLIPPED"]);

/**
 * Страницы комплаенс-раздела — по манифесту деки.
 *
 * Раздел спрашивается у манифеста, а не выводится из номера страницы или имени
 * фигуры: номера двигает любая пересборка, а имя фигуры телеметрии называет
 * шаблон (`orion_search_table_pNN`), общий у страницы выдачи и у карточки
 * записи. Манифеста нет — списка нет, и клип судится общим правилом.
 *
 * Тип здесь настоящий (`ReportDeckManifest`), а не структурный слепок с
 * необязательными полями: такому слепку удовлетворяет любой объект, и
 * переименование `sectionType` или `pageNumber` в схеме прошло бы мимо
 * компилятора — функция молча вернула бы пустой список, а блокер перестал бы
 * существовать.
 */
export function compliancePagesOf(manifest: ReportDeckManifest | null): number[] {
  return (manifest?.slides ?? [])
    .filter((s) => String(s.sectionType).toUpperCase() === "COMPLIANCE")
    .map((s) => Number(s.pageNumber))
    .filter((p) => Number.isFinite(p) && p > 0);
}

/** По скольким страницам отказ печатает подробность классификатора. */
const DROP_DETAIL_PAGES = 3;

/** Имя блока страницы: по нему видно, какой шаблон переполнен. */
function blockNameOf(rows: LayoutTelemetryRow[], page: number): string {
  const row = rows.find(
    (r) =>
      Number((r as { page?: unknown }).page ?? 0) === page &&
      Number((r as { droppedBullets?: unknown }).droppedBullets ?? 0) +
        Number((r as { droppedLines?: unknown }).droppedLines ?? 0) >
        0
  );
  const name = String((row as { name?: unknown } | undefined)?.name ?? "").trim();
  return name || "—";
}

/** Судить телеметрию рендера, лежащую в каталоге его артефактов. */
export function judgeRenderTelemetry(
  renderDir: string,
  context: RenderTelemetryContext = {}
): RenderTelemetryVerdict {
  const path = join(renderDir, LAYOUT_TELEMETRY_FILE);
  const read = readLayoutTelemetryRows(path);
  if (!read.ok || read.rows.length === 0) {
    const reason = read.ok ? "список записей пуст" : read.detail;
    return {
      blocker: "RENDER_TELEMETRY_MISSING",
      detail:
        `телеметрия разметки непроверяема (${path}): ${reason} — ` +
        "потери рендерера осмотреть нечем",
      warnings: [],
    };
  }

  const issues = classifyLayoutTelemetryRows(read.rows);
  const dropped = issues.filter((i) => i.code === "CONTENT_DROPPED_BY_RENDERER");
  if (dropped.length > 0) {
    const pages = [...new Set(dropped.map((i) => i.page))].sort((a, b) => a - b);
    /*
     * Подробность классификатора доезжает до отказа.
     *
     * «Выбросил содержимое на страницах 62» не говорит ни что не поместилось,
     * ни насколько: блоки, строки и обе высоты классификатор уже посчитал, а
     * ворота их выбрасывали. Отказ, по которому нельзя действовать,
     * останавливает платный прогон на последнем шаге и ничего не сообщает —
     * прогон DPA-2026-0053 стоил из-за этого лишнего круга. Подробность даётся
     * по первым страницам: она нужна, чтобы понять причину, а не чтобы
     * перечислить документ.
     */
    const details = dropped
      .slice(0, DROP_DETAIL_PAGES)
      .map((i) => `стр. ${i.page} ${blockNameOf(read.rows, i.page)}: ${i.detail}`)
      .join("; ");
    const more = dropped.length > DROP_DETAIL_PAGES ? ` и ещё ${dropped.length - DROP_DETAIL_PAGES}` : "";
    return {
      blocker: "CONTENT_DROPPED_BY_RENDERER",
      detail:
        `рендерер выбросил содержимое на страницах ${pages.join(", ")} (${path}) — ` +
        `${details}${more}`,
      warnings: [],
    };
  }

  // Обрезанная строка записи комплаенса — единственный клип, который
  // останавливает выдачу. Прозаический клип (`text-clipping`) остаётся
  // предупреждением и тут: это вводный абзац страницы, а не строка записи.
  const compliancePages = new Set(context.compliancePages ?? []);
  const complianceClips = issues.filter(
    (i) => compliancePages.has(Number(i.page)) && TABLE_CLIP_CODES.has(String(i.code))
  );
  if (complianceClips.length > 0) {
    const pages = [...new Set(complianceClips.map((i) => i.page))].sort((a, b) => a - b);
    return {
      blocker: "COMPLIANCE_CARD_CLIPPED",
      detail:
        `строка записи комплаенса обрезана на страницах ${pages.join(", ")} (${path}) — ` +
        "совпадение по базе уходит аналитику целиком, обрезанная запись клиенту не выдаётся",
      warnings: [],
    };
  }

  return {
    blocker: null,
    detail: null,
    warnings: [
      ...new Set(
        issues.map(
          (i) =>
            `${CLIP_CODES.has(String(i.code)) ? "renderer-clip" : "renderer-layout"}:page=${i.page}:${i.code}`
        )
      ),
    ],
  };
}
