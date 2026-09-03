/**
 * Stage O3 — search region profiles (RU / UAE / INTERNATIONAL).
 *
 * Maps each audit region to provider geo/language parameters. Yandex is RU-only;
 * Google Serper handles all three when configured.
 */

import type { OrionRegionCode } from "./orion-query-plan";

export type RegionCollectionStatus =
  | "COLLECTED"
  | "NOT_QUERIED"
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "PARTIAL"
  /**
   * Выдачу этого региона собирает другой источник (режим `topvisor`).
   *
   * Отдельное слово, а не «не настроено»: ключи на месте, и страница покрытия
   * иначе печатала бы клиенту неправду о собственном сборе.
   */
  | "DELEGATED";

export interface RegionProfile {
  code: OrionRegionCode;
  label: string;
  language: string;
  googleGl: string;
  googleHl: string;
  /** Optional Serper location hint (human-readable). */
  googleLocation?: string;
  yandexSupported: boolean;
}

export const REGION_PROFILES: Record<OrionRegionCode, RegionProfile> = {
  RU: {
    code: "RU",
    label: "Russia",
    language: "ru",
    googleGl: "ru",
    googleHl: "ru",
    yandexSupported: true,
  },
  UAE: {
    code: "UAE",
    label: "United Arab Emirates",
    language: "en",
    googleGl: "ae",
    googleHl: "en",
    googleLocation: "United Arab Emirates",
    yandexSupported: false,
  },
  INTERNATIONAL: {
    code: "INTERNATIONAL",
    label: "International",
    language: "en",
    googleGl: "us",
    googleHl: "en",
    yandexSupported: false,
  },
};

export function regionProfile(code: OrionRegionCode): RegionProfile {
  return REGION_PROFILES[code];
}
