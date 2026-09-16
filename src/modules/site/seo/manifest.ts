/**
 * Манифест сайта. Цвет темы — бумага сайта, тот же, что `themeColor` в layout сайта.
 */

import type { MetadataRoute } from "next";
import { SITE_NAME } from "./metadata";

export const SITE_THEME_COLOR = "#F5F5F2";

export function siteManifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: "Бесплатная проверка репутации по открытым источникам.",
    lang: "ru",
    start_url: "/",
    display: "browser",
    background_color: SITE_THEME_COLOR,
    theme_color: SITE_THEME_COLOR,
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
