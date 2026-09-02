/**
 * Конфликт по отчеству (шаг 13, C9).
 *
 * В отчёт попал материал «ИП Дуров Павел **Юрьевич** — ОГРНИП: 324774600790305»
 * под деловым профилем субъекта, у которого отчество Валерьевич. Фамилия и имя
 * совпали, и классификатор выдал `SUBJECT_MATCH`.
 *
 * Отрицательные признаки личности (`wrongPatronymics`) в системе есть, но их
 * заполняет оператор вручную. На свежем кейсе они пусты, поэтому защиты не было
 * вовсе. При этом конфликт **выводится**: если при имени субъекта стоит
 * отчество, отличное от его собственного, речь идёт о другом человеке. В
 * русской именной тройке это решающий признак, а не повод для сомнений.
 *
 * Именно при имени, а не просто рядом с фамилией. Биография субъекта называет
 * родню — «Отец — бизнесмен Ильдар Вахитович Юнусов», «Дед Тимати — Вахит
 * Закирович Юнусов», — и фамилия там своя. На прогоне 14.08 такое соседство
 * отправило в «другое лицо» 27 материалов, включая статью о самом субъекте.
 *
 * Модуль чистый: ни сети, ни БД, ни модели.
 */

import { transliterateRuToLat } from "../identity/transliterate-ru";

/**
 * Окончания русских отчеств.
 *
 * Границы слова заданы просмотром по буквам, а не `\b`: в JavaScript `\b`
 * определён на ASCII, и с кириллицей границ не находит вовсе — регулярное
 * выражение молча не срабатывало бы ни на одном отчестве.
 */
const PATRONYMIC_RE =
  /(?<!\p{L})(\p{L}{2,}(?:ович|евич|ьевич|овна|евна|ьевна|ична|инична)(?:а|у|ем|е|ы|ой)?)(?!\p{L})/gu;

/**
 * Отчество в именительном падеже.
 *
 * В тексте отчество склоняется: «дело Юнусова Тимура Ахметовича». Без
 * приведения к начальной форме такая запись не совпадает ни с собственным
 * отчеством субъекта — и объявляется чужой, — ни с чужим, если сравнивать
 * наоборот. Обе ошибки одинаково плохи, поэтому падеж снимается до сравнения.
 */
function baseForm(word: string): string {
  const m = word.match(
    /^(\p{L}+?(?:ович|евич|ьевич|овна|евна|ьевна|ична|инична))(?:а|у|ем|е|ы|ой)?$/u
  );
  return m?.[1] ?? word;
}

/**
 * Короткие отчества на «-ич» перечислены поимённо.
 *
 * Общее окончание «-ич» ловило обычные слова: «москвич», «кулич», «паралич»,
 * «экономич…» — и объявляло материал чужим с уверенностью 0,9. Настоящих
 * коротких отчеств немного, и список закрывает вопрос без ложных срабатываний.
 */
const SHORT_PATRONYMICS = new Set([
  "ильич",
  "кузьмич",
  "лукич",
  "фомич",
  "саввич",
  "никитич",
  "ильинична",
  "кузьминична",
]);
const SHORT_PATRONYMIC_RE = /(?<!\p{L})(\p{L}{3,})(?!\p{L})/gu;

/** Насколько близко к фамилии отчество считается относящимся к ней. */
const ADJACENCY_CHARS = 40;

/**
 * Основа имени для сравнения с падежными формами.
 *
 * Русское имя склоняется, и у части имён при этом выпадает беглая гласная:
 * Павел → Павла, Павлом. Сравнение целым словом такие формы теряет, поэтому
 * сверяется начало: у коротких имён три буквы, у длинных — все, кроме двух
 * последних. Хвост добирается отдельно, до четырёх букв, — этого хватает на
 * творительный падеж («Александром»).
 */
