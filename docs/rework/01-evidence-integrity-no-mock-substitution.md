# Шаг 01. Целостность доказательств: запрет подмены реальной выдачи на mock

**Статус:** СДЕЛАНО (исправление внесено, проверено на прогоне)
**Файлы:** `src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts`,
`src/modules/digital-profile/agents/runtime-strategy.ts`,
`src/modules/digital-profile/services/base-collection-manifest.ts`
**Приоритет:** P0 — блокирует любую оценку качества отчёта.

---

## Проблема

Unified-сбор вызывал `runFullAudit(caseId, actorId)` без указания режима, из-за чего
применялся дефолт `FULL_AUDIT_DEFAULT_RUNTIME_MODE = "real_first_with_fallback"`
(`runtime-strategy.ts:15`). В этом режиме, если реальный агент не готов
(нет ключа, провайдер не сконфигурирован), выбирается **mock-агент**
(`runtime-strategy.ts:275-289`), и его синтетические результаты сохраняются в корпус
доказательств как обычные `SearchResult`.

Флаг `DIGITAL_PROFILE_MOCK_AGENTS=false` на это **не влиял** — он управляет другим
контуром, а не выбором fallback-агента внутри стратегии.

Второй, менее очевидный эффект: гейт достаточности
(`isRealCollectionSufficient`, `base-collection-manifest.ts:27-44`) считает прогон
негодным, если **хоть один** из `yandex / google / orion_profile` отработал в runtime
`mock`:

```ts
if (row.status === "failed") return false;
if (row.runtime === "mock" || row.runtime === "none") return false;
```

При этом отсутствующий или недоступный провайдер пропускается (`continue`), и для
успеха достаточно одного реального. То есть **честное «недоступен» проходит гейт, а
подмена на mock — нет**.

## Доказательство

Прогон по реальному публичному лицу, `DIGITAL_PROFILE_MOCK_AGENTS=false`,
Serper-ключ отсутствует.

Агенты (`dp_agent_runs`):

```
REAL_GOOGLE_SEARCH   FAILED     Serper rejected the request
GOOGLE_SEARCH        SUCCEEDED  itemsSaved=10      ← mock подменил реальный агент
```

Корпус доказательств (`dp_search_results`):

```
 real:YANDEX        | 29
 mock:GOOGLE_SEARCH | 20
```

То есть в дело о реальном человеке записаны **выдуманные результаты поиска**, а шаг
помечен «успешно».

Финал прогона:

```
stage: FAILED_TERMINAL
lastErrorCode: PRE_RENDER_DATA_GATE_FAILED
lastError: "real collection insufficient (mock/fallback cannot unlock REPORT_READY)"
```

Ни одного слайда не сгенерировано, хотя реально собрано 29 результатов Яндекса,
223 наблюдения Arsenkin и 2 статьи Wikipedia.

## Почему это влияет на качество слайдов

Двояко, и оба эффекта разрушительны:

1. **Загрязнение корпуса.** GPT-слой и детерминированные builder'ы получают смесь
   реальных и синтетических материалов. Модель не может отличить одно от другого и
   пишет обобщённо — конкретики в mock-строках нет по определению. Это прямой вклад
   в «ИИ-шный текст».
2. **Терминальный отказ вместо частичного отчёта.** Один недостающий ключ превращает
   валидный частичный сбор в ноль слайдов. Пользователь видит «пусто» там, где данных
   было достаточно на содержательный RU-раздел.

Отдельно это нарушает устав проекта, записанный в `README.md`: «Evidence-first.
Every statement in a report must reference evidence» и «LLM is not a source of truth».
Подмена выдачи синтетикой — источник несуществующих фактов о реальном человеке,
что для due-diligence продукта недопустимо в принципе.

## Решение

Внесено: unified-сбор при реальном режиме модуля запрашивает стратегию `real_only`.

```ts
// unified-orion-collection-orchestrator.ts, stepBaseCollection
const runFullAudit =
  deps.runFullAudit ??
  (async (caseId: string, actorId: string) => {
    const { runFullAudit: real } = await import("./agent-run-service");
    return real(caseId, { actorId }, {
      runtimeMode: digitalProfileConfig.mockAgents ? undefined : "real_only",
    });
  });
```

Границы изменения выбраны сознательно:

- меняется **только** unified-контур (единственный живой путь генерации);
- поведение при `DIGITAL_PROFILE_MOCK_AGENTS=true` не тронуто — офлайновые смоки и
  демо-режим продолжают работать на mock;
- сигнатура инжектируемой зависимости `deps.runFullAudit` не изменилась, тесты с
  подменой не ломаются;
- сам `real_first_with_fallback` не удалён — он остаётся доступен для ручного
  запуска аудита через `/api/digital-profile/cases/[id]/audit/run`.

## Результат проверки

Повторный прогон на том же субъекте:

```
realCollectionSufficient: True          (было False → терминальный отказ)
yandex                   real  completed     28 результатов
wikipedia                real  completed
surfaces                 real  completed     18 поверхностей
google                   none  unavailable   честно, вместо mock
orion_profile            none  unavailable
orion_uae_international  none  unavailable
```

Ни одной строки `mock:*` в корпусе. Гейт пройден, прогон пошёл дальше.

## Критерий приёмки

- [x] `select source, count(*) from dp_search_results` не содержит `mock:%` на прогоне
      с `DIGITAL_PROFILE_MOCK_AGENTS=false`;
- [x] неподконфигуренный провайдер попадает в манифест как `runtime: none, status: unavailable`;
- [x] `realCollectionSufficient = true` при одном реальном успешном провайдере;
- [x] юнит-тест: `resolveRuntimeStrategy({mode:"real_only"})` не возвращает ни одного
      mock-агента — `tests/unit/acceptance-criteria-01-03.test.ts`, проверяется в
      худшем случае: демо-агенты доступны, реальные нет.

## Побочный эффект, требующий продуктового решения

В режиме `real_only` отвалились провайдеры `ai_profile` и `compliance` с причиной
«provider has no real implementation in real_only mode». Раньше их наполняли
mock-агенты (2 и 3 «находки»). Это означает, что **compliance-блок отчёта всегда был
синтетическим** — реального источника (LexisNexis / Dow Jones / World-Check) в проекте
не подключено, все три провайдера выключены и без ключей.

Варианты, требующие решения владельца продукта, вынесены в шаг 04:
подключить реальную подписку, наполнять блок ручным импортом, или честно показывать
раздел как «проверка не проводилась» вместо выдуманных совпадений.

## Риски

- **Отчёты станут заметно беднее до подключения Serper.** Это не регресс, а снятие
  иллюзии: раньше пустоту закрывала синтетика. Управляется шагом 04.
- **Существующие кейсы в БД содержат mock-строки** от прошлых прогонов. Перед
  сравнительными замерами их нужно либо пометить, либо считать на новых кейсах.
