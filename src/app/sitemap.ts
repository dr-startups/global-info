import type { MetadataRoute } from "next";
import { siteSitemap } from "@/modules/site/seo/sitemap";

/** `sitemap.xml` — только в корне app; список страниц — реестр сайта. */
export default function sitemap(): MetadataRoute.Sitemap {
  return siteSitemap();
}
