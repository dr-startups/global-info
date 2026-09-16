import type { MetadataRoute } from "next";
import { siteManifest } from "@/modules/site/seo/manifest";

export default function manifest(): MetadataRoute.Manifest {
  return siteManifest();
}
