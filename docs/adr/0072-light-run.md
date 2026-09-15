# 0072 — Лёгкий прогон и вердикт самопроверки

Этап 3 сайта самопроверки: ТЗ `global-info-site-tz-2026-09-11.md`, раздел 7, «Этап 3». План
временный: при закрытии этапа нужное переезжает в `docs/ENGINEERING.md` §9, файл удаляется.

## Задача и границы

После решения по персоне посетитель нажимает «Проверить», и запускается лёгкий прогон: базовый
сбор → вердикт. Джоба доходит до `LIGHT_READY`, вердикт записывается в `dp_self_checks`, статус для
посетителя называет стадию словами и отдаёт результат.

В рамках:

1. Режим `mode: "full" | "light"` во входе старта и в джобе; план `LIGHT_PIPELINE`; стадии
   `LIGHT_VERDICT` и `LIGHT_READY` в типах, выводе стадии, сверке, подписях и бейджах.
2. Переход после базового сбора в `LIGHT_VERDICT`; сторож: лёгкая джоба не исполняет стадий
   полного конвейера, полная — стадий лёгкого.
3. Шаг `LIGHT_VERDICT` и чистая функция вердикта.
4. Риск-пробы по режиму; в лёгком режиме — без зарубежного контура.
5. Ручка `POST /api/self-check/[publicId]/run`.
6. Проекция статуса: `run`, `result`, отказ прогона.
7. Админка: `mode` в статусе, признак «лёгкий прогон», подписи стадий, пересборка отчёта и повтор
   GPT недоступны, вердикт в панели «Проверка с сайта», статус дела.
8. Переданное этапом 2: заявка только в `DONE`/`FAILED`/`BLOCKED`; тест заглушки `run` заменён.
9. Офлайн-смок лёгкого прогона.
10. ENGINEERING §9.

Вне рамок: страницы и тексты экранов (этап 4); обезличивание (этап 6); апгрейд лёгкого прогона в
полный и отсев тёзок (этап 7); бюджет повторов базового сбора (10 попыток, каждая — платный
`runFullAudit`) — поведение `main`, общее с админкой; живой прогон — только по разрешению владельца.
`DECK_CONTENT_VERSION` и эталоны не меняются.

## Решения владельца

Ответы на вопросы этапа, 15.09.2026:

| Вопрос | Решение | Следствие |
|---|---|---|
| Кто решает «негатив ли это», тему и уровень | Как в отчёте: `resolveRowAdverse`, каталог тем `config/finding-themes.ts`, `riskFor` | Отступление от ТЗ 3.7. Сводка аудита ставит `MEDIUM` любому без статьи Википедии (`calculations.ts:420-428`, находка «статьи нет» — `rules.ts:253`), и по ТЗ почти каждый посетитель получил бы «негатив найден» при нуле материалов |
| Шкала уровня | Три ступени `orion-golden/client/risk-scale.ts` | Шкала макета (4 деления) правится на этапе 4 |
| Стадии ожидания | Две: `collecting` (базовый сбор), `verdict` (шаг вердикта) | Третьей стадии нет данных: базовый сбор — один тик |
| Лимиты | Новых нет: суточного потолка нет, настройка `SELF_CHECK_DAILY_RUN_LIMIT` удаляется; лимит по IP на создание (этап 2) остаётся; на запуске лимит по IP не проверяется | Расход ограничивают лимит по адресу и рубильник — записывается в риски ТЗ |

Объявлены владельцу 15.09 как умолчания, возражений нет:

| Вопрос | Решение | Основание |
|---|---|---|
| Повтор после `FAILED` и `INSUFFICIENT_DATA` | Новая проверка: возврат по cookie такие проверки пропускает | Макет: «Запустить заново», «Повторить проверку» |
| Предел ожидания посетителя | 30 минут от запуска (`maxWaitMs` шага `BASE_COLLECTION`) → `FAILED`, причина `RUN_TIMEOUT`; поздний вердикт всё равно записывается | Одно число из реестра шагов, второго предела нет |
| Статус дела | `LIGHT_VERDICT` → `COLLECTING`, `LIGHT_READY` → `REVIEW` | Отчёта нет — `REPORT_READY` было бы неправдой |

