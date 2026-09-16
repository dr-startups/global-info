import type { Metadata } from "next";
import { Blocks } from "@/modules/site/components/content/Blocks";
import { Breadcrumbs } from "@/modules/site/components/content/Breadcrumbs";
import { RichText } from "@/modules/site/components/content/RichText";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { CONTACTS_PAGE } from "@/modules/site/content/about";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/kontakty");

/** Контакты — плейсхолдерами, пока заказчик их не дал: выдуманный телефон хуже видимой заглушки. */
export default function ContactsPage() {
  return (
    <main className="site-narrow site-page" id="main">
      <Breadcrumbs path={CONTACTS_PAGE.path} />
      <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-6)" }}>
        <h1 className="site-h1">{CONTACTS_PAGE.h1}</h1>
        <p className="site-lead">{CONTACTS_PAGE.lead}</p>
      </div>
      <dl className="site-facts">
        {CONTACTS_PAGE.facts.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>
              <RichText text={value} />
            </dd>
          </div>
        ))}
      </dl>
      <Blocks blocks={CONTACTS_PAGE.blocks} firstProseStyle={{ marginTop: "var(--site-s-6)" }} />
      <JsonLd data={[breadcrumbLd(CONTACTS_PAGE.path, siteOrigin())]} />
    </main>
  );
}
