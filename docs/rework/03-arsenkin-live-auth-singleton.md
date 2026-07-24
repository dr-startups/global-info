# Шаг 03. Глобальный синглтон авторизации Arsenkin

**Статус:** ЧАСТИЧНО — симптом купирован и проверен, корневая причина остаётся
**Файлы:** `src/modules/digital-profile/providers/arsenkin/live-execution-authorization.ts`,
`src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts`,
`src/modules/digital-profile/services/arsenkin-enrichment-tick.ts`
**Приоритет:** P0 для симптома (сделано), P1 для корня (блокирует параллельные кейсы).

---

## Проблема

Авторизация платных вызовов Arsenkin хранится в **переменных уровня модуля**:

```ts
// live-execution-authorization.ts
let active: ActiveLiveSession | null = null;
let activePoll: ExistingExternalTaskPollAuthorization | null = null;
```

`withExistingExternalTaskPollAuthorization` отказывается работать, пока открыта
live-сессия отправки задач:

```ts
if (active) {
  throw new Error("arsenkin-poll-auth-blocked:live-session-active");
}
```

Замысел понятен и правилен по духу — не дать poll'у выполниться внутри платной
`/set`-сессии, чтобы бюджеты оставались честными. Реализация же делает **весь
процесс однопоточным по отношению к Arsenkin**: пока один из пяти агентов
отправляет задачи, durable-поллер любого другого агента получает отказ.

Дальше отказ попадал в общий бюджет поллинга джобы
(`MAX_ARSENKIN_INGEST_POLL_ATTEMPTS = 40`), и джоба умирала.

## Доказательство

Прогон, где Arsenkin отработал **полностью успешно**. Состояние задач в БД:

```
check-top   DONE   30734784      check-top   DONE   30734787
suggest     DONE   30734796      suggest     DONE   30734799
suggest     DONE   30734800      paa         DONE   30734804
paa         DONE   30734813      ai-serp     DONE   30734817
ai-serp     DONE   30734818      ai-serp     DONE   30734827
indexation  DONE   30734839      check-h     DONE   30734857
```

Все 13 задач — `DONE`, ни одной ошибки провайдера. Итог джобы:

```
stage: FAILED_RETRYABLE
lastErrorCode: ARSENKIN_POLL_ATTEMPTS_EXCEEDED
lastError: "Arsenkin durable poll exceeded 40 attempts"
```

Артефакт последней ошибки поллинга:

```json
{
  "errorCode": "ARSENKIN_POLL_AUTH_BLOCKED",
  "message": "arsenkin-poll-auth-blocked:live-session-active",
  "pollAttempt": 40
}
```

Формулировка диагноза: **сбор данных прошёл на 100 %, а джоба провалилась
исключительно из-за конкуренции с самой собой**. Дважды подряд, воспроизводимо.

## Почему это влияет на качество слайдов

Косвенно, но фатально: до этапа генерации текста дело просто не доходит.
Оператор видит красный статус и «отчёт не готов». В проде, где кейсов несколько и
они идут параллельно в одном процессе, вероятность коллизии растёт линейно с
нагрузкой — то есть система деградирует ровно тогда, когда её начинают использовать.

## Что сделано (симптом)

Тик, у которого **все** ошибки поллинга — это внутренняя блокировка, не тратит
попытку из бюджета: до Arsenkin запрос не дошёл, значит и попыткой это не является.

```ts
// unified-orion-collection-orchestrator.ts
export function isPollAuthContentionOnly(warnings: readonly string[]): boolean {
  let blocked = false;
  for (const w of warnings) {
    if (w.startsWith(`${POLL_AUTH_BLOCKED_CODE}:`)) { blocked = true; continue; }
    // Любая другая диагностика поллинга означает, что тик делал реальную работу.
    if (/^ARSENKIN_POLL_(?!AUTH_BLOCKED)/.test(w) || w.startsWith("httpStatus:")) return false;
  }
  return blocked;
}
```

и в ветке ожидания:

```ts
pollAttempt: isPollAuthContentionOnly(tick.warnings)
  ? Math.max(0, Number(job.pollAttempt ?? 0) - 1)
  : Math.max(0, Number(job.pollAttempt ?? 0)),
```

Fail-closed семантика сохранена: любая настоящая ошибка провайдера (HTTP, схема,
таймаут) по-прежнему расходует бюджет и в пределе валит джобу.

**Результат проверки:** на следующем прогоне сбор дожил до конца — все 5 агентов,
223 наблюдения; `check-h` потребовал 45 попыток поллинга на уровне задачи, тогда как
раньше джоба умирала на 40-й. Бюджет джобы при этом держался на 3–13 попытках.

## Что осталось (корень)

Симптом купирован, но контенция никуда не делась: на текущем прогоне одна задача
`suggest` сожгла 8 попыток на блокировке, `check-top` — 34. Это лишний трафик,
лишняя задержка и мина под параллельный запуск.

**Предлагаемое решение — убрать процессное состояние.** Авторизация должна
передаваться явным аргументом по стеку вызовов, а не жить в переменной модуля:

1. `LiveExecutionAuthorization` и `ExistingExternalTaskPollAuthorization`
   становятся частью контекста, который `ArsenkinClient` получает при создании
   (или отдельным параметром метода);
2. `assertLiveSetAllowed` / `assertLiveNetworkAllowed` принимают контекст явно,
   а не читают глобаль;
3. взаимоисключение «poll не внутри set» проверяется **в пределах одной цепочки
   вызовов**, а не в пределах процесса;
4. бюджеты (`maxNewTasks`, `maxEstimatedLimits`) переезжают в запись джобы в БД —
   тогда они переживают рестарт и корректны при нескольких процессах.

Объём: затрагивает `live-execution-authorization.ts`, `client.ts`,
`execute-arsenkin-execution-plan.ts`, `arsenkin-enrichment-tick.ts` и их тесты.
Оценка — отдельная задача на 1–2 дня, делается независимо от Фазы B.

## Критерий приёмки

- [x] джоба не падает по `ARSENKIN_POLL_ATTEMPTS_EXCEEDED`, когда все задачи
      провайдера завершились успешно;
- [x] настоящие ошибки провайдера по-прежнему расходуют бюджет;
- [ ] `ARSENKIN_POLL_AUTH_BLOCKED` не встречается в артефактах прогона вообще
      (после устранения корня);
- [ ] два кейса, запущенных одновременно, не блокируют друг друга — интеграционный
      тест на двух джобах в одном процессе;
- [ ] юнит-тест на `isPollAuthContentionOnly`: смешанный набор предупреждений
      (блокировка + реальная ошибка) возвращает `false`.

## Риски

- Рефакторинг авторизации трогает контур **платных** вызовов. Любая ошибка здесь
  либо блокирует сбор, либо, что хуже, разрешает лишние платные задачи. Работать
  только с тестами на бюджеты; на живом токене — после прохождения офлайн-набора.
