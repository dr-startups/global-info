# 0076. Кнопка, поле и блок вопросов сайта — общими компонентами; мёртвые классы `site.css` убраны

План шага после этапа 5 сайта самопроверки. Поручение владельца 17.09.2026: перед правками внешнего вида
вынести кнопку, поле и блок вопросов в общие компоненты, записать отступление в раздел 5.5 ТЗ
(`global-info-site-tz-2026-09-11.md`) и убрать из `site.css` классы, которых код не использует.

## Задача и границы

Раздел 5.5 ТЗ называет 14 компонентов дизайн-системы. На этапе 4 из них сделаны шапка, подвал, степпер
(`WizardBand`) и прогресс (`MeterSegments`); кнопка, поле и блок вопросов остались разметкой, повторённой по
файлам. Правка вида таких элементов идёт в несколько мест, и одно легко пропустить — дефект вида «на один вопрос
два ответа».

Входит:

1. `components/Button.tsx` — `Button` (`<button>`) и `ButtonLink` (ссылка): классы `site-btn`, вариант, крупный
   размер, во всю ширину, стрелка, ожидание ответа. Все 24 места, где классы кнопки написаны в разметке,
   переходят на них; `RunButton` мастера и `CopyButton` рисуются через `Button`; `ArrowIcon` переезжает в
   `Button.tsx` — стрелка есть только у кнопок.
2. `components/Field.tsx` — `TextField` и `FieldError`. `TextField` уезжает из `CheckForm.tsx`; заявка рисует
   через него имя и поля способа связи, а общую ошибку способа связи — через `FieldError`.
3. `components/Faq.tsx` — `Faq`: вопросы на главной, на `/voprosy` и в статьях.
4. Из `site.css` убираются классы, которых нет в коде сайта (42 по списку ниже), состояния-образцы экрана
   токенов макета (`.is-hover`, `.is-focus`, `.site-btn.is-active`) и токены, которые после этого никто не читает.
5. Тест-сторож: каждый класс `site-*` и `is-*` из `site.css` встречается в коде, а код не собирает имя класса
   из значения — собранного имени сторож не видит.
6. `docs/ENGINEERING.md` §9 «Страницы сайта» — компоненты и сторож; раздел 5.5 ТЗ — отступление (файл ТЗ вне
   репозитория).

Вне рамок: компоненты `Checkbox`, `Card`, `Notice`, `Container`, `Badge` из списка 5.5 — у каждого одно место в
разметке или ни одного, повтора нет; `textarea` заявки — одно место; скорость первой отрисовки (LCP) — этап 6:
удаление мёртвых классов уменьшает `site.css` на 3,7 %, заметного выигрыша не даст; тесты разметки компонентов
через рендер — vitest проекта не собирает TSX (`jsx: preserve`), и логика сайта тестируется вне React;
изменения вида — ни одного пикселя.

## Решения реализатора

- **Внешний вид и разметка не меняются.** Компоненты печатают ту же разметку, что стояла в местах вызова: тот
  же элемент, те же классы, те же атрибуты доступности. Разница допустима только в порядке атрибутов и классов.
- **Ссылка-якорь на той же странице — обычный `<a>`, остальные — `next/link`.** Закрывающий лист главной ведёт
  на `#form`, и форма ставит курсор в первое поле по событию `hashchange`; переход `Link` меняет адрес через
  `history.pushState`, и события бы не было. `ButtonLink` выбирает элемент по адресу: начинается с `#` — `<a>`.
- **Спиннер — у кнопки, которая ждёт ответа.** Передан `busy` (даже `false`) — в разметке спиннер и подпись в
  `<span>`, как у отправки формы, заявки и выбора карточки; иначе подпись — текстом, как у остальных кнопок.
  Разметка не меняется при смене `busy`: меняется только `aria-busy`, спиннер показывает CSS.
- **Классы вариантов — полными строками в таблице**, а не собираются из значения: тест-сторож и поиск по
  проекту видят каждое имя.
- **Ошибка поля бывает общей для группы.** У способа связи четыре поля, видно одно, и ошибка стоит после
  группы, чтобы не прыгать при переключении. `TextField` принимает ошибку строкой (печатает под полем) или
  `{ id }` — ссылается на ошибку, напечатанную `FieldError` снаружи.
- **Ответ вопроса — всегда через `RichText`.** На главной ответы — простой текст без разметки, и `RichText`
  печатает его тем же текстом.
- **Имя класса не собирается из значения.** `site-meter--${tone}`, `site-verdict--${tone}`,
  `site-status--${tone}` и `is-${tone}` строки ответов источников заменены таблицами
  `Record<тон, класс>` (`check/parts.tsx`): полное имя видят поиск и сторож, полноту таблицы проверяет
  TypeScript. Первая версия сторожа вместо этого перечисляла значения тонов сама — и разошлась с кодом:
  тон `off` панели персоны в списке не значился, правило `.site-ledger li.is-off .site-ledger__name` было
  удалено как мёртвое, и подпись строки «Панель знаний Google — не подключена» сменила цвет. Нашла это
  сверка снимков; правило возвращено. Мёртвое сочетание внутри живого селектора (`.site-btn.is-active`)
  сторож по-прежнему не видит — оно убрано вручную по чтению.

## Мёртвые классы

