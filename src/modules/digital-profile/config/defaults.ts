/**
 * Значения по умолчанию для настроек, которые не являются секретами.
 *
 * Правило продукта: **в переменных окружения живут только секреты**. Всё
 * остальное — включатели провайдеров, выбор стратегии, пределы и адреса —
 * имеет в коде такое значение, при котором продукт работает целиком. Проект
 * поддерживают разные люди, и требовать от них помнить набор флагов значит
 * заранее согласиться на молча выключенные источники: ровно это и случилось на
 * стенде, где не хватало `GOOGLE_EXTERNAL_SERP_PROVIDER`.
 *
 * Включать провайдеров по умолчанию безопасно, потому что разрешением служит
 * ключ, а не флаг: без ключа провайдер отдаёт `NOT_CONFIGURED` с названной
 * причиной и в сеть не ходит. Флаг сам по себе ничего не открывает и ничего
 * не тратит.
 *
 * Модуль существует, чтобы значение было записано **один раз**. Прежде те же
 * решения принимались и в конфигурации, и в проверке окружения по отдельности,
 * а расходящиеся ответы на один вопрос — главный источник дефектов этого
 * проекта.
 */

/** Настройки-переключатели: имя переменной → значение при её отсутствии. */
export const BOOLEAN_DEFAULTS = {
  /** Модуль включён; выключать его целиком нужно разве что при отладке. */
  DIGITAL_PROFILE_ENABLED: true,
  /** Незакрытая админка — открытый доступ к делам клиентов. */
  DIGITAL_PROFILE_AUTH_ENABLED: true,
  /** Общий рубильник платных SERP-провайдеров. */
  DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED: true,
  DIGITAL_PROFILE_GOOGLE_ENABLED: true,
  DIGITAL_PROFILE_GOOGLE_REAL_ENABLED: true,
  DIGITAL_PROFILE_YANDEX_ENABLED: true,
  DIGITAL_PROFILE_YANDEX_REAL_ENABLED: true,
  DIGITAL_PROFILE_WIKIPEDIA_ENABLED: true,
  /** Пять агентов обогащения; разрешение — `ARSENKIN_API_TOKEN`. */
  ARSENKIN_ENABLED: true,
  /** Без него клиентский текст вырождается в шаблон. */
  DIGITAL_PROFILE_AI_ANALYST_ENABLED: true,
  /** Текущий формат отчёта. */
  DIGITAL_PROFILE_ORION_GOLDEN_ENABLED: true,
  /**
   * Единственный работающий источник комплаенса: без него раздел санкций, PEP
   * и розыска остаётся пустым. Разрешение — адрес и ключ: облачный сервис
   * отвечает по своему адресу, самостоятельно поднятый `yente` — по своему, а
   * ключ обязателен ровно тогда, когда адрес равен облачному умолчанию. Без
   * ключа облако получало ФИО, дату рождения и гражданство субъекта и отвечало
   * 401 — теперь такой источник объявляется ненастроенным до сети.
   */
  OPEN_SANCTIONS_ENABLED: true,
  /** Разбирает очередь ручной проверки сам, не оставляя работу человеку. */
  ORION_GPT_AUTO_ANALYST: true,
  /**
   * Стадия 1.5 над пакетами секций: модель планирует композицию деки. Без
   * слоя GPT у сборки стадия не выполняется вовсе, поэтому разрешением служит
   * ключ OpenAI, а не это значение.
   */
  ORION_GPT_DECK_COMPOSER: true,
  /** Стадия 3: редактор деки. Разрешение — тот же ключ, а не флаг. */
  ORION_GPT_DECK_EDITOR: true,
  /** Демо-агенты: рабочий продукт собирает отчёт настоящими источниками. */
  DIGITAL_PROFILE_MOCK_AGENTS: false,
} as const;

/** Настройки-значения: имя переменной → значение при её отсутствии. */
export const STRING_DEFAULTS = {
  /** Стратегия похода в Google. Прежде было `disabled`, и ключ не помогал. */
  GOOGLE_SEARCH_PROVIDER: "external_serp",
  /** Единственная реализованная в этой сборке внешняя выдача. */
  GOOGLE_EXTERNAL_SERP_PROVIDER: "serper",
} as const;

export type BooleanSettingName = keyof typeof BOOLEAN_DEFAULTS;
export type StringSettingName = keyof typeof STRING_DEFAULTS;

type EnvLike = Record<string, string | undefined>;

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/**
 * Прочитать переключатель с учётом значения по умолчанию.
 *
 * Непонятое значение читается как значение по умолчанию, а не как «выключено»:
 * опечатка в настройке не должна тихо отключать источник.
 */
export function boolSetting(
  name: BooleanSettingName,
  env: EnvLike = process.env
): boolean {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (TRUE_WORDS.includes(raw)) return true;
  if (FALSE_WORDS.includes(raw)) return false;
  return BOOLEAN_DEFAULTS[name];
}

/** Прочитать значение с учётом значения по умолчанию. */
export function stringSetting(
  name: StringSettingName,
  env: EnvLike = process.env
): string {
  const raw = String(env[name] ?? "").trim();
  return raw.length > 0 ? raw.toLowerCase() : STRING_DEFAULTS[name];
}
