/**
 * Сторож пары «отпечаток построителей ↔ номер версии содержимого».
 *
 * Лежит отдельно от `content-version.ts` сознательно: тот модуль импортируют
 * живые пути ради ключа кэша, а здесь — правило, которое исполняет только тест.
 * Читать исходники правило не умеет и не должно: хэшер приходит параметром.
 *
 * **Чего сторож не может.** Истории у него нет — он видит только нынешнее
 * состояние файлов, — поэтому от того, кто готов сам посчитать sha256, он не
 * защищает и защищать не может. Его работа в другом: закрыть пути, на которые
 * набредаешь **следуя его же подсказкам**, и сделать обход письменным. Отсюда
 * три решения ниже, и каждое оплачено найденным обходом:
 *
 * 1. Отпечаток ветки исключения солится **причиной**: добытое там значение не
 *    годится ни без исключения, ни с другой причиной. Иначе объявить
 *    исключение, забрать отпечаток и удалить исключение стоило бы одной
 *    минуты, а в диффе осталась бы одна строка — ровно дефект.
 * 2. Номер сверяется с **полом** — номером, при котором собраны пакеты эталона
 *    в дереве. Иначе достаточно было временно понизить обе строки номера,
 *    чтобы сторож напечатал отпечаток для действующего.
 * 3. Устаревшему исключению отпечаток **не называется**. Иначе исключение
 *    прошлого шага прикрывало бы следующую правку чужой причиной — путь без
 *    умысла, а потому самый вероятный.
 */

import {
  DECK_BUILDER_FINGERPRINT,
  DECK_CONTENT_VERSION,
  FINGERPRINT_TAKEN_AT_VERSION,
  FINGERPRINT_VERSION_EXCEPTION,
  type FingerprintVersionException,
} from "./content-version";

/** Следующий номер версии — чтобы подсказка была готовой к вставке. */
export function nextContentVersion(version: string): string {
  return version.replace(/(\d+)$/u, (n) => String(Number(n) + 1));
}

/** Порядковый номер версии: по нему сравниваются номера. */
function ordinal(version: string): number {
  return Number(/(\d+)$/u.exec(version)?.[1] ?? 0);
}

function laterVersion(a: string, b: string): string {
  return ordinal(a) >= ordinal(b) ? a : b;
}

/** Соль обычной записи: «эти исходники при этом номере». */
function versionSalt(version: string): string {
  return version;
}

/**
 * Соль ветки исключения: «эти исходники при этом номере и по этой причине».
 *
 * Причина в соли — не украшение: без неё отпечаток, добытый объявленным
 * исключением, годился бы и после его удаления, и с переписанной причиной.
 */
function exceptionSalt(version: string, reason: string): string {
  return `${version}\nисключение: ${reason.trim()}`;
}

/** Записанное в `content-version.ts` состояние сторожа. */
type FingerprintRecord = {
  readonly version: string;
  readonly takenAtVersion: string;
  readonly fingerprint: string;
  readonly exception: FingerprintVersionException | null;
};

/**
 * Соль, которой снята записанная пара, — один ответ на «как считается
 * записанный отпечаток».
 *
 * Ветка исключения снимает отпечаток под причину, обычная — под номер снятия.
 * Пока это знало только правило, подстраховочная сверка теста считала запись
 * по обычной соли и краснела на законном исключении (найдено прогоном).
 */
export function recordedFingerprintSalt(record: FingerprintRecord = RECORDED): string {
  return record.exception && record.exception.reason.trim() !== ""
    ? exceptionSalt(record.version, record.exception.reason)
    : versionSalt(record.takenAtVersion);
}

const RECORDED: FingerprintRecord = {
  version: DECK_CONTENT_VERSION,
  takenAtVersion: FINGERPRINT_TAKEN_AT_VERSION,
  fingerprint: DECK_BUILDER_FINGERPRINT,
  exception: FINGERPRINT_VERSION_EXCEPTION,
};

/**
 * Что не так с записью «отпечаток ↔ номер версии», или `null`, если сошлось.
 *
 * Отпечаток считает тест — он один имеет право читать исходники, — поэтому
 * хэшер приходит параметром: `fingerprintWith(соль)` возвращает отпечаток
 * нынешних исходников, снятый с этой солью. `baselineVersion` — номер, при
 * котором собраны пакеты эталона в дереве: единственный доступный офлайн ответ
 * на «какой номер уже закоммичен».
 *
 * Правило одно: записанная пара обязана быть снята при действующем номере, а
 * действующий номер обязан отличаться от того, при котором собраны готовые
 * пакеты, — иначе правка приедет из кэша прежней.
 */
