/**
 * Целость цитаты в клиентском тексте.
 *
 * Отчёт цитирует источники дословно. Обрывок в кавычках — уже не цитата, а наше
 * утверждение неизвестного происхождения: читатель не может ни проверить его,
 * ни понять, где кончается источник и начинаемся мы. На прогоне 14.08 на
 * странице резюме стояло `«ИП Юнусов Тимур Ильдарович зарегистрирован
 * 25.12.2008.` — без закрывающей кавычки и без источника, потому что вычистка
 * повторов сняла следующее предложение.
 *
 * Здесь собраны признаки, по которым такое видно снаружи, без знания того, кто
 * именно порезал текст. Ими пользуются и ворота сборки, и обрезка по бюджету:
 * резать можно только так, чтобы ни один признак не зажёгся.
 */

/** Кавычка-ёлочка открывающая и закрывающая. */
const OPEN = "«";
const CLOSE = "»";

/**
 * Хвост-обрывок: строка кончается предлогом или союзом.
 *
 * `\b` в JS не считает кириллицу словом, поэтому границы заданы через
 * `\p{L}` — иначе «…и», «…из-за» не находились никогда.
 */
const DANGLING_TAIL =
  /(?:^|[^\p{L}\p{N}_])(?:и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|за|к|ко|у|от|до|про|при|the|of|and|or|to|in|on|at|for|with|from|by)\s*$/iu;

/**
 * Упоминание источника рядом с цитатой.
 *
 * Форм две: «…» — источник domain.ru у тематических блоков и «…» — Ukrainska
 * Pravda у изображений, где называется издание, а не домен. Обе считаются
 * ссылкой на источник: тире с непустым хвостом после закрывающей кавычки — это
 * атрибуция по общему правилу набора. Обрезанная же цитата теряет хвост целиком,
 * и признак гаснет.
 */
function attributionFollows(tail: string): boolean {
  return /^[—–-]\s*\S+/u.test(tail.trim());
}

/**
 * Блок называет источники отдельной строкой — «Где видно: xfirm.ru.».
 *
 * Проверяется именно эта строка, а не любое тире в блоке: тире в отчёте стоит
 * едва ли не в каждом абзаце, и «источник где-то рядом» превратило бы ворота в
 * формальность.
 */
function blockNamesSources(body: string): boolean {
  return /(?:Где видно|Источник(?:и)?(?:\s+в\s+регионе)?):\s*\S+/iu.test(body);
}

/**
 * Что не так с целостью цитат в блоке. Пустой список — блок в порядке.
 *
 * Возвращает описания, а не булево: в нарушениях сборки нужно видеть, какой
 * именно признак зажёгся, иначе разбираться приходится по самому тексту.
 */
export function quoteIntegrityProblems(bullet: string): string[] {
  const problems: string[] = [];
  const body = bullet.replace(/\s*(\[finding-[^\]]*\]\s*)+$/u, "").trim();
  if (!body) return problems;

  const opens = (body.match(new RegExp(OPEN, "gu")) ?? []).length;
  const closes = (body.match(new RegExp(CLOSE, "gu")) ?? []).length;
  if (opens !== closes) {
    problems.push(`unclosed quote (${opens}«/${closes}»): ${short(body)}`);
  }

  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, index) => {
    // Первая строка блока — название темы в кавычках, иногда с продолжением на
    // той же строке («Биографический профиль» найдены 2 результата…). Это наше
    // слово, а не чужое, и источника у него не бывает. Отличается название не
    // длиной, а местом: попытка различать по длине пропускала цитату в
    // семьдесят шесть символов.
    if (index === 0) return;
    if (!line.startsWith(OPEN)) return;
    /*
     * Закрывающая кавычка цитаты — последняя в строке, а не первая.
     *
     * Внутри цитаты бывают свои кавычки: «Усманов подал иск в связи с
     * «политически мотивированными» расследованиями» — источник iz.ru. По
     * первой ёлочке хвостом оказывалось «расследованиями…», источник за ним не
     * виден, и ворота объявляли цитату безымянной. На прогоне 72 это дало
     * ложное нарушение.
     */
    const closing = line.lastIndexOf(CLOSE);
    if (closing <= 0) return; // уже посчитано незакрытой кавычкой
    const tail = line.slice(closing + 1).trim();
    if (attributionFollows(tail) || blockNamesSources(body)) return;
    problems.push(`quote without a source: ${short(line)}`);
  });

  const last = lines[lines.length - 1] ?? "";
  if (DANGLING_TAIL.test(last)) {
    problems.push(`block ends mid-phrase: ${short(last)}`);
  }
  return problems;
}

/**
 * Укоротить строку с цитатой, не разрушив её.
 *
 * Обычная обрезка режет строку по последнему пробелу и выбрасывает всё, что за
 * ним, — вместе с закрывающей кавычкой и с «— источник xfirm.ru». Получается
 * утверждение без происхождения, и проверить его читатель уже не может.
 *
 * Здесь режется только содержимое кавычек, по границе слова, а многоточие
 * ставится внутри них: сокращение видно, но видно и то, что это по-прежнему
 * чужие слова. Атрибуция за кавычками сохраняется целиком — на неё бюджет
 * резервируется до того, как считается место под текст.
 *
 * Возвращает `undefined`, если строка не похожа на цитату: тогда работает
 * обычная обрезка вызывающей стороны.
 */
export function clampQuotedLine(line: string, max: number): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(OPEN)) return undefined;
  /*
   * Работает только со строкой-цитатой, а не с блоком, который с кавычки
   * начинается.
   *
   * Блок темы начинается с названия в кавычках, и на эталонном кейсе правило
   * приняло его за одну огромную цитату: резало по последней кавычке блока и
   * оставляло посреди страницы обрывок «…» — источник stockholm-kuriren.se» —
   * без начала и без смысла. Признаки строки: она одна и в ней одна атрибуция.
   */
  if (trimmed.includes("\n")) return undefined;
  if ((trimmed.match(/»\s*[—–-]\s*\S/gu) ?? []).length > 1) return undefined;
  const closing = trimmed.lastIndexOf(CLOSE);
  if (closing <= 0) return undefined;
  if (trimmed.length <= max) return trimmed;

  const quoted = trimmed.slice(1, closing);
  const tail = trimmed.slice(closing + 1);
  // «…» плюс атрибуция — то, что обязано уместиться в любом случае.
  const overhead = 3 + tail.length;
  const room = max - overhead;
  // Меньше десяти символов под цитату — сокращать нечего, такую строку
  // сокращать нельзя: остаётся обрывок без смысла.
  if (room < 10) return undefined;

  let body = quoted.slice(0, room);
  const lastSpace = body.lastIndexOf(" ");
  if (lastSpace > 0) body = body.slice(0, lastSpace);
  body = body.replace(/[\s;,:—–-]+$/u, "");
  if (!body) return undefined;
  return `${OPEN}${body}…${CLOSE}${tail}`;
}

/**
 * Закрыть кавычку, если обрезка оставила её открытой.
 *
 * Предохранитель на случай, когда режет не наш код: многоточие внутри кавычек
 * честнее висящей открывающей ёлочки.
 */
export function closeDanglingQuote(text: string): string {
  const opens = (text.match(new RegExp(OPEN, "gu")) ?? []).length;
  const closes = (text.match(new RegExp(CLOSE, "gu")) ?? []).length;
  if (opens <= closes) return text;
  const trimmed = text.replace(/[\s;,:—–-]+$/u, "");
  return `${trimmed}…${CLOSE.repeat(opens - closes)}`;
}

function short(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}
