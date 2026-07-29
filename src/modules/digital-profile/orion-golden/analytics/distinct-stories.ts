/**
 * Разные ли это сюжеты.
 *
 * Вопрос один — «одна публикация или две», — и отвечать на него должно одно
 * место. Живут эти правила в слое аналитики, потому что зовут их и построители
 * деки, и синтез находок; обратное направление импорта дало бы цикл.
 */

/**
 * Отпечаток заголовка: сам сюжет, без хвоста площадки.
 *
 * Издания дописывают к заголовку название раздела и сайта через «•», а
 * мобильные зеркала — ещё и «Версия для печати». Сравнивать надо то, что
 * читатель воспринимает как сюжет, то есть часть до первого разделителя.
 */
export function titleFingerprint(title: string): string {
  return String(title ?? "")
    .split(/[•|]/u)[0]!
    .replace(/[«»"'`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Выбрать до `limit` заголовков про **разные** сюжеты.
 *
 * Прежде брались просто два лучших по счёту (`slice(0, 2)`), и один сюжет
 * попадал в блок дважды. На эталонной деке так вышло трижды:
 *
 *   · sledst.org и m.sledst.org — мобильное зеркало того же издания, причём
 *     во втором заголовке хвост «• Версия для печати»;
 *   · repost.news и rumafia.io — перепечатка с тем же заголовком слово в слово.
 *
 * Для отчёта, который показывают банку, это не мелочь: одна публикация
 * выглядит как два независимых свидетельства. Читатель при этом видит одно и
 * то же предложение подряд — самый заметный признак выгрузки.
 *
 * Ширина охвата не теряется: домены обоих источников по-прежнему называет
 * строка «Где видно».
 */
/**
 * Насколько длинным должно быть общее начало, чтобы считать сюжет тем же.
 * Имя субъекта встречается почти в каждом заголовке темы — по такому
 * совпадению склеивать материалы нельзя.
 */
const MIN_STORY_OVERLAP = 40;

/** Домен без регистра и ведущего `www.`; пустая строка, если его нет. */
function normalizeDomain(domain: string | null | undefined): string {
  return String(domain ?? "").trim().toLowerCase().replace(/^www\./u, "");
}

export function pickDistinctTitles<T extends { title: string; domain?: string | null }>(
  candidates: readonly T[],
  limit: number
): T[] {
  const picked: T[] = [];
  const seen: Array<{ fp: string; domain: string }> = [];
  for (const c of candidates) {
    if (picked.length >= limit) break;
    const fp = titleFingerprint(c.title);
    if (!fp) continue;
    // Один сюжет — если отпечатки совпали или один целиком начинает другой:
    // площадки обрезают длинные заголовки по-разному.
    const domain = normalizeDomain((c as { domain?: string | null }).domain);
    const duplicate = seen.some((prev) => {
      if (prev.fp === fp) return true;
      const long = prev.fp.length >= fp.length ? prev.fp : fp;
      const short = prev.fp.length >= fp.length ? fp : prev.fp;
      if (short.length < MIN_STORY_OVERLAP) return false;
      // Обрезка заголовка площадкой: один начинает другой.
      if (long.startsWith(short)) return true;
      // Один издатель, и длинный заголовок содержит короткий целиком: это тот
      // же материал с приписанной рубрикой или именем площадки. У разных
      // издателей так решать нельзя — там это может быть свой материал.
      return Boolean(domain) && prev.domain === domain && long.includes(short);
    });
    if (duplicate) continue;
    seen.push({ fp, domain });
    picked.push(c);
  }
  return picked;
}

