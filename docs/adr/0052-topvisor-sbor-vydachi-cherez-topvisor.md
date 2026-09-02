# Шаг 0052. Сбор выдачи через Topvisor

План написан на Fable 03.09.2026 в ветке `feature/topvisor` (от `feature/kostyannew`, `9864d82e`).
Решения владельца от 02.09.2026 и факты из официальной OpenAPI-схемы Topvisor — в описи, раздел
«Сбор выдачи через Topvisor»; здесь они не повторяются, здесь — как это ложится в код.
Реализация — на Opus, шагами T0–T5, каждый со своим красным логом, мутациями и коммитом.

## Задача и границы

Собирать ТОП-20 Яндекса и Google (Россия и ОАЭ), AI-ответы поиска (Алиса в поиске, Google AI
Overview), подсказки и частоту запросов через Topvisor. Старый путь не вырезается: один
переключатель, и при `legacy` прогон идёт байт в байт как сегодня.

**Вне рамок, по решениям владельца:** AI-трекер Topvisor (чат-модели без веб-поиска — не
наблюдение); PAA остаётся у Arsenkin; картинки, видео, связанные, панель знаний остаются у
Serper; сгенерированный скриншот выдачи не меняется; «Магнит» не нужен.

**Вне рамок по инженерным причинам:** отдельный сервис-воркер, S3, схема Prisma (ниже показано,
что новых колонок не нужно).

## Контекст: куда это ложится

Сегодняшний сбор устроен так, и план опирается ровно на эти точки:

- **Органика** собирается сервисом `services/orion-search-profile-service.ts` (агент
  `REAL_ORION_SEARCH_PROFILE`): цикл по плану запросов (`search-surfaces/orion-query-plan.ts`,
  назначения `subject_lookup`, `business_lookup`, `adverse_lookup`, `media_lookup`) зовёт
  `yandexSearchProvider.search` и `externalGoogleSerpProvider.search`, глубину даёт
  `organicSearchDepth` (`providers/search-depth.ts`, `SERP_AUDIT_DEPTH = 20`), строки пишутся в
  `dp_search_results` (`persistOrganicResults`, `source: real:YANDEX|real:GOOGLE`, `rank`,
  `rawMetadata.depthAudit`). Поверхности Serper (`serperAllSurfacesForQuery`,
  `serperAutocomplete`) → `dp_search_surface_items`.
- **Дублирующие агенты** `REAL_YANDEX_SEARCH`/`REAL_GOOGLE_SEARCH` (`agents/registry.ts`,
  `agents/runtime-strategy.ts:CAPABILITY_PAIRS`) собирают ту же органику второй раз и пишут
  строки без записанного запроса — измерено в 0045 (70 из 1039 наблюдений прогона 92). Владелец
  решил выключать их в режиме `topvisor` этой же работой. Их отсутствие должно пережить оценку
  `REQUIRED_COLLECTION_PROVIDERS = ["yandex","google","orion_profile"]`
  (`services/base-collection-manifest.ts:28`): выключенный составом провайдер — не «упавший».
- **Нейро-ответ Яндекса** — `services/yandex-gen-answer-collection.ts`, один вызов на прогон из
  `stepBaseCollection` (`unified-orion-collection-orchestrator.ts:1008`), строки `AI_ANSWER` в
  `dp_search_surface_items`, исход в `manifest.yandexGenAnswerProbe`. **AI Overview Google** —
  `answerBoxItem` в `providers/serper-surfaces.ts:109`.
- **Arsenkin** — пять агентов (`ARSENKIN_REAL_AGENT_NAMES`), состав инструментов
  `providers/arsenkin/flags.ts` (`DEFAULT_TOOLS = ["check-top","suggest","paa"]`), агент вне
  состава отвечает `DISABLED` с причиной «Инструменты агента … не входят в ARSENKIN_TOOLS»
  (`real-arsenkin-agents.ts:76`). Внешние задачи живут в `dp_provider_tasks` (`ProviderTask`:
  `provider`, `toolName`, `externalTaskId`, `state`, `nextPollAt`, `requestJson`,
  `responseJson`), опрашиваются воркером (`providers/arsenkin/poll-worker.ts`), результаты —
  `dp_serp_observations` со ссылкой на задачу, ожидание — `MAX_ENRICHMENT_WAIT_MS` (час) в шаге
  `ARSENKIN_ENRICHMENT` конвейера (`workflow/step-plan.ts:UNIFIED_PIPELINE`).
