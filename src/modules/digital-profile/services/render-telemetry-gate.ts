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
 *   · нет файла, файл не читается или список записей пуст — тоже блокер:
 *     на таком входе сказать «потерь нет» не может никто, а обязательные
 *     текстовые секции деки всегда дают записи (на эталоне их 41).
 */

import { join } from "node:path";
import {
  classifyLayoutTelemetryRows,
  readLayoutTelemetryRows,
} from "../orion-golden/classic/generate-first36-geometry-artifacts";
import type { CanonicalPrepareBlockerCode } from "./canonical-report-prepare";
import { LAYOUT_TELEMETRY_FILE } from "./render-deck-artifacts";

export type RenderTelemetryBlocker = Extract<
  CanonicalPrepareBlockerCode,
  "CONTENT_DROPPED_BY_RENDERER" | "RENDER_TELEMETRY_MISSING"
>;

/** Стабильные токены `warnings` — для `job.warnings`: без времени и без дублей. */
export type RenderTelemetryVerdict =
  | { blocker: RenderTelemetryBlocker; detail: string; warnings: string[] }
  | { blocker: null; detail: null; warnings: string[] };

/**
 * Клип — «видно не всё»; `TABLE_WORD_BREAK` — «мера шрифта не сработала,
 * обрезка не доказана». Один префикс на оба врал бы про второе.
 */
const CLIP_CODES = new Set(["text-clipping", "TABLE_ROW_PARTIALLY_VISIBLE", "TABLE_STATUS_CLIPPED"]);

/** Судить телеметрию рендера, лежащую в каталоге его артефактов. */
export function judgeRenderTelemetry(renderDir: string): RenderTelemetryVerdict {
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
    return {
      blocker: "CONTENT_DROPPED_BY_RENDERER",
      detail: `рендерер выбросил содержимое на страницах ${pages.join(", ")} (${path})`,
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
