/**
 * Arsenkin region / SE type helpers for First36 RU + UAE pilot.
 */

export type ArsenkinSeType =
  | 1 // Yandex XML
  | 2 // Yandex Desktop
  | 3 // Yandex Mobile
  | 11 // Google Desktop
  | 12; // Google Mobile

/** Common Arsenkin region IDs used in the pilot. */
export const ARSENKIN_REGION = {
  YANDEX_MOSCOW: 213,
  GOOGLE_MOSCOW: 1011969,
  /** United Arab Emirates (Google locations list). */
  GOOGLE_UAE: 1011981,
} as const;

export function seTypeToEngine(seType: number): "GOOGLE" | "YANDEX" {
  if (seType === 11 || seType === 12) return "GOOGLE";
  return "YANDEX";
}

export function seTypeToDevice(seType: number): "DESKTOP" | "MOBILE" {
  if (seType === 3 || seType === 12) return "MOBILE";
  return "DESKTOP";
}

export function pilotSeForRegion(region: "RU" | "UAE"): Array<{ type: ArsenkinSeType; region: number }> {
  if (region === "UAE") {
    return [{ type: 11, region: ARSENKIN_REGION.GOOGLE_UAE }];
  }
  return [
    { type: 2, region: ARSENKIN_REGION.YANDEX_MOSCOW },
    { type: 11, region: ARSENKIN_REGION.GOOGLE_MOSCOW },
  ];
}
