/**
 * Canonical First36 base slots (mirrors orion-first36-registry.v1) and their
 * ownership by deck-section fragments. The assembled deck must preserve all
 * 36 base slots (baseSlotCoverage=36); continuations are added on demand.
 */

import type { FragmentKey } from "./contracts";
import type { DeckTemplateId } from "./template-registry";

export type CanonicalSlotDef = {
  slotId: string;
  page: number;
  fragmentKey: FragmentKey;
  title: string;
  templateId: DeckTemplateId;
};

export const CANONICAL_BASE_SLOTS: CanonicalSlotDef[] = [
  { page: 1, slotId: "p01_cover", fragmentKey: "FRONT_MATTER_MAIN", title: "ORION Digital Profile", templateId: "cover" },
  { page: 2, slotId: "p02_toc", fragmentKey: "FRONT_MATTER_MAIN", title: "Содержание отчёта", templateId: "toc" },
  { page: 3, slotId: "p03_executive", fragmentKey: "EXECUTIVE_SUMMARY", title: "Резюме", templateId: "executive-summary" },
  { page: 4, slotId: "p04_risk_dashboard", fragmentKey: "RISK_MATRIX", title: "Матрица комплаенс-рисков", templateId: "risk-matrix" },
  { page: 5, slotId: "p05_profile_dashboard", fragmentKey: "DIGITAL_PROFILE_OVERVIEW", title: "Обзор цифрового профиля", templateId: "regional-summary" },
  { page: 6, slotId: "p06_ru_toc", fragmentKey: "RU_SUMMARY", title: "Россия: Цифровой профиль", templateId: "section-divider" },
  { page: 7, slotId: "p07_ru_summary", fragmentKey: "RU_SUMMARY", title: "Россия — резюме аудита", templateId: "regional-summary" },
  { page: 8, slotId: "p08_ru_metrics", fragmentKey: "RU_SUMMARY", title: "Россия — метрики и проверка URL", templateId: "serp-table" },
  { page: 9, slotId: "p09_ru_serp_table", fragmentKey: "RU_SERP", title: "Россия — позиции в поисковой выдаче", templateId: "serp-table" },
  { page: 10, slotId: "p10_ru_serp_visual", fragmentKey: "RU_SERP_SCREENSHOT", title: "Россия — снимок выдачи", templateId: "serp-screenshot-analysis" },
  { page: 11, slotId: "p11_ru_suggestions_yandex", fragmentKey: "RU_SUGGESTIONS", title: "Россия — подсказки Яндекса", templateId: "suggestions" },
  { page: 12, slotId: "p12_ru_suggestions_google", fragmentKey: "RU_SUGGESTIONS", title: "Россия — подсказки Google", templateId: "suggestions" },
  { page: 13, slotId: "p13_ru_wikipedia", fragmentKey: "RU_IDENTITY_WIKIPEDIA", title: "Россия — Википедия", templateId: "wikipedia-check" },
  { page: 14, slotId: "p14_ru_images_1", fragmentKey: "RU_IMAGES", title: "Россия — изображения (1)", templateId: "image-grid" },
  { page: 15, slotId: "p15_ru_images_2", fragmentKey: "RU_IMAGES", title: "Россия — изображения (2)", templateId: "image-grid" },
  { page: 16, slotId: "p16_ru_images_3", fragmentKey: "RU_IMAGES", title: "Россия — изображения (3)", templateId: "image-grid" },
  { page: 17, slotId: "p17_ru_images_4", fragmentKey: "RU_IMAGES", title: "Россия — изображения (4)", templateId: "image-grid" },
  { page: 18, slotId: "p18_ru_knowledge_1", fragmentKey: "RU_KNOWLEDGE_AI", title: "Россия — панель знаний", templateId: "wikipedia-knowledge" },
  { page: 19, slotId: "p19_ru_knowledge_2", fragmentKey: "RU_KNOWLEDGE_AI", title: "Россия — AI-ответы поисковых систем", templateId: "ai-overview" },
  { page: 20, slotId: "p20_ru_related_1", fragmentKey: "RU_RELATED", title: "Россия — связанные запросы (1)", templateId: "related-queries" },
  { page: 21, slotId: "p21_ru_related_2", fragmentKey: "RU_RELATED", title: "Россия — связанные запросы (2)", templateId: "related-queries" },
  { page: 22, slotId: "p22_ru_related_3", fragmentKey: "RU_RELATED", title: "Россия — связанные запросы (3)", templateId: "related-queries" },
  { page: 23, slotId: "p23_uae_toc", fragmentKey: "UAE_SUMMARY", title: "ОАЭ: Цифровой профиль", templateId: "section-divider" },
  { page: 24, slotId: "p24_uae_summary", fragmentKey: "UAE_SUMMARY", title: "ОАЭ — резюме аудита", templateId: "regional-summary" },
  { page: 25, slotId: "p25_uae_metrics", fragmentKey: "UAE_SUMMARY", title: "ОАЭ — метрики покрытия", templateId: "serp-table" },
  { page: 26, slotId: "p26_uae_serp_table", fragmentKey: "UAE_SERP", title: "ОАЭ — позиции в поисковой выдаче", templateId: "serp-table" },
  { page: 27, slotId: "p27_uae_serp_visual", fragmentKey: "UAE_SERP_SCREENSHOT", title: "ОАЭ — снимок выдачи", templateId: "serp-screenshot-analysis" },
  { page: 28, slotId: "p28_uae_suggestions", fragmentKey: "UAE_SUGGESTIONS", title: "ОАЭ — подсказки поиска", templateId: "suggestions" },
  { page: 29, slotId: "p29_uae_wikipedia", fragmentKey: "UAE_IDENTITY_WIKIPEDIA", title: "ОАЭ — Википедия", templateId: "wikipedia-check" },
  { page: 30, slotId: "p30_uae_images", fragmentKey: "UAE_IMAGES", title: "ОАЭ — изображения в поиске", templateId: "image-grid" },
  { page: 31, slotId: "p31_uae_knowledge", fragmentKey: "UAE_KNOWLEDGE_AI", title: "ОАЭ — панель знаний и AI Overview", templateId: "ai-overview" },
  { page: 32, slotId: "p32_uae_related", fragmentKey: "UAE_RELATED", title: "ОАЭ — связанные запросы", templateId: "related-queries" },
  { page: 33, slotId: "p33_compliance_toc", fragmentKey: "COMPLIANCE_MAIN", title: "Комплаенс — сводка баз данных", templateId: "finding-cards" },
  { page: 34, slotId: "p34_dow_jones", fragmentKey: "COMPLIANCE_MAIN", title: "Dow Jones — профиль", templateId: "finding-cards" },
  { page: 35, slotId: "p35_lexis_visual", fragmentKey: "COMPLIANCE_MAIN", title: "LexisNexis — страница профиля", templateId: "serp-screenshot-analysis" },
  { page: 36, slotId: "p36_lexis_visual_2", fragmentKey: "COMPLIANCE_MAIN", title: "LexisNexis — страница профиля (2)", templateId: "serp-screenshot-analysis" },
];

