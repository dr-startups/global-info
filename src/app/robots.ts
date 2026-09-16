import type { MetadataRoute } from "next";
import { siteRobots } from "@/modules/site/seo/robots";

/** `robots.txt` — только в корне app; ответ, открыт ли сайт поиску, — у сайта. */
export default function robots(): MetadataRoute.Robots {
  return siteRobots();
}
