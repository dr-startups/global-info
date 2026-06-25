/**
 * Commercial offer configuration for the report's static pages (Stage K1).
 *
 * Prices are NEVER hardcoded in slides/renderer — they come from the pricing
 * catalog (config) and env, and are serialized into report_json.offer so the
 * renderer only formats values it is given.
 */

import { digitalProfileConfig, reportPricing } from "../config";
import type { ReportOffer } from "../types";

function priceByCode(code: string, fallback: number): number {
  return reportPricing.find((p) => p.code === code)?.amount ?? fallback;
}

export function buildOfferConfig(): ReportOffer {
  return {
    productName:
      process.env.DIGITAL_PROFILE_PRODUCT_NAME ?? "Digital Profile Audit",
    solution1Title:
      process.env.DIGITAL_PROFILE_SOLUTION1_TITLE ?? "Digital Profile Audit — Basic",
    solution1Price: priceByCode("BASIC_AUDIT", 490),
    solution2Title:
      process.env.DIGITAL_PROFILE_SOLUTION2_TITLE ?? "Digital Profile Audit — Standard",
    solution2Price: priceByCode("STANDARD_AUDIT", 1290),
    solution3Title:
      process.env.DIGITAL_PROFILE_SOLUTION3_TITLE ?? "Digital Profile Audit — Enterprise",
    solution3Price: priceByCode("ENTERPRISE_AUDIT", 2900),
    currency: digitalProfileConfig.priceCurrency,
    pricingNotes:
      process.env.DIGITAL_PROFILE_PRICING_NOTES ??
      "Prices are indicative and exclude taxes. Final scope is agreed per engagement.",
    companyName: process.env.DIGITAL_PROFILE_COMPANY_NAME ?? "Digital Profile Audit",
    contactEmail: process.env.DIGITAL_PROFILE_CONTACT_EMAIL ?? "contact@example.com",
    website: process.env.DIGITAL_PROFILE_WEBSITE ?? "https://example.com",
  };
}
