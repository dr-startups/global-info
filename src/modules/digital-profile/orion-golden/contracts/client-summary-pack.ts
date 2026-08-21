/**
 * Stage 4 — ClientSummaryPack contract.
 *
 * Sole typed input for executive summary content: stage 5 composes it into
 * `composed-client-summary.json`, which the deck reads (`load-deck-inputs`) and
 * turns into the executive summary slides. v2 adds read plots — the stories of
 * the pages we actually read.
 */

import { z } from "zod";
import { ContractEnvelopeSchema, RiskLevelSchema } from "./common";
import {
  CanonicalThemeIdSchema,
  ClaimKindSchema,
  MaterialityLevelSchema,
} from "./canonical-claim";

export const CLIENT_SUMMARY_PACK_SCHEMA_VERSION = "client-summary-pack-v2" as const;

export const RepresentativeArticleSchema = z.object({
  title: z.string().min(1),
  /**
   * Domain of THIS material. Empty when the lead material carries no URL —
   * an unknown source is a legitimate state and must be rendered as no
   * attribution at all, never as another material's domain (step 05.3).
   */
  domain: z.string(),
  /**
   * Полный адрес ЭТОГО материала — им называется источник в тексте.
   *
   * Пусто — адреса нет вовсе; тогда источник называется доменом, а чужой адрес
   * не подставляется никогда (то же правило, что у `domain`).
   */
  url: z.string().default(""),
  sourceDate: z.string().nullable(),
  conciseCompleteDescription: z.string().min(1),
  sourceAllegationOrStatus: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  materialityLevel: MaterialityLevelSchema,
  clientQualification: z.string().min(1),
  claimKind: ClaimKindSchema,
});
export type RepresentativeArticle = z.infer<typeof RepresentativeArticleSchema>;

export const ClientMaterialThemeSchema = z.object({
  themeId: CanonicalThemeIdSchema,
  clientTitle: z.string().min(1),
  conclusion: z.string().min(1),
  concreteClaims: z.array(z.string()).min(1),
  representativeArticles: z.array(RepresentativeArticleSchema).min(1),
  whyItMatters: z.string().min(1),
  qualification: z.string().min(1),
  recommendedChecks: z.array(z.string()).min(1),
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
  /**
   * Domains behind the theme. May be empty when no material carries a public
   * URL: the builder stopped substituting «неизвестный источник» in step 05.3,
   * and an invented source is worse than none.
   */
  sourceDomains: z.array(z.string()),
});
export type ClientMaterialTheme = z.infer<typeof ClientMaterialThemeSchema>;

export const ClientIsolatedItemSchema = z.object({
  title: z.string().min(1),
  /** Empty when unknown — see RepresentativeArticleSchema.domain. */
  domain: z.string(),
  description: z.string().min(1),
  qualification: z.string().min(1),
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
});
export type ClientIsolatedItem = z.infer<typeof ClientIsolatedItemSchema>;

/**
 * Цитата сюжета: дословная строка со страницы и наблюдение, из которого она
 * взята. Домен пустой, когда называть его клиенту нельзя.
 */
/**
 * Сколько цитат печатается в блоке одного сюжета.
 *
 * Было две, и на отчёте Прохорова (20.08) из девяти прочитанных публикаций
 * сюжета «Скандалы, конфликты и критика деловой репутации» клиент видел
 * Википедию и Куршевель, а разбор файлов Эпштейна не видел вовсе; из пяти
 * публикаций сюжета «Санкции, гражданство и зарубежные активы» — не видел
 * Ибицу. Блок говорил числа и молчал о том, чем эти публикации нежелательны.
 *
 * Шесть, а не «все»: резюме обязано сказать, о чём сюжет, а не пересказать его
 * целиком — масштаб даёт счётная фраза. Когда процитированы не все, блок
 * называет это числом: молчаливый срез читается как «это всё, что нашли».
 *
 * Число объявлено здесь, а схема и построитель берут его отсюда: пока на этот
 * вопрос отвечали два места (цикл построителя и `max(2)` схемы), поднять предел
 * можно было в одном и не заметить второго.
 */
export const READ_PLOT_QUOTE_LIMIT = 6;

export const ClientReadPlotQuoteSchema = z.object({
  text: z.string().min(1),
  domain: z.string(),
  /** Адрес страницы, с которой снята цитата; пусто — адреса нет. */
  url: z.string().default(""),
  evidenceRef: z.string().min(1),
});
export type ClientReadPlotQuote = z.infer<typeof ClientReadPlotQuoteSchema>;

