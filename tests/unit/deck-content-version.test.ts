import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DECK_BUILDER_FINGERPRINT,
  DECK_CONTENT_VERSION,
  FINGERPRINT_TAKEN_AT_VERSION,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/content-version";
import {
  describeFingerprintProblem,
  nextContentVersion,
  recordedFingerprintSalt,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/content-version-guard";

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
 *
 * Шаг 0037/1, круг 2: у сторожа нашлись пути обхода, и каждый кончался зелёным
 * при неподвижном номере. Закрыты они механизмом, а не формулировкой: отпечаток
 * ветки исключения солится **причиной** (добытое значение не годится ни без
 * исключения, ни с другой причиной), номер сверяется с полом — номером, при
 * котором собраны пакеты эталона в дереве (понижение номера больше не выдаёт
 * отпечаток для действующего), а устаревшему исключению сторож значения не
 * называет вовсе.
 *
 * Шаг 0037/1: сверки отпечатка для этого было мало. Она ловила саму правку, но
 * не забытый подъём — обновив один отпечаток, разработчик получал зелёный
 * сторож при неподвижном номере (замерено мутацией на `e7071aa`: комментарий в
 * `fragment-builders/appendix.ts` + новый отпечаток = 14 зелёных тестов). Теперь
 * отпечаток снимается **при названном номере версии** и номер входит в хэш:
 * значение, годное при поднятом номере, при действующем не подходит, а значение
 * при действующем номере подсказка называет только после того, как исключение
 * объявлено в файле — с причиной и в диффе.
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
 * `run-deck-build.ts`, `llm-slide-copy.ts`, `gpt-deck-composer.ts`, `gpt-deck-editor.ts` и
 * `../gpt/client-payload-labels.ts` — по той же причине: первый решает тон
 * бейджа и склейку текста слайда, остальные четыре переписывают копию страниц
 * моделью и задают словарь, которым модель отвечает.
 *
 * `../client/ai-answer-text.ts` — какими словами напечатан ответ поискового ИИ:
 * он снимает разметку Markdown и сноски, то есть решает содержимое страницы
 * AI-ответов и панели на ней.
 *
 * `../client/client-address.ts` — как выглядит адрес источника: он печатается
 * и в таблице выдачи, и во фразе «Почему выделено», и рядом с цитатой. Файл
 * лежит вне `deck-sections/`, но решает слова страницы ровно так же, как
 * `risk-scale.ts`.
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
  /*
   * Склейка абзаца страницы: вводный абзац построителя плюс проза находки —
   * то, что уезжает рендерером на лист. Функция жила в `run-deck-build.ts`
   * (он в списке) и переехала сюда, когда её понадобилось спрашивать и
   * разбивке в `fragment-builders/shared.ts`; без этой строки правка склейки
   * меняла бы текст каждой страницы с находкой, не двигая отпечаток.
   */
  "page-narrative.ts",
  // Загрузчик входов решает, какие данные вообще доедут до построителя, —
  // ровно то же основание, что у `section-builders.ts`, и на живом пути:
  // его зовёт `canonical-report-prepare.ts`, а не только скрипт эталона.
  // Правка, добавляющая или снимающая поле записи (так однажды не доехало
  // `matchedName` записи комплаенса), меняет собранную деку, не двигая
  // отпечаток, — то есть версия не поднимается и кэш паков отдаёт прежний
  // документ.
  "load-deck-inputs.ts",
  "canonical-slots.ts",
  "continuation-cleanup.ts",
  "continuation-slide.ts",
  "deck-assembler.ts",
  "measured-bullet-fit.ts",
  // Укладка резюме по страницам формирует клиентский текст (заголовки частей,
  // нарезка тем), но в отпечаток не входила: правка 22.08, снявшая повтор
  // заголовка на странице-продолжении, прошла бы мимо сторожа, и кэш паков
  // отдал бы прежний текст.
  "semantic-summary-pagination.ts",
  "template-registry.ts",
  "../client/risk-scale.ts",
  "run-deck-build.ts",
  "llm-slide-copy.ts",
  "gpt-deck-composer.ts",
  // Редактор деки переписывает клиентский текст поверх готовых паков, а в
  // отпечаток не входил — рядом со своим же композером. Правка 22.08, снявшая
  // с него пак резюме, прошла бы мимо сторожа, и кэш отдал бы прежний текст.
  "gpt-deck-editor.ts",
  "../gpt/client-payload-labels.ts",
  "../../report/i18n/plural-ru.ts",
  "../client/client-address.ts",
  "../client/ai-answer-text.ts",
  // Ключ материала: по нему таблица выдачи склеивает строки, а снимок сводит
  // выделенные. Файл лежит слоем ниже деки (`serp-observation/`), но правка в
  // нём меняет и число строк таблицы, и число «выделено N» — то есть
  // содержимое пакетов, а сторож этого бы не увидел.
  "../../serp-observation/material-key.ts",
  // Единый предикат «негативна ли строка»: по нему дека ставит оценку в таблице
  // выдачи и считает негатив страницы изображений. Файл лежит слоем ниже деки,
  // но правка в нём меняет клиентский текст напрямую — ровно то же основание,
  // что у ключа материала рядом.
  "../../serp-observation/resolve-observation-highlights.ts",
  // Ключ материала слоя деки: по нему сводит строки печатная таблица выдачи и
  // считается «Всего по теме: N материалов» на каждой региональной странице.
  // Файл лежит в `deck-sections/`, но вне `fragment-builders/`, и правка в нём
  // меняет числа на страницах, не двигая отпечаток: проверено мутацией —
  // возврат константы вместо тела `evidenceMaterialKey` оставлял сторож
  // зелёным, а эталон клиентского текста краснел.
  "scoped-input.ts",
  // Словарь негатива, которому предикат делегирует ответ целиком: после шага
  // 0035/5 этот файл решает всю колонку «Оценка», рамки снимка и рамки сетки.
  // Проверено мутацией: возврат `court(?!s)` → `court` меняет оценку двух строк
  // таблицы, состав рамок снимка ОАЭ и цитату в резюме — а сторож без этой
  // строки остаётся зелёным, и кэш паков отдаёт прежний текст.
  "../../config/finding-themes.ts",
  // Предикат снятия совпадения: он решает, доедет ли слово словаря до колонки
  // «Оценка» и до рамки. Лежит рядом со словарём и по тому же основанию — без
  // него правка окна отрицания меняла бы клиентский текст, не двигая отпечаток.
  "../../config/negated-dictionary-hit.ts",
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
 * Отпечаток исходников построителей: соль + имя файла и содержимое, в порядке
 * имён.
 *
 * Соль в хэше не для красоты: она превращает «отпечаток» в запись «такие
 * исходники при таком номере» (а в ветке исключения — «при такой причине»). Без
 * неё значение, посчитанное по новым исходникам, годилось бы при любом номере —
 * и забытый подъём проходил бы зелёным (замерено мутацией на `e7071aa`).
 * Из чего складывается соль, решает правило: тест только хеширует.
 *
 * Чтение отдаётся параметром, чтобы проверка «правка такого-то файла двигает
 * отпечаток» была настоящей: подменённое содержимое обязано менять результат.
 */
function fingerprintBuilders(
  salt: string,
  read: (path: string) => Buffer | string = readFileSync
): string {
  const h = createHash("sha256");
  h.update(salt);
  for (const { name, path } of fingerprintSources()) {
    h.update(name);
    h.update(read(path));
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Номер, при котором собраны пакеты эталона в дереве, — пол для сторожа.
 *
 * Это единственный доступный офлайн ответ на «какой номер уже закоммичен»:
 * истории у теста нет, а `contentVersion` пакета говорит, при каком ключе кэша
 * собран эталон. Берётся максимум: подделать пол — значит переписать пакеты, а
 * это двадцать два файла в диффе.
 */
function baselineContentVersion(
  root = join(process.cwd(), "baselines/report-72/artifacts/deck-sections/section-packs")
): string {
  const versions: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json")) {
        versions.push(String(JSON.parse(readFileSync(path, "utf8")).contentVersion));
      }
    }
  };
  try {
    walk(root);
  } catch {
    // В файле, где каждый отказ объясняет, что делать, трасса `scandir` не
    // объясняет ничего: читатель решит, что сломан сторож, а не что он сам
    // снёс кэш пакетов перед прогоном.
    throw new Error(
      `Пакетов эталона нет (${root}): пол сторожа читается из них. ` +
        "Соберите ворота — npx tsx scripts/run-orion-deck-sections-report72.ts."
    );
  }
  const ordinal = (v: string) => Number(/(\d+)$/u.exec(v)?.[1] ?? 0);
  return versions.sort((a, b) => ordinal(a) - ordinal(b)).at(-1) ?? "";
}