export function describeFingerprintProblem(
  fingerprintWith: (salt: string) => string,
  baselineVersion: string,
  record: FingerprintRecord = RECORDED
): string | null {
  const { version, takenAtVersion, fingerprint, exception } = record;

  if (ordinal(version) < ordinal(baselineVersion)) {
    return [
      `DECK_CONTENT_VERSION = "${version}" ниже, чем номер собранных пакетов`,
      `эталона ("${baselineVersion}").`,
      "",
      "Так ключ кэша сталкивается: под одной строкой оказываются два разных",
      "содержимого, и «Пересобрать отчёт» отдаст чужие готовые пакеты как свои.",
      "Поднимите номер — отпечатка сторож ниже пола не называет.",
    ].join("\n");
  }

  if (exception) {
    if (exception.reason.trim() === "") {
      return [
        "FINGERPRINT_VERSION_EXCEPTION объявлено без причины.",
        "Причина и есть исключение: голый флаг неотличим от забывчивости, а",
        "причина попадает в дифф и читается в ревью. Назовите, почему правка",
        "заведомо не может изменить ни одну собранную деку, — или снимите",
        "исключение и поднимите номер версии.",
      ].join("\n");
    }

    const required = fingerprintWith(recordedFingerprintSalt(record));
    // Пустое поле — «исключение объявлено, значение ещё не проставлено»: только
    // в этом состоянии сторож называет отпечаток при действующем номере.
    const declaredForThisEdit = exception.fingerprint === "" || exception.fingerprint === required;
    if (!declaredForThisEdit) {
      return [
        "FINGERPRINT_VERSION_EXCEPTION относится к другой правке: записанный в",
        "нём отпечаток снят не под эту причину и не под нынешние исходники.",
        "",
        "Исключение живёт ровно одну правку. Оставленное в дереве, оно прикрыло",
        "бы следующую правку чужой причиной и превратило сторож в выключатель,",
        "поэтому отпечатка вам здесь никто не назовёт.",
        "",
        "Снимите исключение — тогда номер версии обязан подняться. Если ваша",
        "правка тоже не может изменить ни одну собранную деку, объявите",
        "исключение заново: сотрите поле fingerprint и напишите **свою**",
        "причину; причина от прошлого шага — находка ревью, а не оформление.",
      ].join("\n");
    }

    if (takenAtVersion !== version || fingerprint !== required || exception.fingerprint === "") {
      return [
        "Исключение объявлено, поэтому номер версии остаётся на месте.",
        "Приведите к нему запись в content-version.ts:",
        `  FINGERPRINT_TAKEN_AT_VERSION = "${version}"`,
        `  DECK_BUILDER_FINGERPRINT     = "${required}"`,
        `  FINGERPRINT_VERSION_EXCEPTION.fingerprint = "${required}"`,
        "",
        "Значение снято под вашу причину: сотрёте исключение или перепишете",
        "причину — оно перестанет годиться.",
      ].join("\n");
    }
    return null;
  }

  const takenAtIsHonest = fingerprint === fingerprintWith(recordedFingerprintSalt(record));
  if (takenAtIsHonest && takenAtVersion === version) return null;

  // Исходники не двигались — двигался номер, и своей причиной: подъёма не
  // требуем, запись просто переносится к нему. Двигались — номер обязан
  // отличаться от того, при котором собраны **готовые пакеты**, и не
  // понижаться.
  //
  // Запрет «номер не обгоняет пакеты» держит НЕ эта формула, а утверждение
  // «пол === DECK_CONTENT_VERSION» в `deck-content-version.test.ts`. Проверено
  // ревью: прежнее ветвление `version > baseline ? version : next(baseline)`
  // тождественно этой строке на всех 3481 паре номеров, и его возврат не
  // краснит ни одного теста. Ослабление того утверждения до `<=` открывает
  // пятый путь: состояние «номер выше пакетов» коммитится, и на следующей
  // правке сторож советует оставить номер, отдавая деку из кэша. Формула здесь
  // просто перестала писать один ответ двумя способами.
  const target = takenAtIsHonest
    ? laterVersion(takenAtVersion, version)
    : laterVersion(nextContentVersion(baselineVersion), version);

  return [
    "Отпечаток построителей и версия содержимого разошлись.",
    "Кэш секций держится на DECK_CONTENT_VERSION: пока строка не сдвинулась,",
    "правка не дойдёт ни до новой деки, ни до кнопки «Пересобрать отчёт».",
    "",
    "Запишите в content-version.ts все три строки:",
    `  DECK_CONTENT_VERSION         = "${target}"`,
    `  FINGERPRINT_TAKEN_AT_VERSION = "${target}"`,
    `  DECK_BUILDER_FINGERPRINT     = "${fingerprintWith(versionSalt(target))}"`,
    "",
    "Исключение — узкое и объявляемое. Отпечаток снят с файлов целиком, а в них",
    "живёт не только содержимое страниц (цикл «сборка → мера → перекладка» в",
    "run-deck-build.ts, например). Если правка заведомо не может изменить ни одну",
    "собранную деку — затронутая ветка исполняется только там, где деки нет",
    "вовсе, — объявите FINGERPRINT_VERSION_EXCEPTION с причиной и пустым полем",
    "fingerprint, и тест назовёт отпечаток, снятый под эту причину. Подъём иначе",
    "обесценил бы все готовые пакеты и заставил бы «Пересобрать отчёт» строить",
    "заново то же самое.",
  ].join("\n");
}
