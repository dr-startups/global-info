/**
 * REMEDIATION §3.1 — finding themes and reliability dictionaries as config.
 *
 * Defaults live here (universal, not case-tuned). Optional override:
 *   <storageRoot>/config/finding-themes.json
 * Regex sources are validated with `new RegExp` at load (fail-fast).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RiskLevel } from "../orion-golden/contracts/common";

export type ThemeDef = {
  themeId: string;
  label: string;
  keywords: RegExp;
  /**
   * Площадки темы — отдельный ответ, как `ADVERSE_DOMAIN_RE` у предиката строки.
   *
   * Список читает адрес целиком, словарь темы адреса не читает вовсе. Пока
   * доменные слова (`opencorporates`, `rupep`, `sledstvie`) стояли в общем
   * словаре, а сверка шла по склейке с `sourceUrl`, раздел сайта в пути читался
   * как текст публикации: у словаря есть левая граница, и `…/court/…`
   * совпадало с `court` при нейтральном заголовке.
   *
   * Темы без своих площадок это поле не заводят.
   */
  domains: RegExp | null;
  baseRisk: RiskLevel;
  recommendedAction: string;
  /**
   * Тема обвиняет или описывает — см. `isAccusingTheme`. Поле обязательное:
   * умолчание подставляет схема при чтении каталога, а дальше значение есть
   * всегда.
   */
  accusing: boolean;
};

const RiskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);

const ThemeDefJsonSchema = z.object({
  themeId: z.string().min(1),
  label: z.string().min(1),
  /** RegExp source (without slashes). */
  keywords: z.string().min(1),
  /** Необязательно: площадки темы, если они у неё есть. */
  domains: z.string().min(1).optional(),
  flags: z.string().default("iu"),
  baseRisk: RiskLevelSchema,
  recommendedAction: z.string().min(1),
  /**
   * Обвиняет ли тема. Умолчание строгое: тема, про которую каталог молчит
   * (в том числе заведённая файлом переопределения), считается обвиняющей.
   *
   * Это **единственное** умолчание поля, и убрать его нельзя: файлы
   * переопределения, написанные до появления признака, поля не несут вовсе —
   * без умолчания схема отказывает им целиком, а не одному признаку.
   */
  accusing: z.boolean().default(true),
});

export const FindingThemesConfigJsonSchema = z.object({
  version: z.literal("finding-themes-v1"),
  themes: z.array(ThemeDefJsonSchema).min(1),
  adversePatterns: z.string().min(1),
  /** Необязательно: старый файл переопределения читается как «нет подмножества». */
  strongAdversePatterns: z.string().min(1).optional(),
  strongAdverseFlags: z.string().optional(),
  adverseFlags: z.string().default("iu"),
  unverifiedDomains: z.string().min(1),
  unverifiedDomainsFlags: z.string().default("iu"),
  authoritativeDomains: z.string().min(1),
  authoritativeDomainsFlags: z.string().default("iu"),
  reputableDomains: z.string().min(1),
  reputableDomainsFlags: z.string().default("iu"),
  /** Optional extras used by the synthesizer (claim quality heuristics). */
  unverifiedClaimPatterns: z.string().optional(),
  unverifiedClaimFlags: z.string().default("iu"),
  positivePatterns: z.string().optional(),
  positiveFlags: z.string().default("iu"),
  assertionPatterns: z.string().optional(),
  assertionFlags: z.string().default("iu"),
  denialPatterns: z.string().optional(),
  denialFlags: z.string().default("iu"),
});

export type FindingThemesConfigJson = z.infer<typeof FindingThemesConfigJsonSchema>;

export type CompiledFindingThemesConfig = {
  version: "finding-themes-v1";
  source: "default" | "override";
  overridePath: string | null;
  themes: ThemeDef[];
  adversePatterns: RegExp;
  /** Подмножество `adversePatterns`, работающее и на мягких площадках. */
  strongAdversePatterns: RegExp;
  unverifiedDomains: RegExp;
  authoritativeDomains: RegExp;
  reputableDomains: RegExp;
  unverifiedClaimPatterns: RegExp;
  positivePatterns: RegExp;
  assertionPatterns: RegExp;
  denialPatterns: RegExp;
};

export class FindingThemesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingThemesConfigError";
  }
}

