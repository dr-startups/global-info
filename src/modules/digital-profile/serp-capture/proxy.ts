import type { SerpCaptureRegion } from "./types";

export function resolveSerpCaptureProxy(region: SerpCaptureRegion): string | undefined {
  const key = region === "UAE" ? "SERP_CAPTURE_PROXY_UAE" : "SERP_CAPTURE_PROXY_RU";
  const value = process.env[key]?.trim();
  return value || undefined;
}

export function isProductionLikeEnvironment(): boolean {
  const env = (process.env.NODE_ENV ?? "").toLowerCase();
  const railway = (process.env.RAILWAY_ENVIRONMENT ?? "").toLowerCase();
  return env === "production" || railway === "production";
}