function nameStem(name: string): string {
  return name.slice(0, name.length <= 5 ? 3 : name.length - 2);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Кириллица соседних алфавитов приводится к русской.
 *
 * Украинская и белорусская запись отличается несколькими буквами: «Тимур
 * Ільдарович ЮНУСОВ» на украинской странице — тот же субъект, но «ільдарович»
 * не совпадало с «ильдарович» и объявлялось чужим отчеством. Материал при этом
 * из тех, ради которых аудит и делают.
 */
const CYRILLIC_VARIANTS: Record<string, string> = {
  ё: "е",
  і: "и",
  ї: "и",
  є: "е",
  ґ: "г",
  ў: "у",
  "'": "",
  ʼ: "",
};

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ёіїєґў'ʼ]/gu, (c) => CYRILLIC_VARIANTS[c] ?? c)
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Отчества, стоящие рядом с фамилией субъекта и отличные от его собственных.
 *
 * Соседство обязательно: в тексте, где упомянут и субъект, и посторонний
 * «Иванов Пётр Сергеевич», чужое отчество не относится к субъекту и конфликтом
 * не является.
 */
/**
 * Слова текста с их позициями — общий обход для латинского прохода.
 *
 * Позиция нужна тому же окну близости к фамилии, которым пользуется
 * кириллический проход: без неё пришлось бы заводить второй ответ на вопрос
 * «относится ли это отчество к фамилии рядом».
 */
function wordsWithOffsets(haystack: string): Array<{ word: string; at: number }> {
  const found: Array<{ word: string; at: number }> = [];
  for (const m of haystack.matchAll(/(?<!\p{L})(\p{L}{2,})(?!\p{L})/gu)) {
    found.push({ word: m[1]!, at: m.index ?? 0 });
  }
  return found;
}

export function conflictingPatronymics(
  text: string,
  subject: {
    lastName: string;
    lastNameVariants?: string[];
    patronymics: string[];
    /**
     * Имена субъекта. Без них конфликт не выводится вовсе: биография называет
     * родню по имени-отчеству, и одной фамилии рядом мало.
     */
    firstNames?: string[];
    /** Псевдонимы и транслитерации: там живёт латинская форма отчества. */
    aliases?: string[];
  }
): string[] {
  const haystack = norm(text);
  if (!haystack) return [];

  const own = new Set(
    subject.patronymics.map((p) => baseForm(norm(p))).filter((p) => p.length > 3)
  );
  // Без собственного отчества сравнивать не с чем: молчим, а не гадаем.
  if (own.size === 0) return [];

  const surnames = [subject.lastName, ...(subject.lastNameVariants ?? [])]
    .map(norm)
    .filter((s) => s.length > 2);
  if (surnames.length === 0) return [];

  const windows: Array<[number, number]> = [];
  for (const surname of surnames) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(surname, from);
      if (at < 0) break;
      windows.push([
        Math.max(0, at - ADJACENCY_CHARS),
        Math.min(haystack.length, at + surname.length + ADJACENCY_CHARS),
      ]);
      from = at + surname.length;
    }
  }
  if (windows.length === 0) return [];

  /*
   * Слова ищутся в целом тексте, а окно решает только, засчитывать ли находку.
   *
   * Раньше текст резался по символам ровно на границе окна, и регулярное
   * выражение читало обрубок как отдельное слово: от «Абусаидович» оставалось
   * «идович», от «экономический» — «экономич». Такой обрубок не совпадал с
   * собственным отчеством субъекта и объявлялся чужим — с уверенностью 0,9,
   * то есть материал выбрасывался из аудита как «про другое лицо». На разборе
   * живого прогона так потерялись 30 материалов из 41, включая статью о самом
   * субъекте в Википедии.
   */
  const nearSurname = (at: number, length: number): boolean =>
    windows.some(([start, end]) => at < end && at + length > start);

  /*
   * Отчество считается чужим только в тройке с именем субъекта.
   *
   * Соседства с фамилией мало. Энциклопедическая статья о самом субъекте
   * называет родню: «Дед Тимати — Вахит Закирович Юнусов», «бизнесмена Ильдара
   * Вахитовича и Симоны Яковлевны Юнусовой». Фамилия там своя, отчества чужие —
   * и на прогоне 14.08 статья РУВИКИ о субъекте была помечена как «о другом
   * лице» с уверенностью 0,9, а рядом с ней ещё двадцать шесть материалов.
   *
   * Опасность, ради которой правило заводилось, выглядит иначе: «Дуров Павел
   * **Юрьевич**» при отчестве Валерьевич — совпали и фамилия, и имя. Значит,
   * решает не близость к фамилии, а связка «имя субъекта + чужое отчество»:
   * у деда имя другое, и статья остаётся статьёй о субъекте.
   */
  const givenStems = [...new Set((subject.firstNames ?? []).map(norm).filter((n) => n.length >= 3))]
    .map(nameStem)
    .filter(Boolean);
  // Имени субъекта не знаем — выводить конфликт не из чего.
  if (givenStems.length === 0) return [];
  const givenBefore = new RegExp(
    `(?<!\\p{L})(?:${givenStems.map(escapeRe).join("|")})\\p{L}{0,4}\\s+$`,
    "u"
  );
  const inSubjectTriple = (at: number): boolean =>
    givenBefore.test(haystack.slice(Math.max(0, at - 24), at));

  const found = new Set<string>();
  for (const m of haystack.matchAll(PATRONYMIC_RE)) {
    const candidate = baseForm(norm(m[1] ?? ""));
    if (candidate.length <= 3 || own.has(candidate)) continue;
    const at = m.index ?? 0;
    if (nearSurname(at, candidate.length) && inSubjectTriple(at)) found.add(candidate);
  }
  for (const m of haystack.matchAll(SHORT_PATRONYMIC_RE)) {
    const candidate = norm(m[1] ?? "");
    if (!SHORT_PATRONYMICS.has(candidate) || own.has(candidate)) continue;
    const at = m.index ?? 0;
    if (nearSurname(at, candidate.length) && inSubjectTriple(at)) found.add(candidate);
  }

  /*
   * Тот же вопрос в латинице — тем же проходом, а не второй функцией.
   *
   * `PATRONYMIC_RE` кириллическое, поэтому «Anatoly **Alexandrovich** Borisov»
   * до шага 0049 конфликтом не считалось: на строках-подсказках латинское
   * отчество уже узнавалось (`foreignPatronymicsInQueryLine`), а на странице —
   * нет, и один вопрос имел два ответа в зависимости от алфавита. Замер на
   * прогоне DPA-2026-0046: восемь страниц о **других** людях («Anatoly
   * Viktorovich Borisov — ORCID», «Individual Entrepreneur Borisov Anatolii
   * Aleksandrovich») доезжали до клиента как «требует подтверждения», тогда как
   * кириллический двойник той же страницы уже получал «другое лицо».
   *
   * Ключ, порог длины и допуск «своей» формы берутся у строчного правила: это
   * один ответ на вопрос «чьё это отчество», записанный один раз.
   */
  const ownKeys = ownPatronymicForms(subject);
  const givenKeyStems = [
    ...new Set((subject.firstNames ?? []).map(norm).filter((n) => n.length >= 3)),
  ]
    .map((n) => patronymicKey(nameStem(n)))
    .filter((s) => s.length >= 3);
  if (givenKeyStems.length > 0) {
    const words = wordsWithOffsets(haystack);
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i]!;
      const candidate = patronymicKey(baseForm(word.word));
      if (candidate.length < MIN_PATRONYMIC_KEY || !PATRONYMIC_KEY_RE.test(candidate)) continue;
      if (ownKeys.some((o) => isOwnVariant(candidate, o))) continue;
      // Тройка с именем субъекта — то же условие, что у кириллического прохода:
      // без него биография, называющая родню, объявила бы чужой страницу о
      // самом субъекте (цена измерена 14.08.2026 — 26 материалов).
      const before = patronymicKey(words[i - 1]!.word);
      if (!givenKeyStems.some((s) => before.startsWith(s) && before.length <= s.length + 4)) {
        continue;
      }
      if (!nearSurname(word.at, word.word.length)) continue;
      // Начальная форма, а не написание из текста: кириллический проход уже
      // положил сюда «ахметович», и «ахметовича» было бы второй записью того же.
      found.add(baseForm(word.word));
    }
  }
  return [...found];
}