/**
 * Отпечаток, названный подсказкой, — или `null`, если она его не назвала.
 *
 * Сценарии обхода тем и живут, что разработчик копирует значение из отказа;
 * поэтому проверки берут его оттуда же, а не считают сами.
 */
function printedFingerprint(problem: string | null): string | null {
  return /DECK_BUILDER_FINGERPRINT\s+=\s+"([^"]+)"/u.exec(problem ?? "")?.[1] ?? null;
}

/**
 * Назвал ли отказ хоть какой-нибудь отпечаток — в любом виде и в любой строке.
 *
 * Проверять только готовую к вставке строку мало: значение, названное посреди
 * фразы, копируется так же. Отпечатки сценариев узнаются по соли, которая
 * всегда содержит номер версии.
 */
function namesAnyFingerprint(problem: string | null): boolean {
  return /@deck-sections-|\b[0-9a-f]{16}\b/u.test(problem ?? "");
}

/** Отпечаток «прежних» исходников — для сценариев на подменённом хэшере. */
const before = (version: string) => `before@${version}`;
/** Отпечаток исходников после правки построителя. */
const after = (version: string) => `after@${version}`;
/** Отпечаток исходников после ещё одной, следующей правки. */
const later = (version: string) => `later@${version}`;

/**
 * Номера сценариев: «нынешний» и следующий за ним. Совпадать с настоящим
 * `DECK_CONTENT_VERSION` они не обязаны — сценарий проверяет правило, а не
 * сегодняшнее число.
 */
