/**
 * Клиентская шкала риска — три ступени и единственное место схлопывания.
 *
 * В данных уровней четыре (`none/low/medium/high/critical` в контрактах,
 * `CRITICAL` в схеме): это порядок и пороги, и они остаются как были —
 * сортировки работают по уровню данных, поэтому бывший CRITICAL стоит первым
 * внутри «Высокого». Клиенту печатаются три ступени: низкий / средний /
 * высокий. Решение владельца: четвёртое слово шкалы в документе не стоит.
 *
 * Любое новое место, где уровень становится словом, тоном или делениями шкалы,
 * обязано импортировать этот модуль. Пока таблиц было девять, они расходились:
 * плашка резюме печатала «Повышенный риск» рядом с трёхсловными карточками
 * матрицы — две шкалы в одном документе.
 *
 * «Требует подтверждения» и «Нет данных» здесь отсутствуют намеренно: это
 * статусы идентификации и сбора, а не степень риска. Места на шкале они не
 * получают — в том числе визуального (делений шкалы степени они не рисуют).
 */

/** Ступень печати. Четвёртой нет. */
export type ClientRiskStep = "high" | "medium" | "low";

/** Строчное слово ступени — форма для предложения вывода и промптов. */
export type ClientRiskWord = "высокий" | "средний" | "низкий";

/** Тон бейджа: цвет карточки в рендерере. */
export type ClientRiskTone = "danger" | "warn" | "neutral";

/**
 * Слово для уровня, которого на шкале нет.
 *
 * Сырое эхо enum в клиентском поле («HIGH», `critical_risk`) — это не «почти
 * та же ступень», а неверный ответ: печатать его клиенту нельзя.
 */
export const RISK_STEP_UNKNOWN_LABEL = "Требует уточнения";

const UNKNOWN_TONE: ClientRiskTone = "warn";

type StepForms = {
  /** Бейдж карточки и ячейка колонки «Уровень». */
  label: string;
  /** Строчная форма для предложения. */
  word: ClientRiskWord;
  /** «Высокий уровень» — форма для гуманизации утёкшего токена. */
  levelLabel: string;
  tone: ClientRiskTone;
};

const STEPS: Record<ClientRiskStep, StepForms> = {
  high: { label: "Высокий", word: "высокий", levelLabel: "Высокий уровень", tone: "danger" },
  medium: { label: "Средний", word: "средний", levelLabel: "Средний уровень", tone: "warn" },
  low: { label: "Низкий", word: "низкий", levelLabel: "Низкий уровень", tone: "neutral" },
};

const STEP_BY_LABEL = new Map<string, ClientRiskStep>(
  (Object.keys(STEPS) as ClientRiskStep[]).map((step) => [STEPS[step].label, step])
);

/** Бейджи ступеней сверху вниз — легенда матрицы и словарь колонки «Уровень». */
export const CLIENT_RISK_LABELS = [
  STEPS.high.label,
  STEPS.medium.label,
  STEPS.low.label,
] as const;

/**
 * Уровень данных → ступень печати. Регистр не нормализуется: уровни контракта
 * строчные, а «HIGH» в клиентском поле означает утёкший enum.
 */
const STEP_BY_LEVEL: Record<string, ClientRiskStep> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
  // «Нет» отдельной ступенью не печатается: подтверждённая тема без негатива —
  // это низкий уровень внимания, а не пустая клетка.
  none: "low",
};

/** Вердикт аналитики → ступень печати. */
const STEP_BY_VERDICT: Record<string, ClientRiskStep> = {
  CRITICAL: "high",
  HIGH: "high",
  // ELEVATED теряет собственное слово «Повышенный»: нюанс вердикта живёт в
  // предложении вывода, а не во второй шкале рядом с карточками.
  ELEVATED: "high",
  MIXED: "medium",
  MEDIUM: "medium",
  LOW: "low",
};

/** Слова уровня в текстах, собранных до перехода на три ступени. */
const STEP_BY_LEGACY_WORD: Record<string, ClientRiskStep> = {
  критический: "high",
  высокий: "high",
  средний: "medium",
  низкий: "low",
};

/** Единственное место схлопывания: `critical|high → high`, `low|none → low`. */
export function clientRiskStep(level: string): ClientRiskStep | null {
  return STEP_BY_LEVEL[level] ?? null;
}

/** Бейдж карточки и ячейка колонки «Уровень». */
export function riskLabel(level: string): string {
  const step = clientRiskStep(level);
  return step ? STEPS[step].label : RISK_STEP_UNKNOWN_LABEL;
}

