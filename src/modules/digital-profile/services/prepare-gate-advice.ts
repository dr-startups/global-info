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
  // Абзац не влез в лист и текст, выброшенный резаком абзацев: те же пакеты
  // секций дают тот же текст и ту же длину, поэтому второй заход подготовки
  // получит ровно тот же ответ — а стоит он четырёх стадий модели.
  //
  // Метит эти отказы `prepareBlockedErrorFor`, и только он: тот же код
  // `ASSEMBLY_QA_FAILED` выдают ворота сборки, а часть их проверок читает
  // текст модели, и там повтор законен. Признак стоит на отказе, а не на коде.
  "NARRATIVE_OVER_BUDGET",
  "NARRATIVE_REFLOW_LOSS",
  // Разбивка абзаца по листам, которая не может обойтись без потери знаков:
  // тот же абзац при том же бюджете разложится так же и упадёт так же.
  "NARRATIVE_SPLIT_LOSS",
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
 * Страницы, названные в тексте отказа.
 *
 * Оба отказа сборки печатают их первым словом каждого куска, разделяя куски
 * точкой с запятой: `<лист> [<шаблон>] 1013>998; <лист> …`. Оператору нужна
 * именно страница — по ней он находит место в отчёте.
 */
function pagesNamedIn(message: string): string[] {
  const body = message.slice(message.indexOf(":") + 1);
  return body
    .split(";")
    .map((part) => part.trim().split(/\s+/u)[0] ?? "")
    .filter((token) => /^[a-z0-9_]+$/iu.test(token));
}

/** «страница p13» или «страницы p13, p29» — без этого фраза не согласуется. */
function pagesPhrase(message: string | null | undefined): { subject: string; verb: string } {
  const pages = pagesNamedIn(String(message ?? ""));
  if (pages.length === 0) return { subject: "абзац страницы отчёта", verb: "не помещается" };
  if (pages.length === 1) return { subject: `абзац страницы ${pages[0]}`, verb: "не помещается" };
  return { subject: `абзацы страниц ${pages.join(", ")}`, verb: "не помещаются" };
}

/** Общий хвост совета: что цело и что делать дальше. */
const DATA_INTACT_TAIL =
  "Собранные данные целы, платить за сбор заново не нужно; " +
  "после исправления доступна кнопка «Пересобрать отчёт».";

/**
 * Что делать оператору вместо повтора.
 *
 * Совет обязан быть выполнимым: «повторите» здесь — неправда, а «обратитесь к
 * разработчику» — отписка. Поэтому называется конкретное действие, меняющее
 * входные данные.
 *
 * `default` здесь нет намеренно: `switch` исчерпывающий по `DeterministicGate`,
 * и имя, добавленное в список гейтов без ветки совета, **не скомпилируется**.
 * Иначе пропуск невидим ни компилятору, ни тесту, а оператор читает машинный
 * маркер первой строкой.
 */
export function prepareGateAdvice(message: string | null | undefined): string | null {
  const gate = deterministicGateOf(message);
  if (!gate) return null;
  switch (gate) {
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
    case "NARRATIVE_OVER_BUDGET": {
      const { subject, verb } = pagesPhrase(message);
      return `Отчёт не собрался: ${subject} ${verb} на лист. ${DATA_INTACT_TAIL}`;
    }
    case "NARRATIVE_SPLIT_LOSS": {
      const pages = pagesNamedIn(String(message ?? ""));
      const where = pages.length > 0 ? ` (${pages.join(", ")})` : "";
      return (
        `Отчёт не собрался: абзац страницы не удалось разложить по листам без ` +
        `потери текста${where}. ${DATA_INTACT_TAIL}`
      );
    }
    case "NARRATIVE_REFLOW_LOSS": {
      const pages = pagesNamedIn(String(message ?? ""));
      const where = pages.length > 0 ? ` (${pages.join(", ")})` : "";
      return (
        `Отчёт не собрался: при разбивке абзаца на страницы часть текста была бы ` +
        `потеряна${where}. ${DATA_INTACT_TAIL}`
      );
    }
  }
}

/**
 * Совет оператору, когда отказ повторился дословно.
 *
 * Гейта в таком отказе нет — детерминизм доказан не именем, а вторым
 * одинаковым ответом, — поэтому объяснение строится отдельно. Говорит оно то
 * же самое: повтор бессмысленен, данные целы, ждать нужно исправления.
 */
export function repeatedFailureAdvice(): string {
  return (
    "Сборка отчёта дважды подряд отказала одинаково — повтор без изменения кода " +
    `или данных даст то же. ${DATA_INTACT_TAIL}`
  );
}

/**
 * Сообщение об отказе для оператора: что произошло и что делать.
 *
 * Технический код гейта сохраняется — по нему ищут в диагностике, — но идёт
 * после человеческого объяснения, а не вместо него.
 *
 * Совет по гейту имеет приоритет над советом про повтор: гейт называет
 * конкретное действие («уточните профиль субъекта»), а повтор — только факт.
 * Столкнуться они не могут — гейт паркует с первой попытки, — но порядок
 * записан здесь, а не оставлен случаю.
 */
export function prepareGateFailureMessage(
  message: string | null | undefined,
  options: { repeated?: boolean } = {}
): string {
  const advice = prepareGateAdvice(message) ?? (options.repeated ? repeatedFailureAdvice() : null);
  const raw = String(message ?? "").trim();
  return advice ? `${advice} (${raw})` : raw;
}
