import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./site.css";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { SiteChrome } from "@/modules/site/components/SiteChrome";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { organizationLd } from "@/modules/site/seo/json-ld";
import { SITE_THEME_COLOR } from "@/modules/site/seo/manifest";
import { siteMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = siteMetadata();

export const viewport: Viewport = { themeColor: SITE_THEME_COLOR };

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <SiteChrome>
      {children}
      <JsonLd data={[organizationLd(siteOrigin())]} />
    </SiteChrome>
  );
}