- **Слияние** (`services/composite-serp-merge.ts`): базовые строки несут `providers:
  ["yandex"|"serper"]`, строки задач — `providers: ["arsenkin"]`; шкалу номеров выбирает
  `rankInOneScale` (`isEngine = /yandex|serper|google/i`), а деке принадлежность номера
  движку говорит `rankSourceBelongsToEngine` (`fragment-builders/serp.ts:410`,
  `ENGINE_RANK_SOURCE: YANDEX /yandex/i, GOOGLE /serper|google/i`).
- **Готовность на старте** — `config/env-validation.ts:describeCapabilityReadiness`: каждый
  сборщик печатает «готов» или недостающую переменную; правило «выключить сборщик может только
  отсутствующий секрет» закреплено тестом.
- **Офлайн-контур**: `NETWORK_CALLS=0` читается в тике обогащения и оркестраторе; у Arsenkin свой
  счётчик `providers/arsenkin/network-guard.ts`.

## Решение

### Переключатель — одно значение в `config/defaults.ts`

`STRING_DEFAULTS.SERP_COLLECTION_PROVIDER: "topvisor" | "legacy"`. В этой ветке значение по
умолчанию — `topvisor`; в `feature/kostyannew` его не существует, то есть там `legacy` по
построению. Читается одним предикатом `serpCollectionMode()` в `providers/config.ts`, и все
ветвления ниже спрашивают только его. Переопределение переменной окружения — операционный рычаг
на один деплой с названной причиной, не способ вести продукт (§5 ENGINEERING); вернуться к
старому пути навсегда — значит поменять значение по умолчанию одним коммитом.

**Разрешение — ключ, а не флаг.** Секреты: `TOPVISOR_API_KEY`, `TOPVISOR_USER_ID`. Режим
`topvisor` без них — `NOT_CONFIGURED` с названной переменной на старте
(`describeCapabilityReadiness`) и в манифесте прогона; **тихого отката на `legacy` нет** — иначе
на один вопрос «откуда выдача» два ответа, и второй незаметен.

### Topvisor — второй провайдер задач, а не второй клиент внутри агента

Проверка позиций у Topvisor асинхронна и идёт минуты: запуск (`edit/positions_2/checker/go`),
опрос `status_positions_percent` в `get/projects_2/projects`, чтение снимков. Ждать это внутри
синхронного агента базового сбора значило бы держать ожидание в памяти процесса — ровно то,
против чего доктрина «расписание — в базе»: деплой посреди проверки потерял бы оплаченную
работу. У проекта уже есть долговечная машина ожидания внешних задач — `ProviderTask` +
поллер + `MAX_ENRICHMENT_WAIT_MS`, — и она провайдеро-агностична по данным (`provider`,
`toolName`, `externalTaskId`, `nextPollAt`). Поэтому:

- Topvisor живёт в `providers/topvisor/` как **провайдер задач**: `client.ts` (POST JSON,
  заголовки `User-Id` и `Authorization: bearer`, лимит 5 одновременных — своя лиза как у
  Arsenkin `account-rate-limit`), `project.ts` (проект на кейс), `adapters/positions.ts`
  (запуск проверки → задача; чтение `get/snapshots_2/history` и `get/positions_2/history` →
  черновики наблюдений), `adapters/collect.ts` (подсказки), `adapters/volumes.ts` (частота),
  `network-guard.ts` — **общий** с Arsenkin: счётчик и запрет `NETWORK_CALLS=0` переезжают в
  `providers/network-guard.ts`, Arsenkin читает оттуда же (один вопрос — «можно ли в сеть»).
- Задачи Topvisor подаются и опрашиваются **в шаге `ARSENKIN_ENRICHMENT`** тем же тиком, что и
  Arsenkin, с `provider: "topvisor"` и `toolName ∈ {positions, collect, volumes}`. Новый шаг
  конвейера не заводится: вставка шага раньше `REPORT_PREPARE` рассинхронизирует пары стадий
  (опись, `:1782`), а смысл шага — «ждём внешние задачи» — тот же. Признак завершённости
  обогащения (`enrichmentComplete`, `ingestedAgents`) должен учитывать задачи обоих провайдеров;
  это первое место, где нужен замер, а не вера: тест «Arsenkin готов, Topvisor ещё нет — шаг
  ждёт».