/**
 * Чужое имя внутри именной тройки — это другой человек.
 *
 * У имени нет опознаваемой формы, в отличие от отчества на «-ович/-евич»,
 * поэтому единственный признак «чужое ли оно» — **место**: между формой фамилии
 * субъекта и отчеством. Прогон DPA-2026-0046 привёл в отчёт три записи ИП
 * посторонних людей с их ИНН («IE Borisov **Ivan** Anatolevich») — у них совпали
 * фамилия и отчество, а имя не проверял никто, и вердикт был `SUBJECT_MATCH`
 * с уверенностью 0,85.
 *
 * Вне тройки правило молчит намеренно: «BATE Borisov» и «Anna Borisova» другим
 * лицом не объявляются. Позиционное правило без отчества объявило бы чужим
 * футбольный клуб, а ложная чужесть **прячет негатив клиента** — ошибка дороже
 * той, ради которой правило заводилось (опись, пункты DM и DN).
 *
 * Без структурного отчества у субъекта вывод не делается вовсе — тот же принцип,
 * что у соседних правил: молчим, а не гадаем.
 */
export function foreignGivenNamesInTriple(
  text: string,
  subject: {
    lastName: string;
    lastNameVariants?: string[];
    patronymics: string[];
    firstNames?: string[];
    aliases?: string[];
  }
): string[] {
  if (structuralPatronymicForms(subject).length === 0) return [];

  const givenKeyStems = [
    ...new Set((subject.firstNames ?? []).map(norm).filter((n) => n.length >= 3)),
  ]
    .map((n) => patronymicKey(nameStem(n)))
    .filter((s) => s.length >= 3);
  if (givenKeyStems.length === 0) return [];

  const surnameKeys = [subject.lastName, ...(subject.lastNameVariants ?? [])]
    .map((s) => patronymicKey(norm(s)))
    .filter((s) => s.length > 2);
  if (surnameKeys.length === 0) return [];

  const words = norm(text).split(/[^\p{L}]+/u).filter(Boolean);
  const keys = words.map((w) => patronymicKey(baseForm(w)));
  const isPatronymic = (k: string): boolean =>
    k.length >= MIN_PATRONYMIC_KEY && PATRONYMIC_KEY_RE.test(k);
  const isSurname = (k: string): boolean =>
    surnameKeys.some((s) => k === s || (k.startsWith(s) && k.length <= s.length + 3));
  const isOwnGiven = (k: string): boolean =>
    givenKeyStems.some((s) => k.startsWith(s) && k.length <= s.length + 4);

  /*
   * Своя тройка в тексте — правило молчит целиком.
   *
   * «Борисов Анатолий Анатольевич и Борисов Иван Анатольевич» — материал о двух
   * людях, один из которых субъект. Это не «другой человек», а неоднозначность,
   * и решает её прежняя лестница («смешанные признаки»), а не вывод об исключении.
   */
  for (let i = 1; i < keys.length; i += 1) {
    if (isPatronymic(keys[i]!) && isOwnGiven(keys[i - 1]!)) return [];
  }

  const found = new Set<string>();
  for (let i = 1; i < keys.length; i += 1) {
    if (!isPatronymic(keys[i]!)) continue;
    const given = keys[i - 1]!;
    /*
     * Инициал — не имя, и чужим он быть не может.
     *
     * Реестры ИП и судебные карточки пишут «Борисов А. Анатольевич»: сокращено
     * имя **самого** субъекта, а слот имени принимал любое слово, включая одну
     * букву, — и запись о клиенте уходила из аудита как чужая. Порог тот же,
     * что у основ имён субъекта: короче трёх букв сравнивать не с чем.
     */
    if (given.length < MIN_GIVEN_NAME_KEY) continue;
    if (isOwnGiven(given) || isSurname(given)) continue;
    // Фамилия субъекта стоит вплотную к тройке: перед именем или после
    // отчества. Без неё материал не о субъекте и не о его однофамильце —
    // приписывать ему конфликт не из чего.
    const surnameAdjacent =
      (i >= 2 && isSurname(keys[i - 2]!)) || (i + 1 < keys.length && isSurname(keys[i + 1]!));
    if (!surnameAdjacent) continue;
    found.add(words[i - 1]!);
  }
  return [...found];
}

