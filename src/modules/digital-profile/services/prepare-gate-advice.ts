/**
 * Гейты подготовки отчёта: что они значат и что с ними делать (шаг 15, E1).
 *
 * На регрессионном прогоне подготовка упала с `MATERIAL_THEME_COVERAGE=87.5`,
 * прогон ушёл в `FAILED_TERMINAL` — и предложил кнопку восстановления. Нажатие
 * запустило бы ту же подготовку над тем же составным набором и получило бы тот
 * же результат: эти гейты вычисляются из собранных данных и от повтора не
 * меняются.
 *
 * Предлагать кнопку, которая не может помочь, — ровно та жалоба, с которой
 * начиналась переработка. Здесь решается, когда повтор бессмысленен, и что
 * сказать оператору вместо приглашения нажать.
 *
 * Модуль чистый: ни сети, ни БД.
 */

/**
 * Гейты, вычисляемые из состава данных.
 *
 * Каждый — чистая функция от составного набора: пока набор тот же, ответ тот же.
 * Сетевые и рендер-отказы сюда не входят — они как раз лечатся повтором.
 */
const DETERMINISTIC_GATES = [
  "MATERIAL_THEME_COVERAGE",
  "P1_P2_ACCOUNTED",
  "SEMANTIC_EXCERPT_TRUNCATIONS",
] as const;

export type DeterministicGate = (typeof DETERMINISTIC_GATES)[number];

/** Гейт, назвавший себя в сообщении об отказе; `null` — не гейт. */
export function deterministicGateOf(
  message: string | null | undefined
): DeterministicGate | null {
  const text = String(message ?? "");
  return DETERMINISTIC_GATES.find((g) => text.includes(`${g}=`)) ?? null;
}

export function isDeterministicPrepareGate(message: string | null | undefined): boolean {
  return deterministicGateOf(message) !== null;
}

/**
 * Что делать оператору вместо повтора.
 *
 * Совет обязан быть выполнимым: «повторите» здесь — неправда, а «обратитесь к
 * разработчику» — отписка. Поэтому называется конкретное действие, меняющее
 * входные данные.
 */
export function prepareGateAdvice(message: string | null | undefined): string | null {
  switch (deterministicGateOf(message)) {
    case "MATERIAL_THEME_COVERAGE":
      return (
        "Тема повышенного внимания осталась без материала, надёжно отнесённого к субъекту. " +
        "Повтор сборки это не изменит: нужно уточнить профиль субъекта — добавить контекст-слова " +
        "(компании, проекты, должности), чтобы спорные материалы получили однозначную привязку, " +
        "и пересобрать отчёт."
      );
    case "P1_P2_ACCOUNTED":
      return (
        "Часть существенных материалов не попала ни в одну тему и не отражена в резюме. " +
        "Повтор сборки это не изменит: разберите очередь ручной проверки и пересоберите отчёт."
      );
    case "SEMANTIC_EXCERPT_TRUNCATIONS":
      return (
        "Цитаты в резюме обрываются на середине мысли. Повтор сборки это не изменит: " +
        "нужна правка правил формирования цитат."
      );
    default:
      return null;
  }
}

/**
 * Сообщение об отказе для оператора: что произошло и что делать.
 *
 * Технический код гейта сохраняется — по нему ищут в диагностике, — но идёт
 * после человеческого объяснения, а не вместо него.
 */
export function prepareGateFailureMessage(message: string | null | undefined): string {
  const advice = prepareGateAdvice(message);
  const raw = String(message ?? "").trim();
  return advice ? `${advice} (${raw})` : raw;
}