## Контекст

- `workflow/step-plan.ts:39` — `UNIFIED_PIPELINE`, единственный реестр; `:92` `stepDefinition`;
  `:177` — все шаги сделаны → `REPORT_READY`.
- `workflow/step-store.ts:64` — `ensurePipelineSteps` материализует только `UNIFIED_PIPELINE`.
- `workflow/unified-step-handlers.ts:68` `outcomeForStoppedJob` знает конечные стадии полного
  прогона; `:97` позиция стадии — по `UNIFIED_PIPELINE`; `:331` реестр обработчиков.
- `services/unified-orion-collection-orchestrator.ts:592` старт; `:693` постановка шагов; `:852`
  диспетчер тика по стадии; `:1096` переход базового сбора в `ARSENKIN_ENRICHMENT`.
- **Опасное место:** `:204` `persistUnifiedTickFailure` любое исключение тика записывает как сбой
  опроса Arsenkin и ставит `stage: ARSENKIN_ENRICHMENT`. Для лёгкой джобы следующий тик ушёл бы в
  `stepArsenkin` — в платные отправки.
- `services/unified-collection-job-store.ts:65` — поля не из колонок живут в `payloadJson`: `mode`
  миграции джоб не требует; `:21` `ACTIVE_STAGES`.
- `services/agent-run-service.ts:375` `runFullAudit(caseId, ctx, { runtimeMode })`; `:159`
  `runAgent` строит `AgentContext` без опций — канала для риск-проб нет.
- `agents/real/real-orion-search-profile-agent.ts:55,116` зовут `runOrionSearchProfile` без опций;
  `:170` агент зарубежного контура передаёт регионы `UAE`, `INTERNATIONAL` явно, а
  `search-surfaces/orion-query-plan.ts:206` явные регионы ставит выше регионов дела. Предпосылка ТЗ
  3.4 «для RU зарубежный контур не запускается» в `main` не выполняется.
- `services/orion-search-profile-service.ts:623` — риск-пробы: опция или
  `ORION_INCLUDE_RISK_PROBES && allowsNegativeQueries`; `orion-query-plan.ts:404` — идентификатор
  плана уже различает `risk1`/`risk0`.
- Живой путь материалов отчёта (`services/canonical-report-prepare.ts:1270-1300`): наблюдения
  составного слияния → `compositeObservationsToInventory`, комплаенс →
  `resolveComplianceInventoryItems`, Википедия → `resolveEvidenceSupplement`.
  `buildFullEvidenceInventory` вызовов не имеет.
- `services/composite-serp-merge.ts:343` `mergeCompositeSerp` — без сети, по манифесту базового
  сбора; демо-строки отбрасывает (`isMockBaseRow`), адаптер комплаенса — тоже.
- `serp-observation/resolve-observation-highlights.ts:264` `resolveRowAdverse`;
  `orion-golden/analytics/item-adverse.ts` `resolveItemAdverse`;
  `orion-golden/analytics/finding-synthesizer.ts:738` `themesFor`, `:773` `riskFor` — не
  экспортированы. Файл в отпечаток деки не входит (`tests/unit/deck-content-version.test.ts`,
  `EXTRA_SOURCES`), экспорт `DECK_CONTENT_VERSION` не двигает.
- `config/finding-themes.ts:434-554` — каталог: у темы `baseRisk` и `accusing`; «Деловой профиль»
  — `baseRisk: "none"`.
- `self-check/status.ts:28` — заявка принимается и в `PERSONA_DECIDED`; `self-check/quotas.ts:73`
  возврат по cookie статуса не спрашивает; `self-check/public-dto.ts:153` `run`/`result` = `null`.
