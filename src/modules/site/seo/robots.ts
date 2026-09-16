/**
 * `robots.txt` сайта. Закрытый сайт запрещает всё; открытый закрывает админку, API и
 * мастер проверки — у мастера в адресе проверка конкретного человека.
 */

import type { MetadataRoute } from "next";
import { siteIndexing } from "./indexing";

export function siteRobots(env: Record<string, string | undefined> = process.env): MetadataRoute.Robots {
  const indexing = siteIndexing(env);
  if (!indexing.open) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/check"] },
    sitemap: new URL("/sitemap.xml", indexing.origin).href,
  };
}