export const CANONICAL_SLOT_IDS = CANONICAL_BASE_SLOTS.map((s) => s.slotId);

/**
 * Explicit, reviewed slot merges: the source slot's v72 content does not
 * justify a standalone page in the current offline dataset, and its material
 * is carried in full by the target slot. Merged slots still count towards
 * baseSlotCoverage=36 because their content mapping is explicit and lossless.
 */
export const EXPLICIT_SLOT_MERGES: Array<{
  baseSlotId: string;
  mergedInto: string;
  reason: string;
}> = [
  {
    baseSlotId: "p36_lexis_visual_2",
    mergedInto: "p35_lexis_visual",
    reason:
      "Обе страницы LexisNexis в v72 показывали один экспорт профиля; в текущем офлайн-наборе визуальный экспорт недоступен, а всё содержимое (совпадение ADVERSE_MEDIA и его статус) полностью помещается на одной странице. Вторая страница была бы пустым дублирующим placeholder-ом.",
  },
];

export const MERGED_SLOT_IDS = new Set(EXPLICIT_SLOT_MERGES.map((m) => m.baseSlotId));

export function slotsForFragment(fragmentKey: FragmentKey): CanonicalSlotDef[] {
  return CANONICAL_BASE_SLOTS.filter((s) => s.fragmentKey === fragmentKey);
}

/**
 * One observation/result actually visible on a bound visual asset, resolved
 * at load time from the run's own data (composite observations + the same
 * highlight classifier the snapshot generator used). Builders consume this
 * metadata only — they never re-analyze the raw dataset.
 */
export type VisibleAssetItem = {
  ref: string;
  url?: string;
  domain?: string;
  title?: string;
  engine?: string;
  region?: string;
  /** True when the source snapshot red-frames this row (adverse theme). */
  adverse?: boolean;
  /** Client-safe adverse theme title from the highlight classifier. */
  themeTitle?: string;
};

/** Metadata of a bound visual asset (image bytes stay in the renderer payload). */
export type VisualAssetMeta = {
  assetRef: string;
  kind: string;
  title: string;
  hasImage: boolean;
  /** Evidence refs of the observations actually visible on the asset. */
  evidenceRefs?: string[];
  /** Source domains of the observations actually visible on the asset. */
  evidenceDomains?: string[];
  /** Per-row visibility metadata (url/domain/engine/adverse) for the asset. */
  visibleItems?: VisibleAssetItem[];
};

export type VisualAssetsBySlot = Record<string, VisualAssetMeta[]>;
