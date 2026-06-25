/**
 * Commercial offer configuration for the report's static pages (Stage K1).
 *
 * Prices are NEVER hardcoded in slides/renderer — they come from the pricing
 * catalog (config) and env, and are serialized into report_json.offer so the
 * renderer only formats values it is given.
 *
 * Stage L2 — the prose (titles, objectives, deliverables, CTA, disclaimers …)
 * is localized RU / EN. Prices and currency are language-independent. Env
 * overrides, when set, win over the localized defaults for both languages.
 */

import { digitalProfileConfig, reportPricing } from "../config";
import type { ReportOffer, ReportOfferSolution } from "../types";
import {
  normalizeReportLanguage,
  type ReportLanguage,
} from "./i18n/report-dictionary";

function priceByCode(code: string, fallback: number): number {
  return reportPricing.find((p) => p.code === code)?.amount ?? fallback;
}

interface OfferText {
  productName: string;
  reportSubtitle: string;
  companyDescription: string;
  pricingNotes: string;
  callToAction: string;
  disclaimers: string[];
  processSteps: string[];
  solution1Title: string;
  solution2Title: string;
  solution3Title: string;
  solutions: {
    title: string;
    objective: string;
    duration: string;
    includedItems: string[];
    deliverables: string[];
    expectedResults: string[];
    workPlan: string[];
  }[];
}

const EN: OfferText = {
  productName: "Digital Profile Audit",
  reportSubtitle: "Digital footprint & compliance audit",
  companyDescription:
    "We deliver evidence-first digital profile and compliance audits. Every statement references verifiable evidence — a URL, a screenshot, an imported record — and compliance screening uses official APIs or manual import only.",
  pricingNotes:
    "Prices are indicative and exclude taxes. Final scope is agreed per engagement.",
  callToAction:
    "Contact our team to scope an engagement and agree lawful basis.",
  disclaimers: [
    "This report is advisory; all findings require manual verification before any decision.",
    "No leaked or illegally obtained datasets are used. Compliance screening uses official APIs or manual import only.",
  ],
  processSteps: [
    "Audit — collect open-source and compliance evidence.",
    "Analysis — deterministic risk classification.",
    "Strategy — prioritise findings and remediation.",
    "Execution — address negative items and strengthen authority.",
    "Monitoring — track the footprint over time.",
  ],
  solution1Title: "Digital Profile Audit — Basic",
  solution2Title: "Digital Profile Audit — Standard",
  solution3Title: "Digital Profile Audit — Enterprise",
  solutions: [
    {
      title: "Solution 1 — Digital Profile",
      objective:
        "Build an evidence-based map of the subject's open-source digital footprint across regions.",
      duration: "2–3 weeks",
      includedItems: [
        "Multi-region open-source search audit (Google / Yandex).",
        "Search surfaces: suggestions, related queries, images, videos, knowledge blocks.",
        "Deterministic risk classification with analyst review.",
      ],
      deliverables: [
        "Multi-page digital profile report (PPTX + PDF).",
        "Prioritised list of negative items with evidence references.",
      ],
      expectedResults: [
        "Clear understanding of the public narrative.",
        "Actionable shortlist of reputational risks to address.",
      ],
      workPlan: [
        "Scope & lawful basis.",
        "Evidence collection (search + surfaces).",
        "Risk classification & analyst review.",
        "Report delivery.",
      ],
    },
    {
      title: "Solution 2 — Compliance Databases",
      objective:
        "Screen the subject against major compliance databases via official APIs or manual import.",
      duration: "1–2 weeks",
      includedItems: [
        "Dow Jones / LexisNexis / World-Check screening (official API or manual import).",
        "PEP / RCA / sanctions / adverse-media categorization.",
        "Documented match status with evidence.",
      ],
      deliverables: [
        "Compliance screening section with per-provider results.",
        "Verified match log requiring sign-off.",
      ],
      expectedResults: [
        "Compliance posture clarified for onboarding / due diligence.",
        "Reduced regulatory exposure through documented checks.",
      ],
      workPlan: [
        "Provider screening (official API / manual import).",
        "Match verification & documentation.",
        "Compliance section delivery.",
      ],
    },
    {
      title: "Solution 3 — Wikipedia & Authority",
      objective:
        "Assess authoritative presence and knowledge-panel consistency, with ongoing monitoring.",
      duration: "3–4 weeks + monitoring",
      includedItems: [
        "Authoritative profile and notability assessment.",
        "Knowledge-panel consistency checks.",
        "Ongoing monitoring of the digital footprint.",
      ],
      deliverables: [
        "Authority assessment section.",
        "Monitoring plan and cadence.",
      ],
      expectedResults: [
        "Greater control over the authoritative narrative.",
        "Early warning on new adverse signals.",
      ],
      workPlan: [
        "Notability review.",
        "Authoritative source strategy.",
        "Monitoring setup.",
      ],
    },
  ],
};

