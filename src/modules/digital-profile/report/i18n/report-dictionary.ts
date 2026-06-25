/**
 * Report i18n dictionary (Stage L2).
 *
 * Deterministic, templated phrases for the *report* (PPTX/PDF) in RU / EN. This
 * is the TypeScript half of the report dictionary; the Python renderer mirrors
 * the same keys in `renderer/report_i18n.py`. Code is intentionally NOT shared
 * between TS and Python — only the key set / wording is kept consistent.
 *
 * Rules (same as Stage J): no LLM, cautious non-conclusive wording, never a
 * legal/criminal assertion, raw evidence (URLs, titles, snippets) is never
 * translated here — only the system-generated prose.
 */

export type ReportLanguage = "ru" | "en";

export const REPORT_LANGUAGES: ReportLanguage[] = ["ru", "en"];

export function normalizeReportLanguage(
  value: unknown,
  fallback: ReportLanguage = "ru"
): ReportLanguage {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "ru" || v === "en" ? (v as ReportLanguage) : fallback;
}

function pct(share: number): string {
  return `${Math.round((Number.isFinite(share) ? share : 0) * 100)}%`;
}

/** Localized region phrase used inside region conclusions. */
function regionPhrase(lang: ReportLanguage, region: string): string {
  const ru = region.toUpperCase() === "RU";
  if (lang === "ru") return ru ? "российском" : "международном";
  return ru ? "Russian" : "international";
}

export interface AuditPhrases {
  pct: (share: number) => string;

  // Executive summary
  execIntro: (name: string, level: string) => string;
  execAnalysed: (total: number, unique: number, neg: number, share: number) => string;
  execNoOrganic: () => string;
  execSurfaces: (
    sn: number, st: number, inum: number, it: number, vn: number, vt: number
  ) => string;
  execWikiExists: () => string;
  execWikiAbsent: () => string;
  execComplianceActive: (providers: string, n: number) => string;
  execComplianceNone: (providers: string) => string;
  execDataQuality: (warning: string) => string;

  // Key findings — group titles
  kfSearchProfile: string;
  kfSearchSurfaces: string;
  kfWikipedia: string;
  kfCompliance: string;
  kfDataQuality: string;
  // Key findings — points
  kfNegOfTotal: (neg: number, total: number, share: number) => string;
  kfAdverseFrom: (domains: string) => string;
  kfRecurringThemes: (themes: string) => string;
  kfNoOrganic: () => string;
  kfSuggestions: (sn: number, st: number, rn: number, rt: number) => string;
  kfImagesVideos: (inum: number, it: number, vn: number, vt: number) => string;
  kfKnowledge: (n: number, m: number) => string;
  kfPepRca: (p: number, r: number, s: number, a: number) => string;
  kfCoverageAdequate: () => string;

  // Recommended actions
  raThoroughReview: () => string;
  raCorroborate: () => string;
  raStrategy: () => string;
  raVerifyCompliance: () => string;
  raMonitoring: () => string;
  raWikipedia: () => string;
  raExpandCollection: () => string;
  raUploadEvidence: () => string;
  raEnableApis: () => string;
  raMaintainMonitoring: () => string;

  // Wikipedia conclusions
  wikiExists: () => string;
  wikiNotChecked: () => string;
  wikiAbsent: () => string;

  // Compliance conclusions
  compNone: () => string;
  compSanctions: () => string;
  compPepRca: () => string;
  compActive: () => string;
  compNoMaterial: () => string;

  // Region conclusions
  regionNoData: (region: string) => string;
  regionNegative: (region: string, neg: number, total: number) => string;
  regionNoAdverse: (region: string) => string;

  // Data-quality warnings
  dqNoEvidence: () => string;
  dqLittleEvidence: () => string;
  dqFewOrganic: () => string;
  dqPending: (n: number) => string;
  dqMissing: (sections: string) => string;
}

