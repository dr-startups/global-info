/**
 * R10.11 — Registry sectionId → renderer template mapping for classic ORION audit.
 */

export type ClassicSectionTemplate =
  | "orion_golden_executive_card"
  | "orion_golden_risk_matrix"
  | "orion_golden_region_divider"
  | "orion_golden_audit_dashboard"
  | "orion_golden_search_overview"
  | "orion_golden_search_table"
  | "orion_golden_serp_screenshot"
  | "orion_golden_wikipedia"
  | "orion_golden_image_grid"
  | "orion_golden_video_cards"
  | "orion_golden_knowledge_panel"
  | "orion_golden_compliance_summary"
  | "orion_golden_lexis_summary"
  | "orion_golden_lexis_visual_page"
  | "orion_golden_appendix";

export function templateForRegistrySection(sectionId: string): ClassicSectionTemplate {
  if (sectionId === "01_executive_summary") return "orion_golden_executive_card";
  if (sectionId === "02_compliance_risk_matrix") return "orion_golden_risk_matrix";
  if (sectionId === "03_digital_profile_overview") return "orion_golden_audit_dashboard";
  if (sectionId.endsWith("_serp_position_table")) return "orion_golden_search_table";
  if (sectionId.includes("undesirable_theme")) return "orion_golden_search_overview";
  if (sectionId.includes("suggestions") || sectionId.includes("related_queries")) {
    return "orion_golden_search_table";
  }
  if (sectionId.includes("wikipedia")) return "orion_golden_wikipedia";
  if (sectionId.includes("_images")) return "orion_golden_image_grid";
  if (sectionId.includes("_videos")) return "orion_golden_video_cards";
  if (sectionId.includes("knowledge_panel")) return "orion_golden_knowledge_panel";
  if (sectionId === "44_lexisnexis_profile") return "orion_golden_lexis_summary";
  if (sectionId.startsWith("4") && sectionId !== "44_lexisnexis_profile") {
    return "orion_golden_compliance_summary";
  }
  if (sectionId.startsWith("5")) return "orion_golden_appendix";
  if (sectionId.includes("search_links")) return "orion_golden_search_table";
  if (sectionId.includes("audit_summary")) return "orion_golden_audit_dashboard";
  return "orion_golden_audit_dashboard";
}

export function bulletsPerSlideForSection(sectionId: string): number {
  if (sectionId.includes("suggestions") || sectionId.includes("related_queries")) return 12;
  if (sectionId.includes("search_links")) return 8;
  if (sectionId.includes("undesirable_theme")) return 5;
  if (sectionId.includes("serp_position")) return 18;
  if (sectionId.startsWith("5")) return 6;
  return 6;
}

export function isRegionDividerSection(sectionId: string): boolean {
  return sectionId === "10_ru_audit_summary" || sectionId === "30_uae_audit_summary";
}

export function regionDividerTitle(sectionId: string): string | null {
  if (sectionId === "10_ru_audit_summary") return "Россия: Цифровой профиль";
  if (sectionId === "30_uae_audit_summary") return "ОАЭ: Цифровой профиль";
  return null;
}

export function assetSectionKeyForRegistry(sectionId: string): string | null {
  if (sectionId === "12_ru_serp_position_table") return "ru_serp_screenshots";
  if (sectionId === "32_uae_serp_position_table") return "uae_serp_screenshots";
  if (sectionId === "17_ru_yandex_images" || sectionId === "18_ru_google_images") return "ru_images";
  if (sectionId === "36_uae_google_images") return "uae_images";
  if (sectionId === "19_ru_videos") return "ru_videos";
  if (sectionId === "37_uae_google_videos") return "uae_videos";
  if (sectionId === "20_ru_yandex_knowledge_panel" || sectionId === "21_ru_google_knowledge_panel") {
    return "ru_knowledge";
  }
  if (sectionId === "38_uae_google_knowledge_panel") return "uae_knowledge";
  if (sectionId === "44_lexisnexis_profile") return "lexisnexis_visual";
  return null;
}