/** Есть ли рядом с фамилией субъекта чужое отчество. */
export function hasPatronymicConflict(
  text: string,
  subject: {
    lastName: string;
    lastNameVariants?: string[];
    patronymics: string[];
    firstNames?: string[];
  }
): boolean {
  return conflictingPatronymics(text, subject).length > 0;
}

/**
 * Ключ отчества: латиница без удвоений.
 *
 * Отчество субъекта в профиле записано кириллицей («Филиппович»), а строка
 * поиска приходит латиницей («viktor filippovich»). Сравнивать их побуквенно
 * нельзя: собственное отчество объявится чужим, и **своя** негативная подсказка
 * уедет из профиля — эта ошибка хуже исходной, она прячет негатив, а не
 * завышает его. Транслитерация берётся оттуда же, откуда профиль порождает свои
 * написания. Удвоенная согласная при этом — разночтение транслитерации
 * («filippovich» / «filipovich»), а не другое отчество.
 */
function patronymicKey(word: string): string {
  return transliterateRuToLat(norm(word)).replace(/(.)\1+/gu, "$1");
}

/**
 * Окончания отчеств на ключе — общие для обоих алфавитов.
 *
 * «ович/евич/ьевич/овна/евна/ична/инична» после транслитерации дают те же
 * хвосты, что и латинские «ovich/evich/yevich/ievich/ovna/evna/yevna/ichna».
 */