/**
 * Сюжет прочитанных страниц — строка `summary.themes` из `link-verdicts.json`,
 * дословно.
 *
 * Название и числа не пересчитываются: их печатает и страница «о чём
 * публикации в ТОП-20», и резюме, а два счётчика на один вопрос разойдутся на
 * первом же краевом случае.
 *
 * `evidenceRefs` пуст только у сюжета, которому нечем подтвердиться, — такой
 * ловится воротами `READ_PLOTS_WITHOUT_EVIDENCE` по имени, а не отказом схемы
 * без объяснения.
 */
export const ClientReadPlotSchema = z.object({
  plotId: z.string().min(1),
  title: z.string().min(1),
  count: z.number().int().min(0),
  adverseCount: z.number().int().min(0),
  evidenceRefs: z.array(z.string()),
  sourceDomains: z.array(z.string()),
  quotes: z.array(ClientReadPlotQuoteSchema).max(READ_PLOT_QUOTE_LIMIT),
});
export type ClientReadPlot = z.infer<typeof ClientReadPlotSchema>;

export const InternationalDatabaseEntrySchema = z.object({
  databaseName: z.string().min(1),
  statusSummary: z.string().min(1),
  qualification: z.string().min(1),
  evidenceRefs: z.array(z.string()),
  sourceDomains: z.array(z.string()),
});
export type InternationalDatabaseEntry = z.infer<typeof InternationalDatabaseEntrySchema>;

export const ClientSummaryPackSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(CLIENT_SUMMARY_PACK_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  scope: z.object({
    regions: z.array(z.string()),
    sourceClasses: z.array(z.string()),
    surfaces: z.array(z.string()),
    /**
     * Глубина выдачи, вошедшая в аудит: 20 — «результаты поиска (ТОП-20)».
     * `null` — область не объявлена (прогон старше правила), и тогда сводка
     * молчит о глубине, а не придумывает её.
     */
    searchDepthTopN: z.number().int().positive().nullable().default(null),
    period: z.object({
      collectedLabel: z.string(),
      newestLabel: z.string().nullable(),
    }),
    coverageLimitations: z.array(z.string()),
  }),
  overallAssessment: z.object({
    riskLevel: RiskLevelSchema,
    conclusion: z.string().min(1),
    reasons: z.array(z.string()).min(1),
    limitations: z.array(z.string()),
    evidenceRefs: z.array(z.string()).min(1),
  }),
  materialThemes: z.array(ClientMaterialThemeSchema),
  /**
   * Сюжеты прочитанных страниц — все субъектные, включая нейтральные: по ним
   * считается покрытие тем претензий, даже если печатать их резюме не будет.
   */
  readPlots: z.array(ClientReadPlotSchema).default([]),
  isolatedSignificantItems: z.array(ClientIsolatedItemSchema),
  internationalDatabases: z.array(InternationalDatabaseEntrySchema),
  changesSinceBaseline: z.object({
    summary: z.string(),
    addedCount: z.number().int().min(0).nullable(),
    removedCount: z.number().int().min(0).nullable(),
  }),
  nextSteps: z.array(z.string()).min(1),
  /** Machine-only; must not be copied into client slide fields as-is. */
  trace: z.object({
    claimIds: z.array(z.string()),
    findingIds: z.array(z.string()),
    dispositionRefs: z.array(z.string()),
    representativeSelectionRef: z.string(),
    canonicalClaimsRef: z.string(),
    p1p2Account: z.array(
      z.object({
        findingId: z.string(),
        status: z.string(),
        reasonCode: z.string(),
      })
    ),
  }),
  gates: z.object({
    CLIENT_SUMMARY_PACK_VALID: z.boolean(),
    MATERIAL_THEMES_MISSING: z.number().int().min(0),
    CLIENT_ASSERTIONS_WITHOUT_EVIDENCE: z.number().int().min(0),
    INTERNAL_TOKENS_IN_CLIENT_FIELDS: z.number().int().min(0),
    /** Сюжет без ссылок или со ссылкой, которой нет среди решений прогона. */
    READ_PLOTS_WITHOUT_EVIDENCE: z.number().int().min(0).default(0),
  }),
});
export type ClientSummaryPack = z.infer<typeof ClientSummaryPackSchema>;
