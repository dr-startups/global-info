import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DECK_BUILDER_FINGERPRINT,
  DECK_CONTENT_VERSION,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/content-version";

/**
 * Шаг 15, E13.
 *
 * Секции деки кэшируются, и ключ кэша включает `DECK_CONTENT_VERSION`. Механизм
 * рабочий, но версия задаётся руками: изменив построитель и забыв поднять
 * строку, разработчик получает деку со старым текстом. Хуже того, это же
 * получает оператор, нажавший «Пересобрать отчёт» после исправления, — и решает,
 * что исправление не работает.
 *
 * Этот тест делает забывчивость невозможной: он сверяет отпечаток исходников
 * построителей с записанным. Разошлись — значит, построители изменились и
 * версию надо поднять.
 */

const SECTIONS_DIR = join(
  process.cwd(),
  "src/modules/digital-profile/orion-golden/deck-sections"
);
const BUILDERS_DIR = join(SECTIONS_DIR, "fragment-builders");

/**
 * Файлы вне `fragment-builders/`, от которых тоже зависит содержимое страниц.
 *
 * `section-builders.ts` решает, какие данные вообще дойдут до построителя:
 * правка области фрагмента меняет отчёт ровно так же, как правка самого
 * построителя, но отпечаток её не замечал. Найдено на разборе: таблица
 * покрытия региона годами не получала поверхностей выдачи именно из-за
 * области, и починка прошла бы мимо проверки версии.
 *
 * `template-registry.ts` — по той же причине: в нём живут ёмкости страниц и
 * бюджеты знаков. Ёмкость матрицы 4 → 3 изменила раскладку карточек и
 * `contentHash` секции, а отпечаток не дрогнул — паки со старой раскладкой
 * приехали бы из кэша под новый рендерер.
 *
 * `continuation-slide.ts` — конструктор страницы-продолжения и формат её
 * подписи. Построители зовут его, но его собственная правка (скажем, другой
 * набор снимаемых заголовочных полей) изменила бы паки, не тронув ни одного
 * файла из списка выше.
 *
 * `../client/risk-scale.ts` — словарь клиентской шкалы риска: им написаны
 * бейджи карточек матрицы, легенда и плашка резюме. Файл лежит вне
 * `deck-sections/`, но решает, какими словами напечатан уровень, — правка в нём
 * меняет пакеты секций ровно так же, как правка построителя.
 *
 * `run-deck-build.ts`, `llm-slide-copy.ts`, `gpt-deck-composer.ts` и
 * `../gpt/client-payload-labels.ts` — по той же причине: первый решает тон
 * бейджа и склейку текста слайда, остальные три переписывают копию страниц
 * моделью и задают словарь, которым модель отвечает.
 *
 * `../../report/i18n/plural-ru.ts` — согласование существительного с числом.
 * Построители зовут его на каждой странице со счётом («7 материалов», «3
 * темы»), но файл лежал вне отпечатка: правка склонения не сдвинула бы
 * отпечаток, подсказка не сработала бы, и пересборка отдала бы кэш со старой
 * формулировкой.
 *
 * `measured-bullet-fit.ts` и `deck-assembler.ts` — состав страниц. Пакеты они
 * не меняют, но ключ кэша сторожит не только пакеты: по совпадению версии
 * «Повторить рендер» переиспользует **готовую деку**, и дека, разложенная
 * прежней перекладкой, приехала бы под новый рендерер как своя.
 */
const EXTRA_SOURCES = [
  "section-builders.ts",
  "canonical-slots.ts",
  "continuation-cleanup.ts",
  "continuation-slide.ts",
  "deck-assembler.ts",
  "measured-bullet-fit.ts",
  "template-registry.ts",
  "../client/risk-scale.ts",
  "run-deck-build.ts",
  "llm-slide-copy.ts",
  "gpt-deck-composer.ts",
  "../gpt/client-payload-labels.ts",
  "../../report/i18n/plural-ru.ts",
];