- Результаты — `dp_serp_observations` со ссылкой на задачу, `providers:
  ["topvisor-yandex"|"topvisor-google"]`. **Имя провайдера несёт движок** намеренно: и
  `rankInOneScale.isEngine`, и `ENGINE_RANK_SOURCE` узнают «yandex»/«google» подстрокой, и
  позиционные таблицы возьмут номера Topvisor без правки этих двух мест. Альтернатива —
  провайдер `topvisor` плюс третье поле «движок номера» — второй ответ на вопрос «чей это ранг».
  В `composite-serp-merge.ts` ветка строк из задач перестаёт хардкодить `"arsenkin"` и читает
  провайдера из задачи; для организки Topvisor `primaryProvider` — сам Topvisor (базовых
  `yandex`/`serper` в этом режиме нет).

### Что делает базовый сбор в режиме `topvisor`

- `orion-search-profile-service.ts`: цикл органики по запросам **не зовёт** Yandex/Serper —
  вместо этого набор запросов (те же `OrionQuerySpec` назначений `subject/business/adverse/
  media`, RU-набор и UAE-набор) уходит в проект Topvisor (`keywords import`, ключевые слова —
  тексты запросов, папки по региону). Статусы региона: `yandexStatus/googleStatus =
  "DELEGATED"` — новое значение `RegionCollectionStatus`, чтобы страница покрытия не печатала
  «не собрано» о том, что собрано другим путём.
- Поверхности Serper: `images`, `videos`, `relatedQueries`, `knowledgePanel` — как сегодня;
  `serperAutocomplete` в этом режиме **не зовётся** (подсказки — Topvisor), `answerBox` не
  читается (AI Overview — Topvisor).
- `runtime-strategy.ts`: пары `yandex`/`google` фазы `collection` в режиме `topvisor` дают
  `DISABLED` с причиной «органика собирается Topvisor» — то же слово, каким Arsenkin объявляет
  инструмент вне состава. `base-collection-manifest.ts`: провайдер, выключенный составом, не
  входит в `failedProviders` и не ломает `realCollectionSufficient`; **обязательным** в этом
  режиме становится `topvisor` (задачи `positions` дошли до `MEASURED` хотя бы для одного
  региона) — это проверяет ворота готовности данных, а не базовый манифест.
- `collectYandexGenAnswer` не зовётся; `manifest.yandexGenAnswerProbe` получает исход
  `SKIPPED_DELEGATED` — с названной причиной, а не отсутствием записи.
- Arsenkin: `flags.ts` — состав по умолчанию в режиме `topvisor` = `["paa"]`; агенты `check-top`
  и `suggest` отвечают `DISABLED` штатной фразой. Ключ Arsenkin по-прежнему нужен для PAA.

### Проект Topvisor — состояние в API, а не в нашей базе

Один проект на кейс, имя `orion-<caseId>` (без ФИО в имени — проект виден в кабинете
Topvisor), `url` — служебный. Перед созданием — поиск по имени через `get/projects_2/projects`;
идентификатор проекта и дата проверки уносятся в `requestJson`/`responseJson` задачи и в бандл
диагностики. Новых колонок в `Case`/`UnifiedCollectionJobRecord` не нужно: «состояние — это
данные», и эти данные уже есть у задачи. Регионы: Яндекс — Москва (`region_key 213`,
`region_device 0`), Google — Москва и ОАЭ ключами из `get/system_2/common/regions` (снять в
пилоте; ключи Google у Topvisor не совпадают с Arsenkin). Глубина: Google `region_depth 2`
(ТОП-20); Яндекс — по умолчанию (ТОП-100/50), снимок читается `depthPositions: 20`.

### AI-ответы, подсказки, частота

