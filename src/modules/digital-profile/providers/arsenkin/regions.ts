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

/**
 * Map Arsenkin numeric location IDs (and loose labels) to ORION RU/UAE.
 * `1011981` is Google UAE — must not collapse to RU via digit→RU heuristics.
 */
export function arsenkinRegionIdToLabel(
  raw: string | number | null | undefined
): "RU" | "UAE" | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/UAE|^AE$|INTL|INTERNATIONAL|GLOBAL|DUBAI/i.test(s)) return "UAE";
  if (/^RU\b|RUSSIA|МОСКВА|MOSCOW|MSK|SPB/i.test(s)) return "RU";
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === ARSENKIN_REGION.GOOGLE_UAE) return "UAE";
  if (n === ARSENKIN_REGION.YANDEX_MOSCOW || n === ARSENKIN_REGION.GOOGLE_MOSCOW) return "RU";
  return null;
}

/** Best-effort RU/UAE from ProviderTask.requestJson (se[].region / data.region). */
export function resolveRegionLabelFromArsenkinRequest(
  requestJson: unknown
): "RU" | "UAE" | null {
  if (requestJson == null || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    return null;
  }
  const root = requestJson as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const direct = arsenkinRegionIdToLabel(data.region as string | number | undefined);
  if (direct) return direct;
  const se = data.se;
  if (Array.isArray(se)) {
    for (const row of se) {
      if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
      const label = arsenkinRegionIdToLabel((row as { region?: unknown }).region as string | number);
      if (label === "UAE") return "UAE";
      if (label === "RU") return "RU";
    }
  }
  return arsenkinRegionIdToLabel(se as string | number | undefined);
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
