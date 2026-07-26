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
});

export const FindingThemesConfigJsonSchema = z.object({
  version: z.literal("finding-themes-v1"),
  themes: z.array(ThemeDefJsonSchema).min(1),
  adversePatterns: z.string().min(1),
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

/** Universal default theme set — no case-specific «транспортный контур» tuning. */
export function getDefaultFindingThemesConfigJson(): FindingThemesConfigJson {
  return {
    version: "finding-themes-v1",
    themes: [
      {
        themeId: "security_scrutiny",
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
        label: "Криминальные / судебные материалы",
        keywords:
          "уголов|criminal|арест|arrest|обыск|розыск|прокур|следств|sledstvie|rucriminal|компромат|суд(?!острое)|court",
        flags: "iu",
        baseRisk: "high",
        recommendedAction:
          "Проверить актуальные статусы дел по картотекам судов и официальным источникам; собрать документы о прекращении/исходе; недостоверные публикации — вытеснять из топ-20 официальными материалами и добиваться удаления на агрегаторах.",
      },
      {
        themeId: "pep_rca_watchlist",
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
        keywords:
          "полит|politic|депутат|парти|выбор|electoral|минист|правительств|govern|парламент|parliament",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Зафиксировать фактическую хронологию публичных должностей и связей, подготовить согласованную позицию для СМИ и комплаенс-запросов банков и партнёров.",
      },
      {
        themeId: "offshore_corporate",
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
        label: "Финансовые претензии / долговые споры",
        keywords:
          "банкрот|bankrupt|долг\\w*|debt|взыскан|неисполнен|lawsuit|претенз|арбитражн\\w* иск|неплатеж",
        flags: "iu",
        baseRisk: "medium",
        recommendedAction:
          "Сверить претензии с судебными и реестровыми источниками, подготовить документы о статусе обязательств для банков и партнёров.",
      },
      {
        themeId: "business_profile",
        label: "Деловой профиль",
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
      "санкц|sanction|watch.?list|уголов|criminal|арест|arrest|суд|court|прокур|мошенн|fraud|коррупц|corrupt|отмыв|launder|обыск|розыск|компромат|скандал|расследован|investigat|adverse|безопасн.*служб|спецслужб|security service|national security|фсб|fsb",
    adverseFlags: "iu",
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
    assertionPatterns: "подтвержден|подтверждено|confirmed|установлен[оа]?\\b|введены",
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
    keywords: compileRegex(t.keywords, t.flags, `themes[${t.themeId}].keywords`),
    baseRisk: t.baseRisk,
    recommendedAction: t.recommendedAction,
  }));

  const defaults = getDefaultFindingThemesConfigJson();
  return {
    version: "finding-themes-v1",
    source: meta.source,
    overridePath: meta.overridePath,
    themes,
    adversePatterns: compileRegex(
      cfg.adversePatterns,
      cfg.adverseFlags,
      "adversePatterns"
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
      cfg.unverifiedClaimPatterns ?? defaults.unverifiedClaimPatterns!,
      cfg.unverifiedClaimFlags,
      "unverifiedClaimPatterns"
    ),
    positivePatterns: compileRegex(
      cfg.positivePatterns ?? defaults.positivePatterns!,
      cfg.positiveFlags,
      "positivePatterns"
    ),
    assertionPatterns: compileRegex(
      cfg.assertionPatterns ?? defaults.assertionPatterns!,
      cfg.assertionFlags,
      "assertionPatterns"
    ),
    denialPatterns: compileRegex(
      cfg.denialPatterns ?? defaults.denialPatterns!,
      cfg.denialFlags,
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

export function getAdversePatterns(): RegExp {
  return resolveFindingThemesConfig().adversePatterns;
}
