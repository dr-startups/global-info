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
  baseRisk: RiskLevel;
  recommendedAction: string;
  /** Тема обвиняет (по умолчанию) или описывает — см. `isAccusingTheme`. */
  accusing: boolean;
};

const RiskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);

const ThemeDefJsonSchema = z.object({
  themeId: z.string().min(1),
  label: z.string().min(1),
  /** RegExp source (without slashes). */
  keywords: z.string().min(1),
  flags: z.string().default("iu"),
  baseRisk: RiskLevelSchema,
  recommendedAction: z.string().min(1),
  /**
   * Обвиняет ли тема. Умолчание строгое: тема, про которую каталог молчит
   * (в том числе заведённая файлом переопределения), считается обвиняющей.
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
          "оборон|defen[cs]e|national security|спецслужб|фсб|fsb|безопасн\\w* служб|security service",
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
          "уголов|criminal|арест|arrest|обыск|розыск|прокур|следств|sledstvie|rucriminal|компромат|суд(?!острое|ьб)|court",
        flags: "iu",
        baseRisk: "high",
        recommendedAction:
          "Проверить актуальные статусы дел по картотекам судов и официальным источникам; собрать документы о прекращении/исходе; недостоверные публикации — вытеснять из топ-20 официальными материалами и добиваться удаления на агрегаторах.",
      },
      {
        themeId: "pep_rca_watchlist",
        accusing: true,
        label: "PEP / RCA / watchlist-сигналы",
        keywords:
          "\\bpep\\b|\\brca\\b|watch.?list|санкц|sanction|world.?check|dow.?jones|lexis|rupep|комплаенс|compliance",
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
        themeId: "offshore_corporate",
        accusing: true,
        label: "Офшоры / корпоративное владение",
        keywords:
          "офшор|offshore|кипр|cyprus|\\bbvi\\b|панам|panama|бенефициар|beneficia|владел|ownership|opencorporates",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Провести корпоративную проверку структуры владения по реестрам, подготовить документальное подтверждение легальности структуры для KYC-запросов.",
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
          "бизнесмен|businessman|предпринимател|инвестор|investor|биограф|biography|forbes|логистик|logistics|транспорт|transport|девелоп",
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
      // есть левая граница и нет правой, и для латинских слов это цена без
      // выгоды: русские основы наращиваются («судебн», «прокурат»), английские
      // — нет.
      "санкц|sanction|watch.?list|уголов|criminal|арест|arrest|суд(?!острое|ьб)|court(?!s)|прокур|мошенн|fraud|коррупц|corrupt|отмыв|launder|обыск|розыск|компромат|скандал|расследован|investigat|adverse|безопасн.*служб|спецслужб|security service|national security|фсб|fsb",
    adverseFlags: "iu",
    /*
     * Слова, которые краснят строку даже на мягкой площадке.
     *
     * Мягкие площадки (биографии, реестры, энциклопедии, соцсети) словарём не
     * судятся: «скандалы» в оглавлении статьи — жанр, а не сигнал. Но пост в X
     * «Уголовное дело против …» рамку получить обязан, иначе площадка слепа
     * целиком. Это **подмножество** `adversePatterns`, а не второй словарь:
     * слово, краснящее мягкую площадку, обязано краснить и обычную.
     */
    strongAdversePatterns:
      "санкц|sanction|уголов|criminal|арест|arrest|мошенн|fraud|коррупц|corrupt|компромат",
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
    denialPatterns:
      "отклонил|опроверг|не вводил|не подтвержд|отрицает|denied|dismissed|снял обвинени",
    denialFlags: "iu",
  };
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
  const themes: ThemeDef[] = cfg.themes.map((t) => ({
    themeId: t.themeId,
    label: t.label,
    keywords: compileRegex(
      withWordStart(t.keywords),
      t.flags.includes("u") ? t.flags : `${t.flags}u`,
      `themes[${t.themeId}].keywords`
    ),
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
    // «сильных слов нет своих» — берутся значения по умолчанию.
    strongAdversePatterns: compileRegex(
      withWordStart(cfg.strongAdversePatterns ?? defaults.strongAdversePatterns!),
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
 * строже.
 */
export function isAccusingTheme(theme: ThemeDef | undefined): boolean {
  return theme?.accusing ?? true;
}

export function getAdversePatterns(): RegExp {
  return resolveFindingThemesConfig().adversePatterns;
}

/** Слова негатива, работающие и на мягких площадках, — подмножество общего словаря. */
export function getStrongAdversePatterns(): RegExp {
  return resolveFindingThemesConfig().strongAdversePatterns;
}
