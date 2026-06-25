/**
 * Static commercial report pages (the services offering shown after the dynamic,
 * person-specific section). Content is configuration, not collected evidence, so
 * these pages carry no `evidence` refs and are flagged `isStatic`.
 *
 * Prices come from `reportPricing` (config) and are substituted as variables so
 * they can be edited without touching report-building code.
 */

import { reportPricing } from "../config";
import type { ReportPageData, ReportPriceItem } from "../types";

function formatPrice(item: ReportPriceItem): string {
  return `${item.amount.toLocaleString("en-US")} ${item.currency}`;
}

/** Builds the ordered list of static commercial pages. */
export function buildStaticPages(
  pricing: ReportPriceItem[] = reportPricing
): ReportPageData[] {
  return [
    {
      kind: "STATIC_OFFER",
      templateSlide: "static_offer",
      isStatic: true,
      title: "How we can help",
      subtitle: "Digital Profile Audit — services overview",
      body: [
        "We deliver evidence-based digital profile and compliance audits.",
        "Every statement in our reports references verifiable evidence: a URL, a screenshot, an imported file, or a database record.",
        "Compliance database screening (LexisNexis, Dow Jones, World-Check) is performed only via official API connectors or manual import.",
      ],
    },
    {
      kind: "STATIC_PRICING",
      templateSlide: "static_pricing",
      isStatic: true,
      title: "Packages & pricing",
      subtitle: "Choose the depth of audit that fits your needs",
      table: {
        columns: ["Package", "What's included", "Price"],
        rows: pricing.map((p) => [p.label, p.note ?? "", formatPrice(p)]),
      },
    },
    {
      kind: "STATIC_CONTACT",
      templateSlide: "static_contact",
      isStatic: true,
      title: "Get in touch",
      body: [
        "Ready to start an audit or have questions about scope and lawful basis?",
        "Contact our compliance team to discuss your requirements.",
      ],
    },
  ];
}