/** Исходники, из которых считается отпечаток, — в порядке хеширования. */
function fingerprintSources(): Array<{ name: string; path: string }> {
  return [
    ...readdirSync(BUILDERS_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((name) => ({ name, path: join(BUILDERS_DIR, name) })),
    ...[...EXTRA_SOURCES].sort().map((name) => ({ name, path: join(SECTIONS_DIR, name) })),
  ];
}

/**
 * Отпечаток исходников построителей: имя файла + содержимое, в порядке имён.
 *
 * Чтение отдаётся параметром, чтобы проверка «правка такого-то файла двигает
 * отпечаток» была настоящей: подменённое содержимое обязано менять результат.
 */
function fingerprintBuilders(read: (path: string) => Buffer | string = readFileSync): string {
  const h = createHash("sha256");
  for (const { name, path } of fingerprintSources()) {
    h.update(name);
    h.update(read(path));
  }
  return h.digest("hex").slice(0, 16);
}

/** Что делать при расхождении: правило и его исключение. */
function mismatchHint(actual: string): string {
  return [
    "Построители секций изменились, а версия содержимого — нет.",
    "Кэш секций держится на этой строке: без подъёма правка не дойдёт",
    "ни до новой деки, ни до кнопки «Пересобрать отчёт».",
    "",
    `Сделайте два шага в content-version.ts:`,
    `  DECK_CONTENT_VERSION   = "${bumped(DECK_CONTENT_VERSION)}"`,
    `  DECK_BUILDER_FINGERPRINT = "${actual}"`,
    "",
    "Исключение — один шаг. Отпечаток снят с файлов целиком, а в них живёт не",
    "только содержимое страниц (скажем, цикл «сборка → мера → перекладка» в",
    "run-deck-build.ts). Если ваша правка заведомо не может изменить ни одну",
    "собранную деку — затронутая ветка исполняется только там, где деки нет, —",
    "обновите один отпечаток, а версию оставьте: подъём инвалидировал бы все",
    "готовые пакеты и заставил бы «Пересобрать отчёт» строить заново то же",
    "самое. Исключение объявляется в ревью; условие — в комментарии к",
    "DECK_BUILDER_FINGERPRINT.",
  ].join("\n");
}

describe("версия содержимого деки не отстаёт от построителей", () => {
  it("отпечаток совпадает с записанным", () => {
    const actual = fingerprintBuilders();
    expect(actual, mismatchHint(actual)).toBe(DECK_BUILDER_FINGERPRINT);
  });

  it("подсказка о расхождении называет и правило, и исключение", () => {
    /*
     * Правило («изменил построитель — подними версию») верно почти всегда, но
     * отпечаток снят с файлов целиком, а в некоторых из них живёт не только
     * содержимое страниц. Правка, которая заведомо не может изменить ни одну
     * собранную деку, версию не двигает — подъём инвалидировал бы все готовые
     * пакеты. Пока подсказка молчала об этом, следующий инженер либо поднимал
     * версию зря, либо читал стоящую на месте версию при подвинутом отпечатке
     * как баг.
     */
    const hint = mismatchHint("0123456789abcdef");
    expect(hint).toContain(`DECK_CONTENT_VERSION   = "${bumped(DECK_CONTENT_VERSION)}"`);
    expect(hint).toContain('DECK_BUILDER_FINGERPRINT = "0123456789abcdef"');
    expect(hint).toMatch(/Исключение/u);
    expect(hint).toMatch(/не может изменить ни одну\s+собранную деку/u);
    expect(hint).toMatch(/версию оставьте/u);
  });

  it("правка реестра шаблонов двигает отпечаток", () => {
    // Реестр — часть содержимого страниц, а не настройка сборки: в нём живут
    // ёмкости страниц и бюджеты знаков. Ёмкость матрицы 4 → 3 изменила
    // раскладку карточек и `contentHash` секции, а отпечаток остался прежним —
    // паки со старой раскладкой приехали бы из кэша под новый рендерер.
    const registry = join(SECTIONS_DIR, "template-registry.ts");
    const patched = fingerprintBuilders((path) =>
      path === registry ? `${readFileSync(path, "utf8")}\n// правка` : readFileSync(path)
    );
    expect(patched).not.toBe(fingerprintBuilders());
  });

  it.each([
    ["клиентской шкалы риска", "../client/risk-scale.ts"],
    ["сборки полезной нагрузки рендерера", "run-deck-build.ts"],
    ["подмены копии слайдов моделью", "llm-slide-copy.ts"],
    ["сборки деки моделью", "gpt-deck-composer.ts"],
    ["словаря нагрузки модели", "../gpt/client-payload-labels.ts"],
    ["склонения существительных", "../../report/i18n/plural-ru.ts"],
  ])("правка %s двигает отпечаток", (_what, file) => {
    // Все они решают, каким словом и каким тоном напечатано содержимое
    // страницы. Файл вне отпечатка — правка приезжает из кэша прежней.
    const target = join(SECTIONS_DIR, file);
    const patched = fingerprintBuilders((path) =>
      path === target ? `${readFileSync(path, "utf8")}\n// правка` : readFileSync(path)
    );
    expect(patched).not.toBe(fingerprintBuilders());
  });

  it("версия названа так, как её ждёт кэш", () => {
    expect(DECK_CONTENT_VERSION).toMatch(/^deck-sections-v\d+$/u);
  });

  it("подсказка о следующей версии считается верно", () => {
    expect(bumped("deck-sections-v39")).toBe("deck-sections-v40");
    expect(bumped("deck-sections-v9")).toBe("deck-sections-v10");
  });
});

/** Следующий номер версии — чтобы подсказка была готовой к вставке. */
function bumped(version: string): string {
  return version.replace(/(\d+)$/u, (n) => String(Number(n) + 1));
}