По коду `src/app` и `src/modules/site` без комментариев (скрипт — scratchpad шага, `dead-classes.mjs`):
`is-focus`, `is-hover`, `site-badge` и пять модификаторов, `site-btn--primary`, `site-code`,
`site-demo__subject`, `site-done`, `site-figure`, `site-figure--tint`, `site-figure__caption`,
`site-label__opt`, `site-muted`, `site-num`, `site-panel__count`, `site-panel__headrow`, `site-radius-demo`,
`site-run__clock`, `site-seek__name`, `site-select`, `site-small`, `site-space-demo`, `site-spec`,
`site-spec__label`, `site-spec__row`, `site-spinner--lg`, `site-stamp--sm`, `site-states`, `site-swatch`,
`site-swatch__color`, `site-swatch__meta`, `site-swatches`, `site-table`, `site-table-wrap`, `site-tag--accent`,
`site-tag--pill`, `site-text`, `site-verdict__title`. Большая часть — экран токенов макета (`#tokens`) и
варианты, которые экраны сайта не рисуют. Нужны будут — возвращаются из макета. Вместе с ними уходят
токены, которые после этого никто не читает (`--site-btn-bg`, `--site-btn-bg-hover`, `--site-btn-fg`,
`--site-accent-tint`, группа `--site-critical*`, `--site-accent-glow`) и два `@keyframes` без правил
(`site-rail-fill`, `site-node-pop`). Остаётся неиспользуемый `--site-s-1`: это первая ступень шкалы
отступов, и дыра в шкале хуже лишней строки.

## Контекст

- `src/modules/site/components/CheckForm.tsx:37-85` — `FieldError` и `TextField`; `:425-436` — отправка.
- `src/modules/site/components/check/LeadScreen.tsx:178-200` — имя, повтор `TextField`; `:223-252` — способ
  связи и общая ошибка; `:290-298` — кнопки.
- `src/modules/site/components/check/PersonaScreens.tsx:32-60` — `RunButton`.
- `src/modules/site/components/check/parts.tsx:130-134` — `BUTTON_CLASS` служебного экрана.
- `src/modules/site/components/check/CopyLink.tsx:48-68` — `CopyButton`.
- Кнопки разметкой: `ResultScreen.tsx:91-131`, `ThanksScreen.tsx:58`, `content/CtaBand.tsx:13`,
  `content/ServicePage.tsx:56`, `landing/ResultDemo.tsx:143`, `SiteHeader.tsx:244`, `src/app/not-found.tsx:32-39`,
  `(site)/uslugi/page.tsx:44-51`, `(site)/page.tsx:359`.
- Вопросы: `(site)/page.tsx:340-347`, `(site)/voprosy/page.tsx:34-43`, `content/Blocks.tsx:109-118`.
- `site.css:4046-4060` — анимация вопросов по `details:nth-child(N)`: `<details>` остаются прямыми детьми
  `.site-faq`.
- `tests/unit/site-birth-date-field-is-masked-and-sent-as-iso.test.ts:99-102` читает `CheckForm.tsx`: поле даты
  остаётся вызовом `TextField` в форме.

## Файлы

Новые: `src/modules/site/components/Button.tsx`, `Field.tsx`, `Faq.tsx`; тесты ниже.

Правятся: `CheckForm.tsx`, `check/LeadScreen.tsx`, `check/PersonaScreens.tsx`, `check/parts.tsx`,
`check/CopyLink.tsx`, `check/ResultScreen.tsx`, `check/ThanksScreen.tsx`, `content/CtaBand.tsx`,
`content/ServicePage.tsx`, `content/Blocks.tsx`, `landing/ResultDemo.tsx`, `SiteHeader.tsx`, `SiteIcons.tsx`,
`src/app/not-found.tsx`, `(site)/page.tsx`, `(site)/uslugi/page.tsx`, `(site)/voprosy/page.tsx`, `(site)/site.css`,
`docs/ENGINEERING.md` §9. Вне репозитория — раздел 5.5 ТЗ.

## Тесты

Пишутся до кода, падение — `red.log` в scratchpad.

1. `site-buttons-fields-and-faq-are-drawn-by-one-component.test.ts` — классы `site-btn*` встречаются только в
   `Button.tsx`, `site-input` и `site-error` — только в `Field.tsx`, `site-faq` — только в `Faq.tsx`; места,
   которые их рисуют, импортируют компоненты.
2. `site-css-declares-only-classes-the-site-uses.test.ts` — каждый класс `site-*` и `is-*` из `site.css` есть в
   коде сайта или в объявленном семействе; каждое объявленное семейство собирается в коде.

Мутационная проверка: кнопка разметкой в одном файле, `site-faq` вне `Faq.tsx`, повтор поля в заявке, мёртвый
класс в `site.css`, пропавшая сборка семейства.

## Проверка, что вид не изменился

Не юнит-тестами — разметку сайта vitest не рисует. Сборка `next build` до правки и после, `next start`,
Playwright с системным Chrome на 1440 и 390 px:

- DOM страниц и экранов мастера (ответы API подменены, база стенда не читается) — атрибуты и классы
  упорядочены, сравнение один в один;
- снимки тех же экранов — попиксельное сравнение;
- состояния, которые снимок страницы не показывает: ошибки формы и заявки, ожидание ответа у кнопки,
  наведение и фокус на кнопке.

Логи и снимки — scratchpad шага. Кроме того: `npm run typecheck`, `vitest`, офлайн-смоки, `next build`, `tsc` без
`next-env.d.ts` (так собирает CI).
