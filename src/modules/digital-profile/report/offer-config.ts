/**
 * Commercial offer configuration for the report's static pages (Stage K1).
 *
 * Prices are NEVER hardcoded in slides/renderer — they come from the pricing
 * catalog (config) and env, and are serialized into report_json.offer so the
 * renderer only formats values it is given.
 */

import { digitalProfileConfig, reportPricing } from "../config";
import type { ReportOffer, ReportOfferSolution } from "../types";

function priceByCode(code: string, fallback: number): number {
  return reportPricing.find((p) => p.code === code)?.amount ?? fallback;
}

export function buildOfferConfig(): ReportOffer {
  const currency = digitalProfileConfig.priceCurrency;
  const pricingNotes =
    process.env.DIGITAL_PROFILE_PRICING_NOTES ??
    "Prices are indicative and exclude taxes. Final scope is agreed per engagement.";
  const companyName = process.env.DIGITAL_PROFILE_COMPANY_NAME ?? "Digital Profile Audit";

  const solution1Title =
    process.env.DIGITAL_PROFILE_SOLUTION1_TITLE ?? "Digital Profile Audit — Basic";
  const solution2Title =
    process.env.DIGITAL_PROFILE_SOLUTION2_TITLE ?? "Digital Profile Audit — Standard";
  const solution3Title =
    process.env.DIGITAL_PROFILE_SOLUTION3_TITLE ?? "Digital Profile Audit — Enterprise";

  const solution1Price = priceByCode("BASIC_AUDIT", 490);
  const solution2Price = priceByCode("STANDARD_AUDIT", 1290);
  const solution3Price = priceByCode("ENTERPRISE_AUDIT", 2900);

  const solutions: ReportOfferSolution[] = [
    {
      key: "digital-profile",
      title: "Solution 1 — Digital Profile",
      subtitle: solution1Title,
      objective:
        "Build an evidence-based map of the subject's open-source digital footprint across regions.",
      price: solution1Price,
      currency,
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
      pricingNotes,
    },
    {
      key: "compliance-databases",
      title: "Solution 2 — Compliance Databases",
      subtitle: solution2Title,
      objective:
        "Screen the subject against major compliance databases via official APIs or manual import.",
      price: solution2Price,
      currency,
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
      pricingNotes,
    },
    {
      key: "wikipedia",
      title: "Solution 3 — Wikipedia & Authority",
      subtitle: solution3Title,
      objective:
        "Assess authoritative presence and knowledge-panel consistency, with ongoing monitoring.",
      price: solution3Price,
      currency,
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
      pricingNotes,
    },
  ];

  return {
    productName:
      process.env.DIGITAL_PROFILE_PRODUCT_NAME ?? "Digital Profile Audit",
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
    reportSubtitle:
      process.env.DIGITAL_PROFILE_REPORT_SUBTITLE ??
      "Digital footprint & compliance audit",
    companyDescription:
      process.env.DIGITAL_PROFILE_COMPANY_DESCRIPTION ??
      "We deliver evidence-first digital profile and compliance audits. Every statement references verifiable evidence — a URL, a screenshot, an imported record — and compliance screening uses official APIs or manual import only.",
    solutions,
    processSteps: [
      "Audit — collect open-source and compliance evidence.",
      "Analysis — deterministic risk classification.",
      "Strategy — prioritise findings and remediation.",
      "Execution — address negative items and strengthen authority.",
      "Monitoring — track the footprint over time.",
    ],
    callToAction:
      process.env.DIGITAL_PROFILE_CTA ??
      "Contact our team to scope an engagement and agree lawful basis.",
    disclaimers: [
      "This report is advisory; all findings require manual verification before any decision.",
      "No leaked or illegally obtained datasets are used. Compliance screening uses official APIs or manual import only.",
    ],
  };
}