- `app/api/self-check/[publicId]/run/route.ts` — заглушка `503 NOT_IMPLEMENTED_YET`.

## Как делаем

### Конвейер

- `UnifiedCollectionMode = "full" | "light"`, поле `mode?` джобы; отсутствие — `full` (джобы до
  этапа). Один помощник `jobMode(job)`.
- `step-plan.ts`: шаг базового сбора — одна запись на оба плана; `LIGHT_PIPELINE = [BASE_COLLECTION,
  LIGHT_VERDICT (позиция 2, стадия LIGHT_VERDICT)]`; `pipelineFor(mode)`; `stepDefinition` ищет по
  обоим планам. `deriveJobStage`: все шаги сделаны, и среди них шаг лёгкого плана → `LIGHT_READY`.
- `ensurePipelineSteps({ mode })`, старт передаёт режим в джобу и в шаги.
- Обработчики: `LIGHT_VERDICT` в реестре; позиция стадии — по плану режима джобы;
  `LIGHT_READY` — конечная стадия «сделано».
- `ACTIVE_STAGES` + `LIGHT_VERDICT`; прогресс стадий `LIGHT_VERDICT` 0,5, `LIGHT_READY` 1.

### Сторож тика

- Диспетчер исполняет только стадии плана своего режима; чужая стадия — `FAILED_TERMINAL` с
  кодом `RUN_MODE_STAGE_REFUSED`, без вызова обработчика.
- `persistUnifiedTickFailure` для лёгкой джобы пишет `FAILED_RETRYABLE` с кодом ошибки и без
  контрольной точки Arsenkin; повтор шага вернёт стадию шага.

### Базовый сбор в лёгком режиме

- Переход после сбора — `LIGHT_VERDICT`; манифест, строка базового прогона и скрининг — как в
  полном.
- `runFullAudit(…, { runtimeMode, includeRiskProbes, skipProviders })`: риск-пробы —
  `riskProbesEnabled(mode)` (`providers/config.ts`: `mode === "light" || ORION_INCLUDE_RISK_PROBES`);
  пропуск провайдера `orion_uae_international` — только в лёгком режиме, в сводке он `skipped`.
- Проба доходит до агентов через `AgentContext.includeRiskProbes`; в сервисе профиля поиска —
  `(опция ?? настройка) && allowsNegativeQueries(субъект)`: основание обработки по-прежнему спрашивается.

### Вердикт

Чистая функция `self-check/verdict.ts` над материалами живого пути отчёта:

1. **Материалы:** наблюдения слияния манифеста без обогащения (`mergeCompositeSerp` →
   `compositeObservationsToInventory`), совпадения комплаенса, проверки Википедии — тем же набором
   функций, что у подготовки отчёта. Ключ материала — `serpMaterialKey`.
2. **`INSUFFICIENT_DATA`:** нет ни одного материала выдачи с адресом `http(s)` или ни один
   поисковый провайдер (`yandex`, `google`, `orion_profile`) не завершился не демо-агентом.
   Уровня нет, тем нет.
3. **Негатив материала:** `resolveItemAdverse` (без прочитанных страниц — список площадок и
   словарь конфига). Совпадение комплаенса с типом риска санкций, PEP, RCA или watchlist —
   негатив в теме каталога `pep_rca_watchlist` («Санкционные и PEP-списки»).
4. **Темы:** `themesFor` каталога; темы с `baseRisk: "none"` (деловой профиль) не показываются.
   Уровень темы — `riskFor(тема, негативных, всего)`. Показываются темы с негативом.
5. **`NEGATIVE_FOUND`** — есть хотя бы один негативный материал в показанной теме; иначе **`CLEAN`**,
   уровень `low`. Негативный материал без темы (в отчёте — «неотнесённые») вердикт не меняет.
6. `materialsFound` — различные негативные материалы показанных тем; `findingsTotal` — число
   показанных тем (в отчёте находка — тема); уровень проверки — наибольший уровень показанной
   темы; хранится уровнем данных, посетителю печатается ступенью `risk-scale.ts`.