const PATRONYMIC_KEY_RE = /(?:ovich|evich|ovna|evna|ichna)$/u;

/**
 * Порог длины ключа отчества.
 *
 * Отсекает короткие совпадения по окончанию. Настоящие короткие отчества в него
 * не проходят — «Львовна» даёт ключ `lvovna`, шесть букв, — и это промах в
 * дешёвую сторону: такая строка останется в счёте, тогда как ложная «чужесть»
 * прячет негатив субъекта. Понижать порог ради редкой формы значит менять
 * дешёвую ошибку на дорогую.
 */
const MIN_PATRONYMIC_KEY = 7;

/**
 * Порог длины кандидата в имя — тот же, что у основ имён субъекта.
 *
 * Короче трёх букв — инициал или обрывок, а не имя; объявлять по нему другого
 * человека значит терять записи о самом субъекте («Борисов А. Анатольевич»).
 */
const MIN_GIVEN_NAME_KEY = 3;

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

/**
 * Кандидат — вариант собственного отчества, а не чужое.
 *
 * «fyodorovich» и «fedorovich» — один человек, записанный двумя школами
 * транслитерации. Допуск сознательно асимметричен: ложная «чужесть» прячет
 * негатив субъекта, ложная «свойскость» оставляет строку в счёте — вторая
 * ошибка дешевле.
 */
function isOwnVariant(candidate: string, own: string): boolean {
  const budget = Math.max(candidate.length, own.length) >= 9 ? 2 : 1;
  return levenshtein(candidate, own) <= budget;
}

