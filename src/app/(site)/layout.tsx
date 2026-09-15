import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./site.css";
import { siteMetadata } from "@/modules/site/seo/metadata";
import { SiteChrome } from "@/modules/site/components/SiteChrome";

export const metadata: Metadata = siteMetadata();

export const viewport: Viewport = { themeColor: "#F5F5F2" };

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteChrome>{children}</SiteChrome>;
}