7. `partial` — отказ или недоступность `yandex`, `google`, `orion_profile`,
   `orion_google_surfaces`, `wikipedia`, либо санкционный скрининг не выполнен
   (`resolveComplianceScreenings`). `sourcesChecked` — ответившие группы: `search`, `surfaces`
   (`orion_google_surfaces`), `open_sources`, `sanctions`. Агент `surfaces` в сеть не ходит и
   ни группы, ни неполноты не определяет.
8. Подписи тем — макет и приложение A (`criminal_legal` → «Суд и криминал», `financial_claims` →
   «Финансовые претензии и долги», `pep_rca_watchlist` → «Санкционные и PEP-списки», …); тема без
   подписи сайта печатается подписью каталога.

Шаг `LIGHT_VERDICT` (`stepLightVerdict`) собирает материалы, считает вердикт, пишет запись проверки
(`status: DONE`, поля вердикта, `sourcesJson`, `runFinishedAt`, `verdictSource: light-verdict-v1`)
условно — из `RUNNING` или из `FAILED` с причиной `RUN_TIMEOUT` — и аудит `SELF_CHECK_VERDICT`.
Записи нет — вердикт только в аудите. Джоба → `LIGHT_READY`, `COMPLETED`, `completeness: full`.
Сбой шага — `FAILED_RETRYABLE` (у шага 3 попытки, ожидание 5 минут).

**Миграция:** колонка `sourcesJson Json?` в `dp_self_checks` — какие группы источников ответили.
Результат не должен зависеть от джобы: полный прогон из админки заменяет строку джобы дела.

**Стенд:** демо-строки в материалы не попадают, как и в отчёте, поэтому демо-прогон на стенде
заканчивается `INSUFFICIENT_DATA`. Отступление от ТЗ 3.6 («вердикт по синтетическим находкам»);
`NEGATIVE_FOUND` и `CLEAN` закрепляются офлайн-тестами.

**Найдено приёмкой на стенде 15.09:** первая редакция правила дала на стенде `CLEAN` при нуле
настоящих материалов — демо-поисковики считались ответившими, а заметки агента поверхностей о
возможностях провайдеров (без адреса) проходили слияние как материалы выдачи. Правило уточнено
(пункты 2 и 7), случаи закреплены тестом вердикта; то же касалось бы продакшна, где агент
заметок работает рядом с настоящим сбором.

### Ручка `run`

`startSelfCheckRun`: ловушка/`BLOCKED` → `409 SELF_CHECK_BLOCKED`; `CREATED`/`PERSONA_PENDING` →
`409 PERSONA_NOT_CONFIRMED`; `RUNNING`/`DONE`/`FAILED` → `409 RUN_ALREADY_STARTED`. Захват —
условное обновление `PERSONA_DECIDED → RUNNING` с `runStartedAt` (второй запрос получает `409`).
`startUnifiedOrionCollection({ mode: "light", requestedBy: "self-check:<id>" })`; отказ ворот
персоны или старта возвращает запись в `PERSONA_DECIDED` и отдаёт отказ как есть. `jobId`, аудит
`SELF_CHECK_RUN_STARTED`, ответ `202 { status: "RUNNING", nextPollMs }`.

### Статус посетителя

- `RUNNING`: чистая функция `lightRunState` по джобе, шагам и времени: `BASE_COLLECTION` →
  `collecting`, `LIGHT_VERDICT`/`LIGHT_READY` → `verdict`; `FAILED_TERMINAL`, пауза, шаг без
  повтора, замена джобы → отказ `RUN_FAILED`; дольше предела → `RUN_TIMEOUT`. Отказ записывается
  условно `RUNNING → FAILED` при чтении статуса.
- `run`: `{ stage, stageLabel, progress, nextPollMs, startedAt }`, `nextPollMs` —
  `SELF_CHECK_POLL_INTERVAL_MS`.