const RU: OfferText = {
  productName: "Аудит цифрового профиля",
  reportSubtitle: "Аудит цифрового следа и комплаенса",
  companyDescription:
    "Мы проводим аудит цифрового профиля и комплаенса по принципу «сначала доказательства». Каждое утверждение опирается на проверяемое доказательство — URL, скриншот, импортированную запись — а комплаенс-скрининг использует только официальные API или ручной импорт.",
  pricingNotes:
    "Цены ориентировочные и без учёта налогов. Итоговый объём согласовывается под проект.",
  callToAction:
    "Свяжитесь с нашей командой, чтобы согласовать объём работ и правовое основание.",
  disclaimers: [
    "Отчёт носит рекомендательный характер; все выводы требуют ручной проверки до принятия решений.",
    "Утечки и незаконно полученные базы данных не используются. Комплаенс-скрининг использует только официальные API или ручной импорт.",
  ],
  processSteps: [
    "Аудит — сбор открытых источников и комплаенс-доказательств.",
    "Анализ — детерминированная классификация рисков.",
    "Стратегия — приоритизация находок и план устранения.",
    "Исполнение — работа с негативом и усиление авторитетности.",
    "Мониторинг — отслеживание цифрового следа во времени.",
  ],
  solution1Title: "Аудит цифрового профиля — Базовый",
  solution2Title: "Аудит цифрового профиля — Стандарт",
  solution3Title: "Аудит цифрового профиля — Корпоративный",
  solutions: [
    {
      title: "Решение 1 — Цифровой профиль",
      objective:
        "Построить доказательную карту цифрового следа субъекта в открытых источниках по регионам.",
      duration: "2–3 недели",
      includedItems: [
        "Мультирегиональный аудит поиска по открытым источникам (Google / Яндекс).",
        "Поисковые поверхности: подсказки, похожие запросы, изображения, видео, блоки знаний.",
        "Детерминированная классификация рисков с проверкой аналитиком.",
      ],
      deliverables: [
        "Многостраничный отчёт по цифровому профилю (PPTX + PDF).",
        "Приоритизированный список негативных материалов со ссылками на доказательства.",
      ],
      expectedResults: [
        "Ясное понимание публичного нарратива.",
        "Практический перечень репутационных рисков для проработки.",
      ],
      workPlan: [
        "Объём и правовое основание.",
        "Сбор доказательств (поиск + поверхности).",
        "Классификация рисков и проверка аналитиком.",
        "Сдача отчёта.",
      ],
    },
    {
      title: "Решение 2 — Комплаенс-базы",
      objective:
        "Проверить субъекта по основным комплаенс-базам через официальные API или ручной импорт.",
      duration: "1–2 недели",
      includedItems: [
        "Скрининг Dow Jones / LexisNexis / World-Check (официальный API или ручной импорт).",
        "Категоризация PEP / RCA / санкции / негативные СМИ.",
        "Документированный статус совпадений с доказательствами.",
      ],
      deliverables: [
        "Раздел комплаенс-скрининга с результатами по провайдерам.",
        "Журнал проверенных совпадений, требующий утверждения.",
      ],
      expectedResults: [
        "Прояснённый комплаенс-статус для онбординга / due diligence.",
        "Снижение регуляторных рисков за счёт документированных проверок.",
      ],
      workPlan: [
        "Скрининг по провайдерам (официальный API / ручной импорт).",
        "Проверка и документирование совпадений.",
        "Сдача комплаенс-раздела.",
      ],
    },
    {
      title: "Решение 3 — Википедия и авторитетность",
      objective:
        "Оценить авторитетное присутствие и согласованность панели знаний с постоянным мониторингом.",
      duration: "3–4 недели + мониторинг",
      includedItems: [
        "Оценка авторитетного профиля и значимости.",
        "Проверка согласованности панели знаний.",
        "Постоянный мониторинг цифрового следа.",
      ],
      deliverables: [
        "Раздел оценки авторитетности.",
        "План и периодичность мониторинга.",
      ],
      expectedResults: [
        "Больший контроль над авторитетным нарративом.",
        "Раннее предупреждение о новых негативных сигналах.",
      ],
      workPlan: [
        "Анализ значимости.",
        "Стратегия авторитетных источников.",
        "Настройка мониторинга.",
      ],
    },
  ],
};

