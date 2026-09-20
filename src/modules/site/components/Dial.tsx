/**
 * Показание дугой — общий предмет сайта: уровень риска на результате мастера, во
 * вложении к заявке, в шаге «Получите результат», в примере результата и в узле
 * схемы «Где мы ищем».
 *
 * Шкала та же, что в отчёте, — три ступени, — но согнута в дугу прибора: внутри
 * число материалов, снаружи риски, стрелка стоит против закрашенной ступени.
 * Дуги и стрелка заданы разметкой, а не собираются из чисел: путь дуги — это
 * геометрия макета, и считать её в браузере незачем.
 */

import { vars } from "./css-vars";

/** Три ступени шкалы: поле 240 × 134, центр 120 × 126, радиус 96. */
const ARCS = [
  "M24 126 A96 96 0 0 1 68.18 45.19",
  "M73.95 41.77 A96 96 0 0 1 166.05 41.77",
  "M171.82 45.19 A96 96 0 0 1 216 126",
] as const;

const TICKS = "M10 126.75 A110 110 0 0 1 230 126.75";
const POINTER = "M36 126l12-5v10z";

const SIZE_CLASS = { sm: "site-dial--sm", md: "site-dial--md" } as const;

/**
 * Тон уровня — классом на предке дуги: он задаёт `--v-color`, и один и тот же
 * цвет берут дуга, слово уровня и полоса темы. Полными именами, а не сборкой из
 * значения: имя класса находит и поиск, и сторож `site.css`.
 */
export const VERDICT_TONE_CLASS = {
  low: "site-verdict--low",
  medium: "site-verdict--medium",
  high: "site-verdict--high",
  none: "site-verdict--none",
} as const;

export function Dial({
  filled,
  pointerAngle,
  size,
  ghost,
  ticks,
  num,
  unit,
  labels,
  levelIndex,
  ariaLabel,
}: {
  filled: number;
  pointerAngle?: number | null;
  size?: keyof typeof SIZE_CLASS;
  /** Пустая дуга пунктиром: показания ещё нет или его не будет. */
  ghost?: boolean;
  ticks?: boolean;
  num?: string;
  unit?: string;
  labels?: readonly string[];
  levelIndex?: number;
  /** Нет подписи — дуга украшение, и диктор её не читает. */
  ariaLabel?: string;
}) {
  const className = ["site-dial", size ? SIZE_CLASS[size] : null, ghost ? "site-dial--ghost" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <svg viewBox="0 0 240 134" aria-hidden="true">
        {ticks ? <path className="site-dial__ticks" d={TICKS} /> : null}
        {ARCS.map((d) => (
          <path className="site-dial__track" d={d} key={d} />
        ))}
        {ARCS.slice(0, filled).map((d, i) => (
          <path className="site-dial__on" pathLength={1} style={vars({ "--i": i })} d={d} key={d} />
        ))}
        {pointerAngle === null || pointerAngle === undefined ? null : (
          <path className="site-dial__pointer" style={vars({ "--a": `${pointerAngle}deg` })} d={POINTER} />
        )}
      </svg>
      {num ? (
        <div className="site-dial__read" aria-hidden="true">
          <span className="site-dial__num">{num}</span>
          <span className="site-dial__unit">{unit}</span>
        </div>
      ) : null}
      {labels ? (
        <ol className="site-scale__labels" aria-hidden="true">
          {labels.map((label, i) => (
            <li key={label} className={i === levelIndex ? "is-level" : undefined}>
              {label}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
