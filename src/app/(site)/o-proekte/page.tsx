import type { Metadata } from "next";
import { Blocks } from "@/modules/site/components/content/Blocks";
import { Breadcrumbs } from "@/modules/site/components/content/Breadcrumbs";
import { CtaBand } from "@/modules/site/components/content/CtaBand";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { ABOUT } from "@/modules/site/content/about";
import { FINAL } from "@/modules/site/content/landing";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/o-proekte");

export default function AboutPage() {
  return (
    <main className="site-narrow site-page" id="main">
      <Breadcrumbs path={ABOUT.path} />
      <div className="site-stack" style={{ gap: "var(--site-s-4)" }}>
        <h1 className="site-h1">{ABOUT.h1}</h1>
        <p className="site-lead">{ABOUT.lead}</p>
      </div>
      <Blocks blocks={ABOUT.blocks} firstProseStyle={{ marginTop: "var(--site-s-6)" }} />
      <CtaBand title={FINAL.title} text={FINAL.lead} />
      <JsonLd data={[breadcrumbLd(ABOUT.path, siteOrigin())]} />
    </main>
  );
}