function compileRegex(source: string, flags: string, label: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new FindingThemesConfigError(
      `invalid regex ${label}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Ключевое слово темы совпадает с началом слова, а не с любой его серединой.
 *
 * Слова тем заданы основами: «уголов», «суд», «минист». Без границы слева
 * «суд» находился внутри «го-**суд**-арственной», и любая биография с
 * упоминанием Государственной думы становилась «криминальными и судебными
 * материалами»; «минист» находился внутри «ад-**минист**-рация». На разборе
 * живого прогона так набралось 27 материалов по криминальной теме, среди
 * которых не было ни одного судебного сюжета — зато были «Структура | Совет
 * Федерации» и «20 самых богатых людей России».
 *
 * `\b` здесь бесполезен: в JavaScript он определён на латинице и кириллицу не
 * видит. Поэтому граница задаётся просмотром назад по букве.
 */
function withWordStart(source: string): string {
  return `(?<!\\p{L})(?:${source})`;
}

/** Просмотр назад по букве требует режима Unicode. */
function withUnicode(flags: string): string {
  return flags.includes("u") ? flags : `${flags}u`;
}

/**
 * Верхнеуровневые альтернативы выражения — по одной на слово словаря.
 *
 * `split("|")` не годится: у словаря есть альтернативы внутри групп
 * (`побо(?:и|ев|ям|ями|ях)`, `долг(?:а|ам|…)`) и внутри классов (`снят[оы]`),
 * и наивное деление разрезало бы их пополам, а сравнение списков после этого
 * отвечало бы не на тот вопрос.
 */
function topLevelAlternatives(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "\\") {
      current += ch + (source[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      current += ch;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "|" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter((alt) => alt.length > 0);
}

/** Гласные обеих письменностей: по ним слово отличается от сокращения. */
const VOWEL_LETTERS = /[аеёиоуыэюяaeiou]/iu;

/**
 * Буквы, которые альтернатива **сопоставляет**, и закрыта ли она справа.
 *
 * Просмотры (вперёд и назад) в буквы не идут: они ограничивают совпадение, а не
 * образуют его, — иначе `владел(?!\p{L}{0,5}-бенефициар)` читалось бы как слово
 * с гласными из своей же оговорки. Закрытием считается только просмотр вперёд и
 * только последним знаком альтернативы.
 *
 * **`\b` закрытием не считается намеренно.** Граница слова в JavaScript
 * определена на ASCII: после «У», «Н», «Б» она не срабатывает никогда, поэтому
 * `ГРУ\b` не совпадает даже с самим «ГРУ» — словарь молча умирает целиком. У
 * латиницы дыра обратная: в «FSBа» с кириллической «а» граница есть, и `FSB\b`
 * совпадает ровно с тем словом, ради которого правило заведено. Пока `\b`
 * считался закрытием, правило выдавало зелёный свет обеим записям — то есть
 * лицензию на дефект того же класса, от которого оно защищает.
 */
function readAlternative(alt: string): { letters: string; closedOnTheRight: boolean } {
  let letters = "";
  let closed = false;
  let i = 0;
  while (i < alt.length) {
    const ch = alt[i]!;
    if (ch === "\\") {
      const next = alt[i + 1] ?? "";
      // `\p{…}` и `\P{…}` съедают фигурные скобки целиком, иначе `p` и `L`
      // попали бы в буквы слова.
      if (next === "p" || next === "P") {
        const end = alt.indexOf("}", i);
        i = end === -1 ? alt.length : end + 1;
      } else {
        i += 2;
      }
      closed = false;
      continue;
    }
    if (ch === "[") {
      const end = classEnd(alt, i);
      letters += readAlternative(alt.slice(i + 1, end)).letters;
      closed = false;
      i = end + 1;
      continue;
    }
    if (ch === "(") {
      const end = groupEnd(alt, i);
      const lookahead = alt.startsWith("(?!", i) || alt.startsWith("(?=", i);
      const lookbehind = alt.startsWith("(?<", i);
      if (!lookahead && !lookbehind) {
        letters += readAlternative(alt.slice(i + 1, end)).letters;
      }
      closed = lookahead;
      i = end + 1;
      continue;
    }
    // Квантификаторы прозрачны в обеих записях: ни `(?:а|е)?`, ни `оф{1,2}шор`
    // не отменяют того, чем кончилась альтернатива.
    if (ch === "?" || ch === "*" || ch === "+") {
      i += 1;
      continue;
    }
    if (ch === "{") {
      const end = alt.indexOf("}", i);
      i = end === -1 ? alt.length : end + 1;
      continue;
    }
    if (/\p{L}/u.test(ch)) letters += ch;
    closed = false;
    i += 1;
  }
  return { letters, closedOnTheRight: closed };
}

function classEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === "]") return i;
  }
  return source.length;
}

function groupEnd(source: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") inClass = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * Сокращение опознаётся по тому, что видно в самом исходнике: **запись
 * прописными** (`ФСБ`, `ФСИН`, `IBA`, `ЦУПИС`) или **отсутствие гласных**
 * (`ФСБ`, `МЧС`, `fsb`, `bvi`).
 */
function looksLikeAbbreviation(letters: string): boolean {
  if (letters.length < 2) return false;
  const allUpperCase = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  return allUpperCase || !VOWEL_LETTERS.test(letters);
}

/**
 * Слова словаря, которые выглядят сокращением и не закрыты справа.
 *
 * «Закрыта справа» определено **синтаксически**, и цена этого названа: правило
 * не разбирает, что именно стоит в просмотре вперёд, поэтому `ФСБ(?=\p{L})`
 * оно считает закрытым — а совпадает такая запись ровно с «ФСБР». Разбирать
 * содержимое просмотра значило бы писать второй движок регулярных выражений;
 * от очевидной ошибки («забыл границу») правило защищает, от вывернутой
 * наизнанку — нет, и в ревью это читается глазами.
 *
 * Цена вопроса названа прямо: «ФСБР» — Федерация спортивной борьбы России —
 * два отчёта подряд печаталась клиенту темой «Внимание по линии безопасности /
 * оборонный контур» высокого уровня и красилась негативом, потому что основа
 * `фсб` стояла без правой границы. Расшифровку сокращения печатал тот же
 * документ страницей ниже.
 *
 * Правило узкое намеренно. Универсальная правая граница у всех слов отвергнута
 * замером: `сын(?!\p{L})` теряет «сына», `fraud(?!\p{L})` — «fraudulent»,
 * `биограф(?!\p{L})` — «биографию» на 106 материалах живого прогона. Русская
 * основа обязана расти, сокращение — нет, и здесь берётся ровно тот подкласс,
 * где закрытие ничего не стоит.
 *
 * Чего правило не умеет, сказано вслух: «фсин», записанное строчными, оно не
 * поймает — гласная в нём есть. Держится это тем, что аббревиатуры пишут
 * прописными, и в диффе это видно.
 *
 * Возвращается **список слов**, а не «да/нет»: отказ конфигурации обязан
 * называть слова, иначе его нечем чинить.
 */
export function unclosedAbbreviations(source: string): string[] {
  return topLevelAlternatives(source).filter((alt) => {
    const { letters, closedOnTheRight } = readAlternative(alt);
    return looksLikeAbbreviation(letters) && !closedOnTheRight;
  });
}

/**
 * Сильный словарь как подмножество общего — вычисленное, а не обещанное.
 *
 * Правило («слово, краснящее мягкую площадку, обязано краснить и обычную») до
 * сих пор жило одним комментарием, и нарушить его можно было одной строкой в
 * файле переопределения: тогда пост в соцсети получал рамку по слову, от
 * которого страница обычного издания оставалась чистой.
 *
 * Два случая разведены намеренно. Файл, который **назвал** сильные слова сам,
 * отвергается с перечислением лишних: это его ошибка, и молча её исправлять
 * значило бы печатать не тот словарь, который написан. Файл, который сильных
 * слов не называл, наследует умолчание — но суженное до того, что знает его
 * собственный общий словарь: так `finding-themes.example.json` со своим
 * коротким `adversePatterns` продолжает компилироваться и при этом не краснит
 * мягкую площадку словом «arrest», которого его общий словарь не знает.
 */
function strongSubsetOfAdverse(
  adverseSource: string,
  strongSource: string,
  strongWasSupplied: boolean
): string {
  const general = new Set(topLevelAlternatives(adverseSource));
  const strong = topLevelAlternatives(strongSource);
  const outside = strong.filter((alt) => !general.has(alt));
  if (strongWasSupplied && outside.length > 0) {
    throw new FindingThemesConfigError(
      `strongAdversePatterns не подмножество adversePatterns: вне общего словаря ${outside.join(", ")}`
    );
  }
  const inside = strong.filter((alt) => general.has(alt));
  if (inside.length === 0) {
    // Пустое выражение совпадает с любой строкой — мягкие площадки покраснели
    // бы целиком. Такой файл чинит человек, а не умолчание.
    throw new FindingThemesConfigError(
      "strongAdversePatterns пуст: adversePatterns не знает ни одного сильного слова"
    );
  }
  return inside.join("|");
}

/**
 * Судебные формы слова «суд» — вместо корня со списком исключений.
 *
 * `суд(?!острое|ьб)` закрывал ровно два слова семейства, и список приходилось
 * дополнять на каждой находке: «судмедэксперт», «судоходство», «судоверфь»,
 * «судовладелец», «судак» проходили. «Судмедэксперт дал заключение о причине
 * смерти» получало и метку негатива, и криминальную тему — ложная метка на
 * нейтральном материале. Отчёт читает сам субъект, и ему предлагали убирать
 * то, что его не порочит.
 *
 * Поэтому корень задан не тем, чем он не является, а тем, что означает:
 * падежами самого слова (правая граница обязательна — левую всему словарю
 * ставит `withWordStart`) и судебными основами. Следующее слово на «судо-»
 * вписывать сюда не придётся: оно не совпадает, не будучи названным.
 *
 * Так же устроен `canonical-themes.ts` — там судебные формы перечислены с
 * обеих сторон границами. Одно семейство слов на два места здесь: тема
 * `criminal_legal` и словарь негатива отвечают на разные вопросы, но ловят
 * одни и те же слова, и разойтись им нельзя — иначе «судмедэксперт» уходит из
 * метки и остаётся в теме, на той же странице у того же читателя.
 *
 * Цена названа прямо. Перестали совпадать «судейство» и «судейский» (у
 * боксёрского субъекта это чаще ринг, чем коллегия), «судить» и «судил» в
 * значении «полагать» и «вести матч» — из глагола осталось только возвратное
 * «судится», которое значит тяжбу и ничего больше; ушли и редкие
 * «судоустройство», «судоговорение». Само «судей» осталось: его от «судейства»
 * отделяет та же правая граница, а не новое исключение.
 * «Подсудимый» и «осуждён» не совпадали и до правки: их снимает левая граница,
 * без которой «государственной» снова делает биографию криминальным
 * материалом. А формы «суда», «судов», «судам» общие у суда с судном —
 * «морские суда» совпадают и здесь, и раньше; различает их только смысл.
 */
const COURT_WORD_FORMS =
  "суд(?:а|е|у|ы|ов|ом|ам|ах|ами|ей)?(?!\\p{L})|судебн|судь[яеиюё]|судим(?:ост|[аоые])|" +
  "судопроизводств|суд(?:и|я)(?:тся|ться|л[аи]?с[ья])";

/**
 * Сокращение спецслужбы — прописными и с правой границей.
 *
 * Прописные несут смысл и для читателя, и для проверки: так пишут сокращение, а
 * не основу, и `unclosedAbbreviations` опознаёт его по этой записи. Флаг `i` у
 * всех словарей стоит, поэтому на совпадение регистр не влияет.
 *
 * Правая граница обязательна: без неё «ФСБР» — Федерация спортивной борьбы
 * России — становилась оборонным контуром высокого уровня, а её материалы ещё и
 * краснели негативом. У латинской формы граница пишется просмотром по букве, а
 * **не** `\b`: в JavaScript граница слова определена на ASCII, и в «FSBа» с
 * кириллической «а» она срабатывает — совпадение прошло бы.
 *
 * Слово стоит в двух словарях сразу (тема и метка негатива) и вынесено сюда по
 * той же причине, что и `COURT_WORD_FORMS`: словари отвечают на разные вопросы,
 * но ловят одно семейство слов, и разойтись им нельзя.
 */
const FSB_ABBREVIATION = "ФСБ(?!\\p{L})|FSB(?!\\p{L})";

/** Universal default theme set — no case-specific «транспортный контур» tuning. */
export function getDefaultFindingThemesConfigJson(): FindingThemesConfigJson {
  return {
    version: "finding-themes-v1",
    themes: [
      {
        themeId: "security_scrutiny",
        accusing: true,
        label: "Внимание по линии безопасности / оборонный контур",
        keywords:
          "оборон|defen[cs]e|national security|спецслужб|" +
          FSB_ABBREVIATION +
          "|безопасн\\w* служб|security service",
        flags: "iu",
        baseRisk: "high",
        recommendedAction:
          "Сверить публикации с первоисточниками, подготовить документированную позицию и план ответов на запросы контрагентов; при недостоверности — инициировать опровержение или удаление у площадок.",
      },
      {
        themeId: "criminal_legal",
        accusing: true,
        label: "Криминальные / судебные материалы",
        keywords:
          "уголов|criminal|арест|arrest|обыск|розыск|прокур|следств|компромат|court|" +
          COURT_WORD_FORMS,
        domains: "sledstvie|rucriminal",
        flags: "iu",
        baseRisk: "high",
        recommendedAction:
          "Проверить актуальные статусы дел по картотекам судов и официальным источникам; собрать документы о прекращении/исходе; недостоверные публикации — вытеснять из топ-20 официальными материалами и добиваться удаления на агрегаторах.",
      },
      {
        themeId: "pep_rca_watchlist",
        accusing: true,
        label: "PEP / RCA / watchlist-сигналы",
        keywords: "\\bpep\\b|\\brca\\b|watch.?list|санкц|sanction|комплаенс|compliance",
        domains: "world.?check|dow.?jones|lexis|rupep",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Запросить первичные карточки комплаенс-баз, подтвердить или опровергнуть принадлежность каждого совпадения; для ложных совпадений — направить запрос на корректировку записи у оператора базы.",
      },
      {
        themeId: "political_exposure",
        label: "Политические связи / публичная экспозиция",
        // Публичная должность и связи — то, что описывают, а не в чём обвиняют:
        // нейтрально прочитанная публикация здесь законное доказательство темы.
        accusing: false,
        keywords:
          "полит|politic|депутат|парти|выбор|electoral|минист|правительств|govern|парламент|parliament",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Зафиксировать фактическую хронологию публичных должностей и связей, подготовить согласованную позицию для СМИ и комплаенс-запросов банков и партнёров.",
      },
      {
        themeId: "offshore_structures",
        accusing: true,
        label: "Офшорные структуры",
        keywords: "офшор|offshore|кипр|cyprus|\\bbvi\\b|панам|panama",
        domains: "opencorporates",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Подготовить документальное подтверждение структуры владения и источников средств по офшорным юрисдикциям — именно его запрашивают при KYC; неточные публикации оспаривать у площадок.",
      },
      {
        themeId: "corporate_ownership",
        // Покупка компании — то, что описывают, а не то, в чём обвиняют.
        // Слово «владел» стояло в одной теме с офшором, и «стал владельцем
        // "Рольфа"» выходило к читателю обвинением среднего уровня под ярлыком,
        // обещающим офшор, — при том что ни один источник об офшоре не говорил.
        accusing: false,
        label: "Корпоративное владение",
        // «Бенефициар» и `beneficial ownership` — сведения о владении, а не о
        // юрисдикции: раскрытие бенефициара это подача документов, офшор — это
        // где зарегистрирована структура. Пока слово стояло у офшорной темы,
        // карточка государственного реестра застройщиков («ИНН. Гражданство.
        // Российская Федерация. Бенефициар. …») выходила клиенту «Офшорными
        // структурами» среднего уровня с советом подтвердить экономическую цель
        // структур — при том что об офшоре не говорил ни один источник.
        //
        // Тот же ответ дают два других каталога проекта: `canonical-themes.ts`
        // относит термин к деловым связям и владению, `benchmark-trace.ts` — к
        // корпоративному владению. Оговорка вокруг `владел`, разводившая две
        // темы на одном термине, снята вместе с причиной: тем больше не две.
        keywords: "владел|ownership|бенефициар|beneficia",
        flags: "iu",
        baseRisk: "low",
        recommendedAction:
          "Сверить состав долей и историю сделок с корпоративными реестрами и держать подтверждающие документы наготове: их запрашивают в обычной проверке, а не как претензию.",
      },
      {
        themeId: "family_associates",
        accusing: true,
        label: "Семья и деловые связи",
        keywords:
          "жена|супруг|spouse|дети|сын|дочь|партнер|associate|соучредител|co-?founder",
        flags: "iu",
        baseRisk: "low",
        recommendedAction:
          "Собрать документальные подтверждения по активам и связям; отслеживать, чтобы негатив в адрес связанных лиц не переносился на профиль субъекта в выдаче.",
      },
      {
        themeId: "financial_claims",
        accusing: true,
        label: "Финансовые претензии / долговые споры",
        keywords:
          "банкрот|bankrupt|долг(?:а|ам|ами|ах|и|ов|у)?(?!\\p{L})|задолженност|debt|взыскан|неисполнен|lawsuit|претенз|арбитражн\\w* иск|неплатеж",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Сверить претензии с судебными и реестровыми источниками, подготовить документы о статусе обязательств для банков и партнёров.",
      },
      {
        themeId: "business_profile",
        label: "Деловой профиль",
        accusing: false,
        // Industry terms stay here as a soft universal bucket; override JSON can
        // move them into a dedicated industry_contour theme when needed.
        keywords:
          "бизнесмен|businessman|предпринимател|инвестор|investor|биограф|biography|логистик|logistics|транспорт|transport|девелоп",
        // Forbes — имя площадки, а не слово текста: деловым профиль делает то,
        // что публикация вышла там, и отвечать за это должен список площадок.
        domains: "forbes",
        flags: "iu",
        baseRisk: "none",
        recommendedAction:
          "Поддерживать и усиливать позитивный деловой контент (профили, интервью, официальные сайты): он закрепляет верхние позиции выдачи и вытесняет потенциальный негатив.",
      },
    ],
    adversePatterns:
      // `court(?!s)` — «courts» в английском чаще глагол «обхаживает», чем
      // множественное число суда: «Anders Holmström courts Gulf family offices»
      // печаталось клиенту как «Криминальные / судебные материалы». У словаря
      // есть левая граница, и для латинских слов её одной мало: русские основы
      // наращиваются («прокур» → «прокуратура»), английские — нет. Правая
      // граница у семейства «суд» всё-таки есть, и почему — в
      // `COURT_WORD_FORMS`.
      // «криминал» — русское слово, и латинское `criminal` его не ловит: в
      // подсказках Яндекса «кремлев … криминал» шла нейтральной строкой рядом
      // с красной «судимости» (решение владельца 03.09.2026).
      "санкц|sanction|watch.?list|уголов|criminal|криминал|арест|arrest|court(?!s)|прокур|мошенн|fraud|коррупц|corrupt|отмыв|launder|обыск|розыск|компромат|скандал|расследован|investigat|adverse|безопасн.*служб|спецслужб|security service|national security|" +
      FSB_ABBREVIATION +
      "|" +
      COURT_WORD_FORMS +
      "|" +
      /*
       * Обвинение — второй способ рассказать тот же сюжет, и словарь его не знал.
       *
       * «Сульянов обвинил Кремлева в нападении» и «Умар Кремлев обвинен в
       * избиении на Красной площади» — одно событие в двух подачах, и обе строки
       * сходились на «Не проверено»: ни «обвин», ни «нападени», ни «избие» в
       * словаре не было. `prosecut` и `whistleblow` — та же дыра с другой
       * стороны: по-русски «прокур» здесь стоит с самого начала, латинского
       * не было, и «Prosecutors request documents from …» проходило молча.
       *
       * Правая граница ставится там, где корень попадается в чужом слове:
       * «побои» без неё ловит «поборника», «насил» — наречие «насилу». Основа
       * `избие` (а не `изби`) по той же причине: «избирательная комиссия».
       *
       * «Насильно» из `насил` **не** исключено, и это решение, а не недосмотр:
       * «насильно удерживали» и «насильно вывезли» в заголовках встречаются
       * чаще пословицы «насильно мил не будешь». Цена — пословица краснеет, и
       * на мягкой площадке тоже: корень входит в сильное подмножество.
       */
      "обвин|нападени|избие|побо(?:и|ев|ям|ями|ях)(?!\\p{L})|насил(?!у(?!\\p{L}))|prosecut|whistleblow|" +
      /*
       * Категории комплаенс-скрининга и метаслова — сигнал, но не обвинение.
       *
       * `pep`, `rca`, `ofac` называют **категорию проверки**, а не поступок:
       * попасть в список политически значимых лиц можно родством. Поэтому в
       * сильное подмножество они не входят (на карточке реестра это рубрика
       * страницы, а не сигнал о человеке), а строку выдачи объясняет клиенту
       * рубрика справочника — «Сигналы PEP / RCA», — и правило «совпадение по
       * комплаенсу не подтверждается автоматически» остаётся в силе.
       *
       * Латинские корни здесь пишутся `pep(?!\p{L})`, а **не** `\bpep\b`: в
       * JavaScript граница слова определена на ASCII, и в «pepа» с кириллической
       * «а» она срабатывает — совпадение прошло бы.
       *
       * Цена этой защиты названа целиком: краснит **любой самостоятельный
       * токен** такого написания, в каком бы смысле он ни стоял, — «Pep
       * Guardiola visits Moscow», «RCA (root cause analysis) completed by the
       * auditor», «Offshore development centre opened in Minsk». Сузить это
       * границей нельзя, различает только смысл: снимают прочитанная страница
       * и правка аналитика.
       *
       * Раскрытия бенефициара здесь нет ни в одной из двух форм: это подача
       * документов, а не сигнал, и субъекту предлагалось бы убирать собственное
       * раскрытие. Английская форма не добавлялась никогда — её красноту было на
       * чём померить (золотой кейс англоязычный). Русская прожила дольше ровно
       * потому, что мерить её было негде; замер по реестру наблюдений живого
       * прогона дал восемь материалов, включая карточку государственного реестра
       * застройщиков. Обе формы остаются ключевыми словами темы владения, где
       * вопрос другой — классификация.
       */
      "ofac(?!\\p{L})|pep(?!\\p{L})|rca(?!\\p{L})|lawsuit|offshore|оф{1,2}шор|нежелат|негативн|undesirable",
    adverseFlags: "iu",
    /*
     * Слова, которые краснят строку даже на мягкой площадке.
     *
     * Мягкие площадки (биографии, реестры, энциклопедии, соцсети) словарём не
     * судятся: «скандалы» в оглавлении статьи — жанр, а не сигнал. Но пост в X
     * «Уголовное дело против …» рамку получить обязан, иначе площадка слепа
     * целиком. Это **подмножество** `adversePatterns`, а не второй словарь:
     * слово, краснящее мягкую площадку, обязано краснить и обычную. Подмножество
     * проверяется при компиляции, а не обещано этим комментарием.
     *
     * Из обвинительных слов сюда идёт только происшествие: избиение, нападение,
     * побои, насилие. `обвин` остаётся вне — в оглавлении справочной страницы
     * («биография, бизнес, обвинения») это рубрика раздела, и оба заголовка
     * замечания владельца всё равно краснят мягкую площадку по слову
     * происшествия. Категории комплаенса (`pep`, `rca`, `ofac`, `offshore`) и
     * метаслова (`нежелат`, `негативн`) сюда не идут по той же причине.
     */
    strongAdversePatterns:
      "санкц|sanction|уголов|criminal|арест|arrest|мошенн|fraud|коррупц|corrupt|компромат|" +
      "нападени|избие|побо(?:и|ев|ям|ями|ях)(?!\\p{L})|насил(?!у(?!\\p{L}))",
    strongAdverseFlags: "iu",
    unverifiedDomains: "rucriminal|sledstvie|compromat|kompromat",
    unverifiedDomainsFlags: "iu",
    authoritativeDomains: "\\.gov|nalog\\.ru|kad\\.arbitr|wikipedia\\.org",
    authoritativeDomainsFlags: "iu",
    reputableDomains: "forbes|rbc\\.ru|vedomosti|kommersant|tadviser|interfax",
    reputableDomainsFlags: "iu",
    unverifiedClaimPatterns:
      "not verified|potential match|requires analyst review|предварительн|не подтвержд|potential\\s+\\w+\\s+in",
    unverifiedClaimFlags: "iu",
    positivePatterns:
      "биограф|biography|pioneer|интервью|interview|эксперт|expert|forbes|достижени",
    positiveFlags: "iu",
    assertionPatterns: "подтвержден|подтверждено|confirmed|установлен[оа]?(?!\\p{L})|введены",
    assertionFlags: "iu",
    /*
     * Слова опровержения. Список читают двое, и это одна причина на две
     * поверхности: `detectContradictions` находит по нему источники, спорящие
     * по существу, а `negated-dictionary-hit.ts` снимает по нему совпадение
     * словаря, стоящее рядом. Поэтому формы здесь — те, которыми опровержение
     * записывают в заголовке: «обвинения не подтвердились», «претензии сняты»,
     * «дело прекращено», «суд отказал».
     */
    denialPatterns:
      // `не подтвердил` — не дубль `не подтвержд`: в «подтвердил» корень «рд», а
      // в «подтверждено» — «ржд», и одно другое не покрывает. Правой границы у
      // формы нет намеренно: она обязана расти («не подтвердились», «не
      // подтвердила»).
      "отклонил|опроверг|не вводил|не подтвержд|не подтвердил|отрицает|denied|dismissed|" +
      // У словаря есть левая граница и нет правой, и новым формам она нужна:
      // без неё «оправдан» совпадает с «оправданием коррупции», «отказал» — с
      // «отказался комментировать», «снято» — со «снятым при обыске видео».
      // Класс совпадений в чужом смысле — тот же, что у `pep(?!\p{L})`.
      // Гласная в классе оставляет законные формы: «дела прекращены», «суд
      // отказала», «обвиняемый оправдан».
      "снял обвинени|снят[оы](?!\\p{L})|прекращен[аоы](?!\\p{L})|" +
      "оправдан[аоы]?(?!\\p{L})|отказал[аи]?(?!\\p{L})",
    denialFlags: "iu",
  };
}

/**
 * Все словари каталога с именами — перечислением самого каталога, а не списком
 * рядом с кодом.
 *
 * Словарь, добавленный завтра (полем схемы или новой темой), попадает сюда сам,
 * и оба читателя — отказ компиляции и проверка правил в тестах — видят его без
 * правки. Своё перечисление у каждого читателя было бы вторым ответом на вопрос
 * «какие в каталоге словари», и разъехались бы они молча.
 */
export function findingThemesDictionaries(
  cfg: FindingThemesConfigJson
): Array<{ label: string; source: string }> {
  const dictionaries: Array<{ label: string; source: string }> = [];
  for (const [key, value] of Object.entries(cfg)) {
    if (key === "version" || key === "themes" || key.endsWith("Flags")) continue;
    if (typeof value === "string") dictionaries.push({ label: key, source: value });
  }
  for (const theme of cfg.themes) {
    dictionaries.push({ label: `themes[${theme.themeId}].keywords`, source: theme.keywords });
    if (theme.domains) {
      dictionaries.push({ label: `themes[${theme.themeId}].domains`, source: theme.domains });
    }
  }
  return dictionaries;
}

/**
 * Каталог с незакрытым сокращением не компилируется — тем же способом, что и
 * сильный словарь вне общего: конфигурация падает на загрузке, а не печатает
 * клиенту неверный ярлык. Файл переопределения с диска проходит через ту же
 * компиляцию и закрыт ею же.
 */
function assertAbbreviationsClosed(cfg: FindingThemesConfigJson): void {
  const broken = findingThemesDictionaries(cfg).flatMap((d) =>
    unclosedAbbreviations(d.source).map((alt) => `${d.label}: ${alt}`)
  );
  if (broken.length > 0) {
    throw new FindingThemesConfigError(
      "сокращение в словаре не закрыто справа — оно совпадёт с любым словом, которое с него " +
        `начинается: ${broken.join("; ")}`
    );
  }
}

export function compileFindingThemesConfig(
  json: FindingThemesConfigJson,
  meta: { source: "default" | "override"; overridePath: string | null }
): CompiledFindingThemesConfig {
  const parsed = FindingThemesConfigJsonSchema.safeParse(json);
  if (!parsed.success) {
    throw new FindingThemesConfigError(
      `finding-themes schema: ${parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`
    );
  }
  const cfg = parsed.data;
  assertAbbreviationsClosed(cfg);
  const themes: ThemeDef[] = cfg.themes.map((t) => ({
    themeId: t.themeId,
    label: t.label,
    keywords: compileRegex(
      withWordStart(t.keywords),
      t.flags.includes("u") ? t.flags : `${t.flags}u`,
      `themes[${t.themeId}].keywords`
    ),
    // Флаги темы как написаны: границы слова у списка площадок нет, а режим
    // Unicode нужен только просмотру назад, которого здесь нет.
    domains: t.domains
      ? compileRegex(t.domains, t.flags, `themes[${t.themeId}].domains`)
      : null,
    baseRisk: t.baseRisk,
    recommendedAction: t.recommendedAction,
    accusing: t.accusing,
  }));

  const defaults = getDefaultFindingThemesConfigJson();
  return {
    version: "finding-themes-v1",
    source: meta.source,
    overridePath: meta.overridePath,
    themes,
    adversePatterns: compileRegex(
      withWordStart(cfg.adversePatterns),
      withUnicode(cfg.adverseFlags),
      "adversePatterns"
    ),
    // Файл переопределения, написанный до появления подмножества, читается как
    // «сильных слов нет своих» — берутся значения по умолчанию, суженные до
    // того, что знает его собственный общий словарь.
    strongAdversePatterns: compileRegex(
      withWordStart(
        strongSubsetOfAdverse(
          cfg.adversePatterns,
          cfg.strongAdversePatterns ?? defaults.strongAdversePatterns!,
          cfg.strongAdversePatterns !== undefined
        )
      ),
      withUnicode(cfg.strongAdverseFlags ?? cfg.adverseFlags),
      "strongAdversePatterns"
    ),
    unverifiedDomains: compileRegex(
      cfg.unverifiedDomains,
      cfg.unverifiedDomainsFlags,
      "unverifiedDomains"
    ),
    authoritativeDomains: compileRegex(
      cfg.authoritativeDomains,
      cfg.authoritativeDomainsFlags,
      "authoritativeDomains"
    ),
    reputableDomains: compileRegex(
      cfg.reputableDomains,
      cfg.reputableDomainsFlags,
      "reputableDomains"
    ),
    unverifiedClaimPatterns: compileRegex(
      withWordStart(cfg.unverifiedClaimPatterns ?? defaults.unverifiedClaimPatterns!),
      withUnicode(cfg.unverifiedClaimFlags),
      "unverifiedClaimPatterns"
    ),
    positivePatterns: compileRegex(
      withWordStart(cfg.positivePatterns ?? defaults.positivePatterns!),
      withUnicode(cfg.positiveFlags),
      "positivePatterns"
    ),
    assertionPatterns: compileRegex(
      withWordStart(cfg.assertionPatterns ?? defaults.assertionPatterns!),
      withUnicode(cfg.assertionFlags),
      "assertionPatterns"
    ),
    denialPatterns: compileRegex(
      withWordStart(cfg.denialPatterns ?? defaults.denialPatterns!),
      withUnicode(cfg.denialFlags),
      "denialPatterns"
    ),
  };
}

function defaultOverridePath(storageRoot: string): string {
  return join(storageRoot, "config", "finding-themes.json");
}

let cached: CompiledFindingThemesConfig | null = null;
let cachedKey = "";

export function resetFindingThemesConfigCache(): void {
  cached = null;
  cachedKey = "";
}

/**
 * Resolve themes config: optional JSON override under storage, else defaults.
 * Fail-fast on invalid schema or regex.
 */
export function resolveFindingThemesConfig(input?: {
  storageRoot?: string;
  overridePath?: string | null;
  /** When set, skip disk and compile this JSON (tests). */
  json?: FindingThemesConfigJson | null;
}): CompiledFindingThemesConfig {
  const storageRoot =
    input?.storageRoot ??
    process.env.DIGITAL_PROFILE_STORAGE_ROOT ??
    process.env.DIGITAL_PROFILE_STORAGE_DIR ??
    "./storage/digital-profile";
  const overridePath =
    input?.overridePath === null
      ? null
      : (input?.overridePath ?? defaultOverridePath(storageRoot));

  if (input?.json) {
    return compileFindingThemesConfig(input.json, {
      source: "override",
      overridePath: overridePath,
    });
  }

  const cacheKey = `${storageRoot}::${overridePath ?? ""}`;
  if (cached && cachedKey === cacheKey) return cached;

  if (overridePath && existsSync(overridePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(overridePath, "utf8"));
    } catch (err) {
      throw new FindingThemesConfigError(
        `finding-themes override unreadable (${overridePath}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    cached = compileFindingThemesConfig(raw as FindingThemesConfigJson, {
      source: "override",
      overridePath,
    });
    cachedKey = cacheKey;
    return cached;
  }

  cached = compileFindingThemesConfig(getDefaultFindingThemesConfigJson(), {
    source: "default",
    overridePath: null,
  });
  cachedKey = cacheKey;
  return cached;
}

export function getFindingThemes(): ThemeDef[] {
  return resolveFindingThemesConfig().themes;
}

/**
 * Обвиняет тема или описывает.
 *
 * Тему материалу назначает словарь ключевых слов по заголовку, и там, где тема
 * обвиняет, прочитанная и признанная нейтральной страница доказательством быть
 * не может: клиенту предъявили бы сюжет, которого на странице нет. У делового
 * профиля и публичной экспозиции всё наоборот — нейтральная публикация и есть
 * законное доказательство темы, а её изгнание печатало на странице делового
 * профиля «отдельный заголовок с сутью риска в выдаче не выделен» при двух
 * годных цитатах.
 *
 * Признак живёт в самом каталоге (`accusing`), а не списком идентификаторов
 * рядом: каталог переопределяется файлом с диска, и список рядом с кодом такой
 * файл молча обходил бы — «Деловой профиль» снова становился бы обвиняющим.
 * Уровень риска на эту роль тоже не годится: он отвечает на другой вопрос
 * («насколько это важно»), и у публичной экспозиции он средний при полностью
 * описательном содержании.
 *
 * Темы нет вовсе (метка не нашлась в каталоге) — считаем обвиняющей: защита
 * строже. Это единственный вопрос, на который отвечает сам предикат: умолчание
 * **поля** стоит в схеме каталога, и подставлять его здесь ещё раз нечем и
 * незачем — у существующей темы признак задан всегда. Прежняя форма
 * (`theme?.accusing ?? true`) отвечала на оба вопроса одним выражением и
 * читалась как «поле может быть не задано»; следующий читатель снимает по ней
 * умолчание из схемы как дубль — и файл переопределения без признака перестаёт
 * загружаться вовсе.
 */
export function isAccusingTheme(theme: ThemeDef | undefined): boolean {
  return theme === undefined ? true : theme.accusing;
}

export function getAdversePatterns(): RegExp {
  return resolveFindingThemesConfig().adversePatterns;
}

/** Слова негатива, работающие и на мягких площадках, — подмножество общего словаря. */
export function getStrongAdversePatterns(): RegExp {
  return resolveFindingThemesConfig().strongAdversePatterns;
}