const EN: AuditPhrases = {
  pct,
  execIntro: (name, level) =>
    `Briefly: open-source review of ${name} produced an overall risk level of ${level} (preliminary, requires manual review).`,
  execAnalysed: (total, unique, neg, share) =>
    `Analysed ${total} organic result(s) across ${unique} unique URL(s); ${neg} (${pct(share)}) contain potentially adverse mentions.`,
  execNoOrganic: () => "No organic search results have been collected yet.",
  execSurfaces: (sn, st, inum, it, vn, vt) =>
    `Search surfaces: ${sn}/${st} negative suggestion(s), ${inum}/${it} image(s), ${vn}/${vt} video(s) flagged for review.`,
  execWikiExists: () =>
    "An authoritative Wikipedia profile exists and should be reviewed for accuracy.",
  execWikiAbsent: () =>
    "No authoritative Wikipedia profile was found (absence of a controlled profile, not an adverse signal).",
  execComplianceActive: (providers, n) =>
    `Compliance screening (${providers}) returned ${n} potential match(es); mandatory manual verification.`,
  execComplianceNone: (providers) =>
    `Compliance screening (${providers}) returned no material matches; confirm manually.`,
  execDataQuality: (warning) => `Data quality: ${warning}`,

  kfSearchProfile: "Search profile",
  kfSearchSurfaces: "Search surfaces",
  kfWikipedia: "Wikipedia",
  kfCompliance: "Compliance databases",
  kfDataQuality: "Data quality",
  kfNegOfTotal: (neg, total, share) =>
    `${neg} of ${total} organic result(s) (${pct(share)}) contain potentially adverse mentions.`,
  kfAdverseFrom: (domains) => `Adverse mentions originate from: ${domains}.`,
  kfRecurringThemes: (themes) => `Recurring themes: ${themes}.`,
  kfNoOrganic: () => "No organic search results collected yet.",
  kfSuggestions: (sn, st, rn, rt) =>
    `Suggestions: ${sn}/${st} flagged; related: ${rn}/${rt}.`,
  kfImagesVideos: (inum, it, vn, vt) =>
    `Images: ${inum}/${it} flagged; videos: ${vn}/${vt}.`,
  kfKnowledge: (n, m) => `Knowledge block(s): ${n}, mismatches flagged: ${m}.`,
  kfPepRca: (p, r, s, a) =>
    `PEP: ${p}, RCA: ${r}, sanctions: ${s}, adverse media: ${a}.`,
  kfCoverageAdequate: () =>
    "Evidence coverage is adequate for a preliminary assessment.",

  raThoroughReview: () =>
    "Conduct a thorough manual review of all flagged sources before drawing conclusions.",
  raCorroborate: () => "Clarify and corroborate sources containing adverse mentions.",
  raStrategy: () => "Prepare a digital-profile management strategy for the subject.",
  raVerifyCompliance: () => "Verify compliance-database matches via official channels.",
  raMonitoring: () =>
    "Set up ongoing monitoring for changes in the subject's digital footprint.",
  raWikipedia: () =>
    "Consider establishing or improving an authoritative Wikipedia profile, where appropriate and policy-compliant.",
  raExpandCollection: () => "Expand data collection across regions and search surfaces.",
  raUploadEvidence: () => "Upload available manual evidence to strengthen the assessment.",
  raEnableApis: () => "Enable official search/compliance APIs to gather verified data.",
  raMaintainMonitoring: () =>
    "Maintain periodic monitoring; no elevated risk indicators at this time.",

  wikiExists: () =>
    "An authoritative Wikipedia profile exists; its contents should be reviewed manually for accuracy and tone.",
  wikiNotChecked: () =>
    "Wikipedia presence has not been checked yet; requires verification.",
  wikiAbsent: () =>
    "No authoritative Wikipedia profile was found. This is the absence of a controlled profile, not an adverse signal.",

  compNone: () =>
    "No compliance database screening recorded yet; official-API or manual import required.",
  compSanctions: () =>
    "Compliance screening contains sanctions-related records; mandatory manual verification before any conclusion.",
  compPepRca: () =>
    "Compliance screening contains PEP/RCA-related records; requires manual verification.",
  compActive: () =>
    "Compliance screening returned potential matches; requires manual review.",
  compNoMaterial: () =>
    "No material compliance matches recorded; results should still be confirmed manually.",

  regionNoData: (region) =>
    `No ${region} search data collected yet; requires data gathering.`,
  regionNegative: (region, neg, total) =>
    `In the ${regionPhrase("en", region)} search space, ${neg} of ${total} organic result(s) contain potentially adverse mentions; requires manual review.`,
  regionNoAdverse: (region) =>
    `In the ${regionPhrase("en", region)} search space, no clearly adverse organic results were detected; results should still be confirmed manually.`,

  dqNoEvidence: () =>
    "No evidence has been collected yet; the summary is not reliable.",
  dqLittleEvidence: () =>
    "Very little evidence collected; conclusions are preliminary and require expansion.",
  dqFewOrganic: () =>
    "Few organic search results; negative-share metrics may be unstable.",
  dqPending: (n) => `${n} risk finding(s) are still pending human review.`,
  dqMissing: (sections) => `Missing evidence sections: ${sections}.`,
};