const SCENARIO_VERSION = "deck-sections-v144";
const SCENARIO_NEXT = "deck-sections-v145";
/** Пол сценариев: пакеты эталона собраны при «нынешнем» номере. */
const SCENARIO_BASELINE = SCENARIO_VERSION;
/** Причина, с которой в сценариях объявляется исключение. */
const SCENARIO_REASON = "правлен только комментарий: ни одна собранная дека измениться не может";

/**
 * Синтетические номера для сравнений «два вычисления между собой». Настоящий
 * номер тут брать нельзя: отказ напечатал бы отпечаток нынешних исходников при
 * действующем номере, а это готовая подсказка мимо сторожа.
 */
const PROBE_A = "deck-sections-v0";
const PROBE_B = "deck-sections-v1";

describe("версия содержимого деки не отстаёт от построителей", () => {
  it("отпечаток совпадает с записанным", () => {
    // Сравнение сведено к логическому не для красоты: `toBe` печатает в отказе
    // само посчитанное значение, а это отпечаток нынешних исходников **при
    // действующем номере** — ровно та строка, вставка которой делает сторож
    // зелёным без подъёма версии. Подсказка называет отпечаток только для
    // поднятого номера, и обходить её через вывод ассерта незачем.
    //
    // Проверка поглощена соседней («записанная пара согласована») и упасть
    // одна не может — она подстраховка: снимут соседнюю как дубль, и сторож
    // вернётся к прежней силе, когда сверялся один отпечаток.
    const matches = fingerprintBuilders(recordedFingerprintSalt()) === DECK_BUILDER_FINGERPRINT;
    const hint = describeFingerprintProblem((salt) => fingerprintBuilders(salt), baselineContentVersion()) ?? "";
    expect(matches, hint).toBe(true);
  });

  it("записанная пара «отпечаток ↔ номер версии» согласована", () => {
    // Главная проверка сторожа: она смотрит на все четыре записанные величины
    // сразу — отпечаток, номер, версию снятия и объявленное исключение.
    const problem = describeFingerprintProblem((salt) => fingerprintBuilders(salt), baselineContentVersion());
    expect(problem, problem ?? "").toBeNull();
  });

  it("отпечаток снят при названном номере: другой номер — другой отпечаток", () => {
    // Это и есть механизм, а не украшение: пока номер не входит в хэш,
    // значение по новым исходникам годится при неподвижной версии и забытый
    // подъём проходит зелёным.
    expect(fingerprintBuilders(PROBE_A)).not.toBe(fingerprintBuilders(PROBE_B));
  });

  it("отпечаток обновлён, а номер версии — нет: сторож красный и называет обе константы", () => {
    // Сценарий забывчивости в его настоящем виде: подсказка дала запись для
    // поднятого номера, разработчик вставил её, но `DECK_CONTENT_VERSION`
    // оставил прежним.
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_NEXT,
      fingerprint: after(SCENARIO_NEXT),
      exception: null,
    });
    expect(problem).not.toBeNull();
    expect(problem).toContain("DECK_CONTENT_VERSION");
    expect(problem).toContain("FINGERPRINT_TAKEN_AT_VERSION");
    expect(problem).toContain(SCENARIO_NEXT);
  });

  it("вставлен один отпечаток без версии снятия: сторож красный", () => {
    // Вторая половина той же забывчивости: из подсказки взята одна строка.
    // Запись перестаёт быть самосогласованной — отпечаток снят не при том
    // номере, который в ней записан.
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: after(SCENARIO_NEXT),
      exception: null,
    });
    expect(problem).not.toBeNull();
    expect(problem).toContain("DECK_BUILDER_FINGERPRINT");
  });

  it("подсказка не называет отпечаток для действующего номера", () => {
    // Ровно этим забывчивость и закрыта: значение, которое сделало бы сторож
    // зелёным без подъёма, в подсказке не печатается. Получить его можно
    // только объявив исключение — то есть написав причину в файл.
    const problem =
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: null,
      }) ?? "";
    expect(problem).toContain(after(SCENARIO_NEXT));
    expect(problem).not.toContain(after(SCENARIO_VERSION));
  });

  it("обновлены и отпечаток, и номер версии: сторож молчит", () => {
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_NEXT,
      takenAtVersion: SCENARIO_NEXT,
      fingerprint: after(SCENARIO_NEXT),
      exception: null,
    });
    expect(problem).toBeNull();
  });

  it("объявленное исключение с причиной оставляет номер на месте", () => {
    // Узкая ветка, оплаченная деньгами: подъём номера обесценивает готовые
    // пакеты и заставляет платить за стадии GPT заново, в том числе идущему
    // прогону. Правка, которая заведомо не может изменить ни одну собранную
    // деку, номер не двигает — но теперь говорит об этом в файле.
    const value = printedFingerprint(
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: { fingerprint: "", reason: SCENARIO_REASON },
      })
    );
    expect(value).not.toBeNull();

    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: value ?? "",
      exception: { fingerprint: value ?? "", reason: SCENARIO_REASON },
    });
    expect(problem).toBeNull();
  });

  it("значение, добытое исключением, без исключения не годится", () => {
    // Путь обхода, найденный ревью: объявить исключение с любой причиной,
    // забрать названный отпечаток, вписать его и **удалить исключение** — в
    // диффе остаётся одна строка отпечатка, то есть ровно дефект. Причина
    // входит в соль отпечатка, поэтому добытое значение вне своей ветки
    // недействительно.
    const value = printedFingerprint(
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: { fingerprint: "", reason: SCENARIO_REASON },
      })
    );
    expect(value).not.toBeNull();

    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: value ?? "",
      exception: null,
    });
    expect(problem).not.toBeNull();
    expect(problem).toContain(SCENARIO_NEXT);
  });

  it("значение, добытое исключением, не годится с другой причиной", () => {
    // Иначе причина была бы украшением: её можно было бы переписать, оставив
    // добытый отпечаток, и в диффе причина отвечала бы не за ту правку.
    const value = printedFingerprint(
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: { fingerprint: "", reason: SCENARIO_REASON },
      })
    );
    expect(value).not.toBeNull();

    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: value ?? "",
      exception: { fingerprint: value ?? "", reason: "другая причина" },
    });
    expect(problem).not.toBeNull();
  });

  it("исключение без причины не считается объявленным и значения не получает", () => {
    // Иначе исключение выродится в самый дешёвый путь к зелёному: голый флаг
    // неотличим от забывчивости, а причина попадает в дифф и читается в ревью.
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: before(SCENARIO_VERSION),
      exception: { fingerprint: "", reason: "   " },
    });
    expect(problem).toContain("FINGERPRINT_VERSION_EXCEPTION");
    expect(namesAnyFingerprint(problem)).toBe(false);
  });

  it("исключение прошлой правки следующую не прикрывает и значения ей не даёт", () => {
    // Самый вероятный путь, потому что без умысла: исключение осталось от
    // прошлого шага, следующий разработчик правит построитель, сторож краснеет
    // и **сам называет значение** — вставил в оба поля, чужую причину не
    // тронул, зелено. Поэтому устаревшему исключению отпечаток не называется:
    // сначала снимите его или объявите заново, стерев поле.
    const value = printedFingerprint(
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: { fingerprint: "", reason: SCENARIO_REASON },
      })
    );

    // Прошёл шаг, правится следующий построитель — хэшер отвечает по-новому.
    const problem = describeFingerprintProblem(later, SCENARIO_BASELINE, {
      version: SCENARIO_VERSION,
      takenAtVersion: SCENARIO_VERSION,
      fingerprint: value ?? "",
      exception: { fingerprint: value ?? "", reason: SCENARIO_REASON },
    });
    expect(problem).toContain("FINGERPRINT_VERSION_EXCEPTION");
    expect(namesAnyFingerprint(problem)).toBe(false);
    expect(problem).toMatch(/снимите|объявите заново/iu);
  });

  it("номер ниже пакетов эталона: сторож красный и отпечатка не называет", () => {
    // Второй путь обхода: понизить обе строки номера, забрать напечатанный
    // отпечаток для «следующего» — которым окажется действующий, — и вернуть
    // строки на место. Пол читается из пакетов эталона, поэтому понижение не
    // выдаёт ничего: ниже пола сторож молчит о значениях.
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: "deck-sections-v143",
      takenAtVersion: "deck-sections-v143",
      fingerprint: after("deck-sections-v143"),
      exception: null,
    });
    expect(problem).not.toBeNull();
    expect(namesAnyFingerprint(problem)).toBe(false);
    expect(problem).toContain(SCENARIO_BASELINE);
  });

  it("подъём считается от пакетов эталона, а не от записанного номера", () => {
    // Второй подъём внутри шага не нужен: номер уже отличается от того, при
    // котором собраны закоммиченные пакеты, — кэш и так промахнётся. Иначе
    // номер рос бы храповиком, v145 → v146 → v147, за одну работу.
    const problem = describeFingerprintProblem(after, SCENARIO_BASELINE, {
      version: SCENARIO_NEXT,
      takenAtVersion: SCENARIO_NEXT,
      fingerprint: before(SCENARIO_NEXT),
      exception: null,
    });
    expect(problem).toContain(`DECK_CONTENT_VERSION         = "${SCENARIO_NEXT}"`);
    expect(problem).not.toContain("deck-sections-v146");
  });

  it("номер, поднятый своей причиной, требует перезаписать отпечаток при нём — и только его", () => {
    // Версия могла подняться не из-за построителей (скажем, из-за промпта).
    // Исходники при этом не двигались, поэтому подсказка обязана звать к
    // текущему номеру, а не к следующему: второй подъём был бы лишней оплатой
    // стадий GPT.
    const problem =
      describeFingerprintProblem(before, SCENARIO_BASELINE, {
        version: SCENARIO_NEXT,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: null,
      }) ?? "";
    expect(problem).toContain(SCENARIO_NEXT);
    expect(problem).not.toContain("deck-sections-v146");
  });

  it("пакеты уже собраны при действующем номере — номер обязан подняться", () => {
    // Обратная сторона предыдущей проверки и суть пола: подъём считается от
    // номера **собранных пакетов**, а не от записанного. Пакеты при v145 есть —
    // значит правка построителя обязана уехать на v146, иначе приёмка соберёт
    // старое из кэша.
    const problem = describeFingerprintProblem(after, SCENARIO_NEXT, {
      version: SCENARIO_NEXT,
      takenAtVersion: SCENARIO_NEXT,
      fingerprint: before(SCENARIO_NEXT),
      exception: null,
    });
    expect(problem).toContain(`DECK_CONTENT_VERSION         = "deck-sections-v146"`);
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
    const hint =
      describeFingerprintProblem(after, SCENARIO_BASELINE, {
        version: SCENARIO_VERSION,
        takenAtVersion: SCENARIO_VERSION,
        fingerprint: before(SCENARIO_VERSION),
        exception: null,
      }) ?? "";
    expect(hint).toContain(`DECK_CONTENT_VERSION         = "${SCENARIO_NEXT}"`);
    expect(hint).toContain(`FINGERPRINT_TAKEN_AT_VERSION = "${SCENARIO_NEXT}"`);
    expect(hint).toContain(`DECK_BUILDER_FINGERPRINT     = "${after(SCENARIO_NEXT)}"`);
    expect(hint).toMatch(/Исключение/u);
    expect(hint).toMatch(/не может изменить ни одну\s+собранную деку/u);
    expect(hint).toContain("FINGERPRINT_VERSION_EXCEPTION");
  });

  it("правка реестра шаблонов двигает отпечаток", () => {
    // Реестр — часть содержимого страниц, а не настройка сборки: в нём живут
    // ёмкости страниц и бюджеты знаков. Ёмкость матрицы 4 → 3 изменила
    // раскладку карточек и `contentHash` секции, а отпечаток остался прежним —
    // паки со старой раскладкой приехали бы из кэша под новый рендерер.
    const registry = join(SECTIONS_DIR, "template-registry.ts");
    const patched = fingerprintBuilders(PROBE_A, (path) =>
      path === registry ? `${readFileSync(path, "utf8")}\n// правка` : readFileSync(path)
    );
    expect(patched).not.toBe(fingerprintBuilders(PROBE_A));
  });

  it.each([
    ["клиентской шкалы риска", "../client/risk-scale.ts"],
    ["сборки полезной нагрузки рендерера", "run-deck-build.ts"],
    ["подмены копии слайдов моделью", "llm-slide-copy.ts"],
    ["сборки деки моделью", "gpt-deck-composer.ts"],
    ["словаря нагрузки модели", "../gpt/client-payload-labels.ts"],
    ["склонения существительных", "../../report/i18n/plural-ru.ts"],
    ["печати адреса источника", "../client/client-address.ts"],
    ["чистки ответа поискового ИИ", "../client/ai-answer-text.ts"],
    ["ключа материала слоя деки", "scoped-input.ts"],
  ])("правка %s двигает отпечаток", (_what, file) => {
    // Все они решают, каким словом и каким тоном напечатано содержимое
    // страницы. Файл вне отпечатка — правка приезжает из кэша прежней.
    const target = join(SECTIONS_DIR, file);
    const patched = fingerprintBuilders(PROBE_A, (path) =>
      path === target ? `${readFileSync(path, "utf8")}\n// правка` : readFileSync(path)
    );
    expect(patched).not.toBe(fingerprintBuilders(PROBE_A));
  });

  it("версия названа так, как её ждёт кэш", () => {
    expect(DECK_CONTENT_VERSION).toMatch(/^deck-sections-v\d+$/u);
    expect(FINGERPRINT_TAKEN_AT_VERSION).toMatch(/^deck-sections-v\d+$/u);
  });

  it("пакеты эталона собраны при действующем номере", () => {
    /*
     * Не «пол не обгоняет номер», а **равен** ему, и это главная проверка
     * порядка работы.
     *
     * Пока сторож соглашался на «номер выше пола», состояние «поднял номер,
     * ворота не гонял» было зелёным во всём офлайн-контуре — то есть
     * коммитилось и уезжало в деплой. А дальше правка построителя получала от
     * сторожа совет «номер оставьте, обновите отпечаток»: пакеты при этом
     * номере уже собраны на живом томе, и правка приезжала из кэша прежней —
     * ровно тот отказ, ради которого сторож и написан.
     *
     * Цена равенства: между «поднял номер» и «перегнал ворота» `npm test`
     * красный. Это и есть требуемый порядок, а не помеха.
     */
    const baseline = baselineContentVersion();
    expect(baseline).toMatch(/^deck-sections-v\d+$/u);
    expect(
      baseline,
      [
        `Пакеты эталона собраны при "${baseline}", а DECK_CONTENT_VERSION = "${DECK_CONTENT_VERSION}".`,
        "Подняли номер — перегоните ворота, чтобы пакеты пересобрались под него:",
        "  npx tsx scripts/run-orion-deck-sections-report72.ts",
        "Иначе состояние «номер выше пакетов» уедет в коммит, а следующей правке",
        "сторож разрешит оставить номер на месте — при уже собранных на нём деках.",
      ].join("\n")
    ).toBe(DECK_CONTENT_VERSION);
  });

  it("пол объясняет, что делать, когда пакетов эталона нет", () => {
    // Снесённый перед прогоном кэш пакетов — обычное дело в работе над декой.
    // Отказ обязан говорить фразой: трасса `scandir` читается как поломка
    // сторожа.
    expect(() => baselineContentVersion(join(process.cwd(), "нет-такого-каталога"))).toThrow(
      /Пакетов эталона нет.*Соберите ворота/su
    );
  });

  it("проверка «отпечаток не назван» узнаёт и настоящий отпечаток", () => {
    // Помощник стоит на подменённом хэшере, поэтому синтетических значений ему
    // хватало. Но имя обещает большее, и первая же проверка против настоящего
    // хэшера прошла бы молча и зря.
    expect(namesAnyFingerprint('DECK_BUILDER_FINGERPRINT = "after@deck-sections-v144"')).toBe(true);
    expect(namesAnyFingerprint('DECK_BUILDER_FINGERPRINT = "88d1526a6db30a98"')).toBe(true);
    expect(namesAnyFingerprint("Поднимите номер — отпечатка сторож не называет.")).toBe(false);
  });

  it("подсказка о следующей версии считается верно", () => {
    expect(nextContentVersion("deck-sections-v39")).toBe("deck-sections-v40");
    expect(nextContentVersion("deck-sections-v9")).toBe("deck-sections-v10");
  });
});