/** Строчное слово ступени для предложения. */
export function riskWord(level: string): string {
  const step = clientRiskStep(level);
  return step ? STEPS[step].word : RISK_STEP_UNKNOWN_LABEL.toLowerCase();
}

/** «Высокий уровень» — форма для санитайзера клиентского текста. */
export function riskLevelLabel(level: string): string {
  const step = clientRiskStep(level);
  return step ? STEPS[step].levelLabel : RISK_STEP_UNKNOWN_LABEL;
}

/**
 * Оборот об уровне внимания: «высокий уровень внимания».
 *
 * Собирается здесь, а не подстановкой слова в шаблон предложения: у ступени
 * слово прилагательное, а у неизвестного уровня — нет, и «требует уточнения
 * уровень внимания» уже не предложение.
 */
export function riskAttentionPhrase(level: string): string {
  const step = clientRiskStep(level);
  return step ? `${STEPS[step].word} уровень внимания` : "уровень внимания требует уточнения";
}

/** Тон бейджа по уровню данных. */
export function riskTone(level: string): ClientRiskTone {
  const step = clientRiskStep(level);
  return step ? STEPS[step].tone : UNKNOWN_TONE;
}

/**
 * Тон по уже напечатанному слову: строка матрицы несёт слово, а не уровень.
 *
 * Статусы («Требует подтверждения», «Нет данных») ступенью не являются и выше
 * `warn` не поднимаются — иначе непроверенный материал получил бы тон
 * подтверждённого риска.
 */
export function toneForRiskLabel(label: string): ClientRiskTone {
  const step = STEP_BY_LABEL.get(label);
  return step ? STEPS[step].tone : UNKNOWN_TONE;
}

/** Вердикт аналитики → ступень печати; `null` — вердикт вне шкалы. */
export function verdictRiskStep(verdict: string | null | undefined): ClientRiskStep | null {
  const key = String(verdict ?? "").trim().toUpperCase();
  return key ? (STEP_BY_VERDICT[key] ?? null) : null;
}

/**
 * Плашка «Итоговая оценка: …».
 *
 * `INSUFFICIENT_DATA` ступенью не становится: «недостаточно данных» — это не
 * «низкий риск», и подменять одно другим значит успокаивать читателя там, где
 * проверка не дала ответа.
 */
export function verdictClientLabel(verdict: string): string {
  const key = String(verdict).trim().toUpperCase();
  if (key === "INSUFFICIENT_DATA") return "Недостаточно данных";
  const step = STEP_BY_VERDICT[key];
  // Неизвестный вердикт сырым не печатается по тому же правилу, что и уровень:
  // «Итоговая оценка: UNKNOWN» — это утёкший enum, а не оценка.
  return step ? riskPlateLabel(step) : RISK_STEP_UNKNOWN_LABEL;
}

/** Слово уровня для предложения вывода и для полезной нагрузки модели. */
export function verdictRiskWord(verdict: string | null | undefined): ClientRiskWord | null {
  const step = verdictRiskStep(verdict);
  return step ? STEPS[step].word : null;
}

/** Плашка «Итоговая оценка: …» одной формы, откуда бы ступень ни пришла. */
function riskPlateLabel(step: ClientRiskStep): string {
  return `${STEPS[step].label} риск`;
}

/**
 * Слово уровня из текста, собранного до перехода на три ступени.
 *
 * Составное резюме лежит артефактом на диске кейса, и в нём стоит «критический»
 * — без приведения оно напечаталось бы как есть.
 */
export function collapseLegacyRiskWord(word: string): string {
  const step = STEP_BY_LEGACY_WORD[word.trim().toLowerCase()];
  return step ? STEPS[step].word : word;
}

/**
 * Плашка по слову уровня из старого текста; `null` — слова ступени в нём нет.
 *
 * Отдельно от `collapseLegacyRiskWord`, потому что вопросы разные: там — каким
 * словом заменить слово в тексте, здесь — что напечатать на плашке. Форма
 * плашки одна и та же, что и у вердикта, иначе путь без вердикта печатает
 * «Итоговая оценка: Высокий», а с вердиктом — «…: Высокий риск».
 */
export function legacyRiskWordPlate(word: string): string | null {
  const step = STEP_BY_LEGACY_WORD[word.trim().toLowerCase()];
  return step ? riskPlateLabel(step) : null;
}