type QueryLineSubject = {
  patronymics: string[];
  /** Имена субъекта: без них связка «имя + отчество» не проверяется. */
  firstNames?: string[];
  /** Псевдонимы и транслитерации — там живёт латинская форма отчества. */
  aliases?: string[];
};

/**
 * Структурные отчества субъекта — единственный признак того, что отчество у
 * него вообще есть.
 *
 * Похожие на отчество токены алиасов этому признаку не замена: фамилия по форме
 * от отчества неотличима («Абрамович», «Рабинович», «Маркович»), и по ней
 * правило ожило бы у субъекта, отчества которого система не знает вовсе. Вывод
 * о чужом отчестве стал бы тогда догадкой — а она прячет негатив и печатает
 * клиенту утверждение, не прослеживаемое до данных.
 */
function structuralPatronymicForms(subject: QueryLineSubject): string[] {
  return subject.patronymics
    .map((p) => patronymicKey(baseForm(norm(p))))
    .filter((key) => key.length > 3);
}

/**
 * Собственные формы отчества субъекта — из одного места и в обоих алфавитах.
 *
 * Структурные `patronymics` кириллические; латинская форма приезжает внутри
 * транслитерации целой тройки («viktor filippovich rashnikov»), где раскладка
 * профиля кладёт её в имена. Ключом отчества она узнаётся по окончанию.
 *
 * Сюда же попадает фамилия-«отчество» из алиасов — и это нужно: без неё
 * «roman abramovich sanctions» объявлялось бы строкой о другом лице, потому что
 * фамилия субъекта не совпадает с его же отчеством.
 */
function ownPatronymicForms(subject: QueryLineSubject): string[] {
  const forms = new Set<string>(structuralPatronymicForms(subject));
  for (const alias of subject.aliases ?? []) {
    for (const word of norm(alias).split(/[^\p{L}]+/u)) {
      const key = patronymicKey(baseForm(word));
      if (key.length >= MIN_PATRONYMIC_KEY && PATRONYMIC_KEY_RE.test(key)) forms.add(key);
    }
  }
  return [...forms];
}

/**
 * Чужие отчества в строке-запросе.
 *
 * Правило только для поверхностей-строк: там строка и есть весь материал,
 * поэтому «имя субъекта + чужое отчество» решает вопрос принадлежности, а
 * ловушки «биография называет родню» нет по построению. На длинных текстах
 * работает `conflictingPatronymics` со своими якорями.
 *
 * Без собственного отчества вывод не делается вовсе — тот же принцип, что и
 * выше: молчим, а не гадаем.
 */
export function foreignPatronymicsInQueryLine(
  text: string,
  subject: QueryLineSubject
): string[] {
  // Нет собственного отчества — нет вывода: молчим, а не гадаем.
  if (structuralPatronymicForms(subject).length === 0) return [];

  const givenStems = [
    ...new Set((subject.firstNames ?? []).map(norm).filter((n) => n.length >= 3)),
  ]
    .map((n) => patronymicKey(nameStem(n)))
    .filter((s) => s.length >= 3);
  if (givenStems.length === 0) return [];

  const ownForms = ownPatronymicForms(subject);
  const words = norm(text).split(/[^\p{L}]+/u).filter(Boolean);
  const found = new Set<string>();
  for (let i = 1; i < words.length; i += 1) {
    const candidate = patronymicKey(baseForm(words[i]!));
    if (candidate.length < MIN_PATRONYMIC_KEY || !PATRONYMIC_KEY_RE.test(candidate)) continue;
    // Отчество считается чужим только в тройке с именем субъекта: «рашников
    // санкции» и «рашников виктор филиппович жена» правилом не задеваются.
    const before = patronymicKey(words[i - 1]!);
    const afterSubjectName = givenStems.some(
      (stem) => before.startsWith(stem) && before.length <= stem.length + 4
    );
    if (!afterSubjectName) continue;
    if (ownForms.some((o) => isOwnVariant(candidate, o))) continue;
    found.add(words[i]!);
  }
  return [...found];
}
