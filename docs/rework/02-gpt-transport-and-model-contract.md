# Шаг 02. Транспорт GPT и контракт модели

**Статус:** СДЕЛАНО (исправление внесено, доступ к модели проверен)
**Файлы:** `src/modules/digital-profile/ai-analyst/openai-gpt55-analyst.ts`,
`src/modules/digital-profile/ai-analyst/service.ts`,
`src/modules/digital-profile/orion-golden/gpt/openai-json-client.ts`
**Приоритет:** P0 — без него GPT-слоя не существует, сколько бы промпты ни правили.

---

## Проблема

В проекте два независимых пути обращения к OpenAI:

| Путь | Endpoint | Где | Состояние |
|---|---|---|---|
| ORION GPT-слой (stage 1 + stage 2 копирайт слайдов) | `/v1/responses` | `orion-golden/gpt/openai-json-client.ts` | рабочий |
| AI-аналитик (клиентский нарратив) | `/v1/chat/completions` | `ai-analyst/openai-gpt55-analyst.ts` | **падал на каждом вызове** |

Второй путь отправлял `temperature: 0.1`. Все модели семейств `gpt-5*` и `o*` —
reasoning-модели, они принимают только значение по умолчанию. Ответ API:

```
HTTP 400
Unsupported value: 'temperature' does not support 0.1 with this model.
Only the default (1) value is supported.
```

Дальше по коду ошибка гасится наглухо:

1. `postChatCompletion` бросает `new Error("openai_http_400")` — **тело ответа с
   объяснением API отбрасывается**;
2. `generateOpenAiGpt55Narrative` классифицирует 400 как не-транзиентную ошибку
   (в списке транзиентных только timeout/abort/429/5xx) → ретрая нет;
3. `service.ts` ловит исключение и возвращает `status: "fallback"`,
   `generatedBy: "deterministic"`.

Наружу это выглядит как «AI включён, отчёт сгенерирован» — при том что модель не
вызывалась ни разу успешно.

## Доказательство

Проверка ключа заказчика напрямую (`/v1/models`): 123 модели, включая `gpt-5.5`,
`gpt-5.5-pro`, `gpt-5.4`, `gpt-5.6-*`. Доступ есть.

Воспроизведение обоих путей тем же ключом:

```
[A] /v1/responses  reasoning=low  max_output_tokens=12000
    → ok  status=completed  output_tokens=110  валидный JSON  5.3 c

[B] /v1/responses  max_output_tokens=1200
    → ok  status=completed  валидный JSON

[C] /v1/chat/completions  temperature=0.1        ← путь AI-аналитика
    → 400  "Unsupported value: 'temperature' does not support 0.1 with this model"
```

Настройка окружения при этом полностью корректна:
`DIGITAL_PROFILE_AI_ANALYST_ENABLED=true`, `DIGITAL_PROFILE_AI_ANALYST_MODEL=gpt-5.5`,
ключ валиден. Диагностика молчала.

## Почему это влияет на качество слайдов

Прямо и полностью: клиентский аналитический нарратив — тот самый связный текст,
который отличает отчёт аналитика от таблицы — **никогда не генерировался моделью**.
Вместо него подставлялся `buildDeterministicAiAnalystNarrative` — шаблон с
подстановкой чисел.

Это объясняет обе половины жалобы одновременно: там, где шаблон был проработан,
текст выглядит «ИИ-шным» (безличные обороты, отсутствие конкретики); там, где
шаблону нечего подставить, текста нет вовсе.

Важное следствие для планирования: **все предыдущие итерации правки промптов
AI-аналитика были бесполезны** — промпт не доезжал до модели. Любые выводы о
«качестве GPT» до этого исправления недействительны.

## Решение

Внесено:

```ts
/** gpt-5 и o-series — reasoning-модели: sampling-параметры фиксированы. */
function isReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

body: JSON.stringify({
  model,
  ...(isReasoningModel(model) ? {} : { temperature: 0.1 }),
  max_completion_tokens: options.maxOutputTokens,
  response_format: { type: "json_object" },
  messages: [...],
})
```

Плюс диагностика — причина отказа API больше не теряется:

```ts
if (!res.ok) {
  const detail = await res.text().then(t => t.slice(0, 300).replace(/\s+/g, " ").trim());
  console.warn(`[digital-profile][ai-analyst] OpenAI ${res.status} for model "${model}": ${detail}`);
  throw new Error(`openai_http_${res.status}`);
}
```

Хелпер `isReasoningModel` намеренно продублирован из `openai-json-client.ts`, а не
вынесен в общий модуль: два пути к OpenAI живут в разных слоях, и связывать их
общей зависимостью до объединения (см. «Дальнейшая работа») смысла нет.

## Критерий приёмки

- [x] прямой вызов `gpt-5.5` обоими путями возвращает валидный JSON;
- [x] `temperature` не отправляется для reasoning-моделей;
- [x] причина HTTP-отказа попадает в лог без утечки ключа;
- [ ] на полном прогоне `status` AI-аналитика равен `ready`, а не `fallback`
      (проверяется артефактом прогона, см. шаг 07);
- [x] юнит-тест: тело запроса для `gpt-5.5` не содержит `temperature`, для
      `gpt-4o` — содержит. Тело вынесено в `chatCompletionRequestBody`, чтобы
      инвариант проверялся, а не пересказывался комментарием.

## Дальнейшая работа (вне этого шага)

1. **Фоллбек обязан быть заметен.** Сейчас переход на детерминированный текст —
   штатная тихая ветка. Нужен явный сигнал в `job.warnings` и в панели качества:
   «клиентский нарратив сгенерирован шаблоном, причина: X». Иначе следующая поломка
   транспорта опять будет невидимой месяцами.
2. **Два пути к OpenAI стоит свести к одному.** Разные endpoint'ы, разные схемы
   ошибок, разные политики ретраев и разные представления о модели — источник
   рассинхронизации. Кандидат — оставить `/v1/responses` с очередью из
   `gpt-call-queue.ts` и перевести AI-аналитика на него.
3. **Проверка доступности модели при старте.** Одноразовый лёгкий запрос при
   инициализации с записью результата в health-эндпоинт: сейчас неверное имя модели
   в env обнаруживается только по пустому отчёту.