const RU: AuditPhrases = {
  pct,
  execIntro: (name, level) =>
    `Кратко: анализ открытых источников по ${name} дал общий уровень риска ${level} (предварительно, требует ручной проверки).`,
  execAnalysed: (total, unique, neg, share) =>
    `Проанализировано ${total} органических результат(ов) по ${unique} уникальным URL; ${neg} (${pct(share)}) содержат потенциально негативные упоминания.`,
  execNoOrganic: () => "Органические результаты поиска пока не собраны.",
  execSurfaces: (sn, st, inum, it, vn, vt) =>
    `Поисковые поверхности: ${sn}/${st} негативных подсказок, ${inum}/${it} изображений, ${vn}/${vt} видео отмечены для проверки.`,
  execWikiExists: () =>
    "Авторитетный профиль в Википедии существует и должен быть проверен на точность.",
  execWikiAbsent: () =>
    "Авторитетный профиль в Википедии не обнаружен (отсутствие контролируемого профиля, не негативный сигнал).",
  execComplianceActive: (providers, n) =>
    `Комплаенс-скрининг (${providers}) дал ${n} потенциальных совпадений; обязательна ручная проверка.`,
  execComplianceNone: (providers) =>
    `Комплаенс-скрининг (${providers}) не выявил существенных совпадений; подтвердите вручную.`,
  execDataQuality: (warning) => `Качество данных: ${warning}`,

  kfSearchProfile: "Поисковый профиль",
  kfSearchSurfaces: "Поисковые поверхности",
  kfWikipedia: "Википедия",
  kfCompliance: "Комплаенс-базы",
  kfDataQuality: "Качество данных",
  kfNegOfTotal: (neg, total, share) =>
    `${neg} из ${total} органических результат(ов) (${pct(share)}) содержат потенциально негативные упоминания.`,
  kfAdverseFrom: (domains) => `Негативные упоминания происходят из: ${domains}.`,
  kfRecurringThemes: (themes) => `Повторяющиеся темы: ${themes}.`,
  kfNoOrganic: () => "Органические результаты поиска пока не собраны.",
  kfSuggestions: (sn, st, rn, rt) =>
    `Подсказки: ${sn}/${st} отмечено; похожие запросы: ${rn}/${rt}.`,
  kfImagesVideos: (inum, it, vn, vt) =>
    `Изображения: ${inum}/${it} отмечено; видео: ${vn}/${vt}.`,
  kfKnowledge: (n, m) => `Блоков знаний: ${n}, расхождений отмечено: ${m}.`,
  kfPepRca: (p, r, s, a) =>
    `PEP: ${p}, RCA: ${r}, санкции: ${s}, негативные СМИ: ${a}.`,
  kfCoverageAdequate: () =>
    "Покрытие доказательной базы достаточно для предварительной оценки.",

  raThoroughReview: () =>
    "Провести тщательную ручную проверку всех отмеченных источников до выводов.",
  raCorroborate: () => "Уточнить и перепроверить источники с негативными упоминаниями.",
  raStrategy: () => "Подготовить стратегию управления цифровым профилем субъекта.",
  raVerifyCompliance: () =>
    "Проверить совпадения в комплаенс-базах по официальным каналам.",
  raMonitoring: () =>
    "Настроить постоянный мониторинг изменений цифрового следа субъекта.",
  raWikipedia: () =>
    "Рассмотреть создание или улучшение авторитетного профиля в Википедии, где это уместно и соответствует правилам.",
  raExpandCollection: () =>
    "Расширить сбор данных по регионам и поисковым поверхностям.",
  raUploadEvidence: () =>
    "Загрузить доступные ручные доказательства для усиления оценки.",
  raEnableApis: () =>
    "Подключить официальные API поиска/комплаенса для сбора проверенных данных.",
  raMaintainMonitoring: () =>
    "Поддерживать периодический мониторинг; повышенных индикаторов риска сейчас нет.",

  wikiExists: () =>
    "Авторитетный профиль в Википедии существует; его содержание следует проверить вручную на точность и тон.",
  wikiNotChecked: () =>
    "Наличие в Википедии ещё не проверялось; требуется проверка.",
  wikiAbsent: () =>
    "Авторитетный профиль в Википедии не обнаружен. Это отсутствие контролируемого профиля, а не негативный сигнал.",

  compNone: () =>
    "Скрининг по комплаенс-базам ещё не проводился; требуется официальный API или ручной импорт.",
  compSanctions: () =>
    "Комплаенс-скрининг содержит записи, связанные с санкциями; обязательна ручная проверка до любых выводов.",
  compPepRca: () =>
    "Комплаенс-скрининг содержит записи, связанные с PEP/RCA; требуется ручная проверка.",
  compActive: () =>
    "Комплаенс-скрининг дал потенциальные совпадения; требуется ручная проверка.",
  compNoMaterial: () =>
    "Существенных совпадений в комплаенс-базах не зафиксировано; результаты следует подтвердить вручную.",

  regionNoData: (region) =>
    `Данные поиска по региону ${region} пока не собраны; требуется сбор данных.`,
  regionNegative: (region, neg, total) =>
    `В ${regionPhrase("ru", region)} поисковом пространстве ${neg} из ${total} органических результат(ов) содержат потенциально негативные упоминания; требуется ручная проверка.`,
  regionNoAdverse: (region) =>
    `В ${regionPhrase("ru", region)} поисковом пространстве явно негативных органических результатов не выявлено; результаты следует подтвердить вручную.`,

  dqNoEvidence: () =>
    "Доказательства ещё не собраны; сводка ненадёжна.",
  dqLittleEvidence: () =>
    "Собрано очень мало доказательств; выводы предварительные и требуют расширения.",
  dqFewOrganic: () =>
    "Мало органических результатов; доля негатива может быть нестабильной.",
  dqPending: (n) => `${n} риск-находка(и) всё ещё ожидают ручной проверки.`,
  dqMissing: (sections) => `Отсутствуют разделы доказательств: ${sections}.`,
};

const TABLE: Record<ReportLanguage, AuditPhrases> = { en: EN, ru: RU };

export function auditPhrases(lang: ReportLanguage): AuditPhrases {
  return TABLE[lang] ?? RU;
}