const OFFER_TEXT: Record<ReportLanguage, OfferText> = { en: EN, ru: RU };

export function buildOfferConfig(language: ReportLanguage | string = "ru"): ReportOffer {
  const lang = normalizeReportLanguage(language);
  const text = OFFER_TEXT[lang];
  const currency = digitalProfileConfig.priceCurrency;
  const pricingNotes = process.env.DIGITAL_PROFILE_PRICING_NOTES ?? text.pricingNotes;
  const companyName = process.env.DIGITAL_PROFILE_COMPANY_NAME ?? text.productName;

  const solution1Title = process.env.DIGITAL_PROFILE_SOLUTION1_TITLE ?? text.solution1Title;
  const solution2Title = process.env.DIGITAL_PROFILE_SOLUTION2_TITLE ?? text.solution2Title;
  const solution3Title = process.env.DIGITAL_PROFILE_SOLUTION3_TITLE ?? text.solution3Title;

  const solution1Price = priceByCode("BASIC_AUDIT", 490);
  const solution2Price = priceByCode("STANDARD_AUDIT", 1290);
  const solution3Price = priceByCode("ENTERPRISE_AUDIT", 2900);
  const prices = [solution1Price, solution2Price, solution3Price];
  const subtitles = [solution1Title, solution2Title, solution3Title];
  const keys = ["digital-profile", "compliance-databases", "wikipedia"];

  const solutions: ReportOfferSolution[] = text.solutions.map((s, i) => ({
    key: keys[i],
    title: s.title,
    subtitle: subtitles[i],
    objective: s.objective,
    price: prices[i],
    currency,
    duration: s.duration,
    includedItems: s.includedItems,
    deliverables: s.deliverables,
    expectedResults: s.expectedResults,
    workPlan: s.workPlan,
    pricingNotes,
  }));

  return {
    productName: process.env.DIGITAL_PROFILE_PRODUCT_NAME ?? text.productName,
    solution1Title,
    solution1Price,
    solution2Title,
    solution2Price,
    solution3Title,
    solution3Price,
    currency,
    pricingNotes,
    companyName,
    contactEmail: process.env.DIGITAL_PROFILE_CONTACT_EMAIL ?? "contact@example.com",
    website: process.env.DIGITAL_PROFILE_WEBSITE ?? "https://example.com",
    brandName: process.env.DIGITAL_PROFILE_BRAND_NAME ?? companyName,
    reportSubtitle: process.env.DIGITAL_PROFILE_REPORT_SUBTITLE ?? text.reportSubtitle,
    companyDescription:
      process.env.DIGITAL_PROFILE_COMPANY_DESCRIPTION ?? text.companyDescription,
    solutions,
    processSteps: text.processSteps,
    callToAction: process.env.DIGITAL_PROFILE_CTA ?? text.callToAction,
    disclaimers: text.disclaimers,
  };
}