- `result` при `DONE`: `{ verdict, riskLevel (ступень | null), materialsFound, findingsTotal,
  themes [{ id, label, count, level (ступень) }], partial, sourcesChecked, checkedAt }`.
- Кодов джобы, идентификаторов и стадий конвейера в проекции нет.

### Прочее

- `LEAD_ACCEPTING_STATUSES` = `DONE`, `FAILED`, `BLOCKED`.
- `isReusableCheck` пропускает `FAILED` и `DONE` с `INSUFFICIENT_DATA`.
- `SELF_CHECK_DAILY_RUN_LIMIT` удаляется из настроек, сводки старта и ENGINEERING.
- Админка: `mode` в `GET …/unified-collection`; пересборка и повтор GPT для лёгкой джобы — отказ с
  причиной `LIGHT_RUN_HAS_NO_REPORT` (в функциях допуска, а не в маршруте); подписи и тоны стадий;
  «лёгкий прогон» рядом со стадией; панель «Проверка с сайта» — материалы, темы, неполнота, источники.
- Статус дела: `LIGHT_VERDICT` → `COLLECTING`, `LIGHT_READY` → `REVIEW`.

## Тесты

Красный лог — до продакшн-кода, файлом в каталоге этапа. Новые:

- `light-pipeline-has-two-steps-and-ends-in-light-ready.test.ts`
- `light-run-moves-to-verdict-after-base-collection.test.ts`
- `light-run-never-schedules-arsenkin-gpt-or-render.test.ts`
- `self-check-verdict-follows-the-report-answers.test.ts` — вместо
  `…-is-derived-from-audit-summary` из ТЗ: правило вердикта сменилось решением владельца
- `risk-probes-follow-the-run-mode.test.ts` — и пропуск зарубежного контура
- `self-check-run-is-refused-without-persona-decision.test.ts`
- `self-check-run-is-refused-when-disabled.test.ts` — вместо `…-over-quota-or-when-disabled`:
  потолка нет
- `self-check-status-maps-stages-to-words.test.ts`
- `light-verdict-is-recorded-on-the-self-check.test.ts`

Правки существующих — называются в отчёте: заявка в `PERSONA_DECIDED` теперь отказ
(`self-check-lead-needs-at-least-one-contact`); заглушка `run` → настоящая ручка
(`self-check-routes-refuse-foreign-cookie`); без суточного лимита
(`self-check-settings-have-working-defaults`); возврат не к `FAILED`/`INSUFFICIENT_DATA`
(`self-check-dedupes-the-same-subject-within-window`); стадии лёгкого прогона
(`case-status-follows-run`); `run`/`result` проекции
(`self-check-public-status-hides-internal-diagnostics`); подмена `pipelineFor` рядом с подменой
реестра (`stage-position-follows-the-step-registry`).

Смок: `scripts/smoke-unified-orion-collection.ts` — лёгкий прогон на фикстурах доходит до
`LIGHT_READY`, обогащение и подготовка не вызываются.

## Мутационная проверка

Откатывается продакшн-правка, тест обязан покраснеть: сторож тика; ветка лёгкого режима в
`persistUnifiedTickFailure`; переход после базового сбора; `LIGHT_READY` в выводе стадии;
`riskProbesEnabled`; пропуск зарубежного контура; негатив материала; фильтр `baseRisk: none`;
правило `INSUFFICIENT_DATA`; совпадение комплаенса; условный захват запуска; возврат записи при
отказе старта; предел ожидания; список статусов заявки; пропуск `FAILED` при возврате; допуск
пересборки для лёгкой джобы.

## Проверки и приёмка

`npm run typecheck`, `npm test`, `npm run ci`, `npm run build`; миграция и `npm run db:audit` на
стенде; сквозной HTTP-сценарий на стенде в демо-режиме — скрипт `Анализ/accept-stage3.ps1`.
Артефакты — в каталоге этапа в scratchpad.