- **AI-ответы**: в настройках проекта включить сбор AI-сниппетов один раз
  (`edit/positions_2/settings`); после проверки `get/positions_2/history` с полями
  `sf_ai_oveview_body`, `sf_ai_oveview_links` → строки `ai_answer` (`contentKind: answer_text` /
  `answer_source`) по образцу `yandex-gen-answer-collection.ts`, движок — из региона. Хранятся у
  Topvisor месяц и перезаписываются — читать в том же тике, что и снимки, и класть в бандл.
  Пилот обязан ответить, пишется ли Алиса в то же поле; если нет — Яндекс остаётся на
  `/v2/gen/search` и это называется в §8.
- **Подсказки**: `add/projects_2/tasks/keywords/collect`, `searcher_key 100` (Яндекс) / `101`
  (Google), `hint_depth 1`, `region_key` региона; результат — задача `collect`, строки
  `autocomplete`. Где оседают собранные фразы (папка проекта или задача без проекта, живущая 24
  часа) — решает пилот; они **не должны** попасть в набор для проверки позиций.
- **Частота**: `add/projects_2/tasks/volumes`, Wordstat «фраза» (в кавычках — общая частота
  считала бы всех однофамильцев), регион — открытый вопрос 3; результат — задача `volumes`,
  строки нового вида `frequency` (`query`, `volume`, `region`, `period`) в `dp_serp_observations`.
  Клиентский блок — T4.

### Что видит клиент и что не меняется

Позиционные таблицы, лиды выдачи, страницы AI-ответов и подсказок — те же построители, данные
приходят теми же полями. **Подпись источника** в лидах (`fragment-builders/serp.ts:401`
«список Google — из Serper») становится словом из данных — `rankSource` — а не литералом: в
режиме `topvisor` клиент читает «выдача Topvisor», в `legacy` — прежнее. `DECK_CONTENT_VERSION`
поднимается в T1 (текст лида зависит от источника) и в T4 (новый блок).

### Отвергнуто

- **Синхронная проверка внутри агента базового сбора** (проще, один поток): ожидание в памяти
  процесса, деплой посреди проверки теряет оплаченное; при `maxWaitMs` базового шага в 30 минут
  проверка Topvisor может не уложиться.
- **Новый шаг конвейера `TOPVISOR_SERP`**: вставка шага раньше `REPORT_PREPARE` (опись `:1782`).
- **Провайдер `topvisor` без движка в имени** — второй ответ на «чей ранг».
- **Колонка `topvisorProjectId` в `Case`** — данные уже есть в задаче и в API; дубликат разъедется.
- **Строки Topvisor в `dp_search_results`** (как у базовых провайдеров): тогда ожидание должно
  быть синхронным (см. первый пункт), а ссылка на внешнюю задачу — нигде.

## Шаги

### T0. Пилот — платный, руками, по отдельному разрешению владельца на этот прогон

Скрипт `scripts/topvisor-pilot.ts` (офлайн-безопасен: без ключа печатает `NOT_CONFIGURED` и
выходит; с ключом — только по явному аргументу `--spend`): создать проект, импортировать 8
запросов Кремлёва (RU) и 4 (UAE), регионы Яндекс-Москва + Яндекс Live + Google-Москва +
Google-ОАЭ, включить AI-сниппеты, запустить проверку, ждать по `status_positions_percent`
(не дольше 30 минут), прочитать `snapshots_2/history` (`depthPositions 20`) и
`positions_2/history` (AI-поля), поставить задачи `collect` (100/101) и `volumes`, дождаться,
прочитать. **Все сырые ответы — файлами** в `providers/topvisor/fixtures/` (по одному на
вызов, ключ и `User-Id` вырезаны `redact`), плюс `pilot-report.md` в каталоге шага.

Отвечает на пять вопросов, и **T1 не начинается без ответов**: (1) пишется ли Алиса в
`sf_ai_oveview_*`; (2) сколько идёт проверка на 12 запросов × 4 региона; (3) совпадает ли
снимок обычного Яндекса с тем, что видит человек в браузере, и чем отличается Live (владелец:
нужны «первые 20 строк на сегодня»); (4) работают ли снимки и AI-сниппеты для Live; (5) где
оседают подсказки и частота, какие поля отдаёт `get/keywords`. Бюджет ≈ 10 ₽; без «да» владельца
на этот прогон скрипт не запускать.

### T1. Провайдер, проект, позиции, снимки, переключатель

