import type { Metadata } from "next";
import { Breadcrumbs } from "@/modules/site/components/content/Breadcrumbs";
import { CtaBand } from "@/modules/site/components/content/CtaBand";
import { Faq } from "@/modules/site/components/Faq";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { FAQ_PAGE } from "@/modules/site/content/faq";
import { FINAL } from "@/modules/site/content/landing";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd, faqLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/voprosy");

/** Вопросы и ответы группами; раскрывающиеся ответы — те же, что у блока вопросов на главной. */
export default function FaqPage() {
  const origin = siteOrigin();
  return (
    <>
      <main className="site-narrow site-page" id="main">
        <Breadcrumbs path={FAQ_PAGE.path} />
        <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-6)" }}>
          <h1 className="site-h1">{FAQ_PAGE.h1}</h1>
          <p className="site-lead">{FAQ_PAGE.lead}</p>
        </div>

        {FAQ_PAGE.groups.map((group, i) => (
          <section
            key={group.title}
            aria-labelledby={`faq-group-${i + 1}`}
            style={{ marginTop: i === 0 ? undefined : "var(--site-s-7)" }}
          >
            <h2 className="site-h2" id={`faq-group-${i + 1}`}>
              {group.title}
            </h2>
            <Faq items={group.items} style={{ marginTop: "var(--site-s-4)" }} />
          </section>
        ))}

        <JsonLd
          data={[faqLd(FAQ_PAGE.groups.flatMap((group) => group.items)), breadcrumbLd(FAQ_PAGE.path, origin)]}
        />
      </main>
      {/* Закрывающий блок идёт во всю ширину окна, поэтому стоит за узкой колонкой страницы */}
      <CtaBand title={FINAL.title} text={FINAL.lead} />
    </>
  );
}
