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
  /**
   * Откуда берётся выдача: прежним путём или через Topvisor.
   *
   * Один ответ на вопрос для всего конвейера — органика, AI-ответы, подсказки
   * и частота переключаются вместе. Разрешением служит ключ, а не это
   * значение: режим `topvisor` без `TOPVISOR_API_KEY` и `TOPVISOR_USER_ID`
   * объявляет себя ненастроенным и **не откатывается** на прежний путь, иначе
   * на один вопрос было бы два ответа, и второй — невидимый.
   *
   * Умолчание описывает работающий продукт, поэтому пока сбор через Topvisor
   * собран не целиком, оно остаётся прежним; переключается одним коммитом,
   * когда путь закрыт целиком.
   */
  SERP_COLLECTION_PROVIDER: "legacy",
  /**
   * Поверхности подсказок, собираемые Topvisor: ключи регионов аудита через
   * запятую, пустая строка — не собирать вовсе.
   *
   * Умолчание описывает работающий продукт: в отчёте три поверхности подсказок
   * (RU Яндекс, RU Google, ОАЭ Google). **Topvisor собирает одну — Яндекс:**
   * подсказки Google по российским регионам он не отдаёт вовсе (живой прогон
   * 03.09.2026: «Russian regions not available for provider Google to Collect
   * keywords»), а по Дубаю вернул ноль строк. Подсказки Google обеих стран
   * собирает Arsenkin (`arsenkinSuggestEngines`) — решение владельца 03.09.2026.
   * Заказывать у Topvisor Google-Дубай значило бы платить за второй источник
   * того же. **Цена названа здесь, потому что она и есть причина настройки:**
   * 0,90 ₽ за исходную фразу на поверхность.
   */
  TOPVISOR_SUGGEST_REGIONS: "yandex-moscow",
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