- `config/defaults.ts` — `SERP_COLLECTION_PROVIDER`; `providers/config.ts` — `serpCollectionMode()`,
  чтение `TOPVISOR_API_KEY`/`TOPVISOR_USER_ID`, `getProviderAvailability("TOPVISOR")`.
- `providers/topvisor/{client,project,regions,redact,adapters/positions}.ts`, общий
  `providers/network-guard.ts`.
- Подача и опрос задач в тике обогащения (`arsenkin-enrichment-tick.ts` → обобщение под двух
  провайдеров; имя файла не менять, чтобы не плодить движение), ingest → `dp_serp_observations`
  с `providers: ["topvisor-<engine>"]`, покрытие поверхностей `organic` для обоих движков и
  регионов.
- `orion-search-profile-service.ts`: ветка режима (`DELEGATED`), `runtime-strategy.ts` и
  `base-collection-manifest.ts`: выключенные составом провайдеры.
- `composite-serp-merge.ts`: провайдер строки из задачи; `rankSource` из данных.
- Лид выдачи: подпись источника из `rankSource`; `DECK_CONTENT_VERSION` +1.
- `describeCapabilityReadiness`: строка «Topvisor (выдача Яндекс/Google)» с недостающей переменной.

### T2. AI-ответы

`adapters/positions.ts` читает AI-поля тем же вызовом; строки `ai_answer` в наблюдениях;
`collectYandexGenAnswer` и `answerBox` в режиме `topvisor` не зовутся; страницы AI-ответов
печатают источник из данных («Алиса в поиске, снимок Topvisor от <дата>»). Если пилот показал,
что Алиса в поле не пишется, — Яндекс остаётся на `/v2/gen/search`, и это записано.

### T3. Подсказки и состав Arsenkin

`adapters/collect.ts`, задача `collect` в тике, строки `autocomplete`; `flags.ts` — состав по
режиму; Arsenkin `suggest`/`check-top` → `DISABLED`; `serperAutocomplete` не зовётся; агенты
`REAL_YANDEX_SEARCH`/`REAL_GOOGLE_SEARCH` — `DISABLED` (T1 уже подготовил оценку манифеста).

### T4. Блок «Частота»

`adapters/volumes.ts`, задача `volumes`, строки `frequency`; в деке — строка на первой странице
(«Имя ищут N раз в месяц (Wordstat, «фраза», регион …)») и таблица по запросам в RU-разделе на
**существующем** шаблоне таблицы (новый шаблон = правка рендерера = окно деплоя; если не
обойтись — объявить окно). Клиентский текст, `client-text.baseline.json`, `DECK_CONTENT_VERSION`
+1, дифф эталона вслух.

### T5. Документ

`ENGINEERING.md`: §3 — `providers/topvisor`, §5 — две переменные и строка «источник выдачи»
в таблице «что решает код», §8 — раздел «Topvisor как провайдер задач»: почему задача, а не
агент; почему имя провайдера несёт движок; что месячное хранение AI-ответов значит для бандла;
цена прогона; окно деплоя (T1 меняет форму данных наблюдений — старый рендерер их не рисует
иначе, но приложение и воркер поднимаются по отдельности, и тик обогащения старой версии не
знает задач `topvisor`: в окне не запускать сборы).

## Что должно быть протестировано

Все фикстуры — сырые ответы пилота (T0), не пересказ документации. Офлайн целиком.

1. **Режим и разрешение.** `legacy` → ни одного вызова Topvisor, поведение прежнее (сторож:
   счётчик сети Topvisor равен нулю на офлайн-смоке `smoke-unified-orion-collection`).
   `topvisor` без ключа → `NOT_CONFIGURED` с именем переменной в readiness и в манифесте, и
   **без** вызовов Yandex/Serper органики (мутация «откат на legacy» красная).
2. **Клиент.** Заголовки, тело, лимит 5 одновременных (лиза), `redact` вырезает ключ и
   `User-Id` из всего, что пишется на диск; `NETWORK_CALLS=0` — исключение до сети.
3. **Проект.** Поиск по имени перед созданием; повторный прогон того же кейса не создаёт второй
   проект (фикстура `get/projects_2/projects` с уже существующим).
4. **Позиции.** Из фикстуры `snapshots_2/history` рождаются наблюдения `organic` с `rank` из
   ключа снимка, `engine` из региона, `query` из ключевого слова, `url/domain/title/snippet`;
   ровно 20 на запрос при `depthPositions 20`; регион ОАЭ → `UAE`. Ожидание: задача
   `positions` со `status_positions_percent < 100` → `waiting`, ≥ 100 → ingest; час без 100 →
   `STEP_WAIT_TIMEOUT` (тот же бюджет, что у Arsenkin).
5. **Слияние и номера.** Строки `topvisor-yandex`/`topvisor-google` попадают в свои таблицы:
   `rankSourceBelongsToEngine("topvisor-google","GOOGLE") === true`, для `YANDEX` — false;
   `rankInOneScale` берёт номер Topvisor; при наличии базового `yandex` (режим `legacy` +
   случайно живые задачи) базовый остаётся первичным — сторож на смешение режимов.
6. **Манифест.** Выключенные составом `yandex`/`google` не в `failedProviders`,
   `realCollectionSufficient` держится на `orion_profile` + `topvisor`; `yandexGenAnswerProbe =
   SKIPPED_DELEGATED`.
7. **AI-ответы.** Из фикстуры `positions_2/history` — строки `ai_answer` с `answer_text` и
   `answer_source` по числу ссылок; пустое поле → `absent` с причиной; `answerBox` и
   `/v2/gen/search` в режиме `topvisor` не зовутся (счётчики).
8. **Подсказки.** Задача `collect` 100/101 → строки `autocomplete` с движком; фразы не попадают в
   набор позиций; Arsenkin `suggest`/`check-top` → `DISABLED` с фразой состава.
9. **Частота.** Задача `volumes` → строки `frequency`; в деке строка первой страницы и таблица;
   ноль частот → страница называет причину («Wordstat не вернул чисел по N запросам»), а не молчит.
10. **Эталоны.** `report-72` и золотой кейс — режим `legacy` по фикстурам: **не двигаются** в
    T1–T3 кроме подписи источника (прочитать вслух); T4 двигает золотой кейс новым блоком —
    прочитать вслух.

Мутации, обязательные к красноте: снять предикат режима (Yandex зовётся при `topvisor`);
имя провайдера без движка; `enrichmentComplete` без задач Topvisor; `redact` не вырезает ключ;
Arsenkin `suggest` в составе при `topvisor`.

## Риски и что может сломаться молча

- **Пилот дороже сметы** — регионов четыре, а не два; смета ≈ 10 ₽, разрешение — на этот прогон.
- **Проверка не укладывается в час** — задача `positions` уходит в `STEP_WAIT_TIMEOUT`, прогон
  ждёт кнопки; пилот меряет длительность и, если нужно, бюджет ожидания меняется данными
  (`maxWaitMs`), а не догадкой.
- **Топвизор вернул меньше 20 строк** (Яндекс Live 50 фиксировано, обычный — по настройке):
  `depthAudit` наблюдений называет фактическую глубину; лид печатает «вернул N из 20» тем же
  предложением, что сегодня.
- **Два региона Google с одним ключевым словом** — `region_index` в ключе снимка; путать
  регионы нельзя, тест 4 держит.
- **Окно деплоя** — названо в T5; в окне сборы не запускать.
- **Ключ в артефактах** — `redact` на всём, что пишется; тест 2.

## Открытые вопросы владельцу

1. **Пилот** — разрешение на платный прогон ≈ 10 ₽ (12 запросов × 4 региона × ~0,19 ₽ +
   подсказки + частота). Без него T0 не стартует.
2. **Яндекс обычный или Live** — по итогам пилота: рекомендую тот, где снимок совпадает с
   браузером и работают AI-сниппеты; если оба совпадают — обычный (тот же API, что у нас, и
   глубина настраиваемая).
3. **Регион частоты** — Россия (`225`) или Москва (`213`)? Рекомендую Россию: клиента интересует
   интерес к имени в целом, Москва занижает.
4. **Подпись источника в лидах** — «по данным Topvisor» (рекомендую: клиент видит, откуда числа)
   или без названия сервиса («снимок выдачи от <дата>»)?

## Что переедет в ENGINEERING.md

См. T5. Плюс в опись — то, что пилот измерит и что решено не делать (Live vs обычный, длительность
проверки, где оседают подсказки).
