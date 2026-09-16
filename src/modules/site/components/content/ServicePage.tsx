import Link from "next/link";
import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import type { ServiceContent } from "@/modules/site/content/services";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd, serviceLd } from "@/modules/site/seo/json-ld";
import { JsonLd } from "../JsonLd";
import { Blocks } from "./Blocks";
import { Breadcrumbs } from "./Breadcrumbs";
import { Cover } from "./Cover";
import { CtaBand } from "./CtaBand";
import { RichText } from "./RichText";

/** Страница услуги — по макету `#service` и `#service-search`: текст слева, цена и кнопка справа. */
export function ServicePage({ service }: { service: ServiceContent }) {
  const origin = siteOrigin();
  return (
    <main className="site-container site-page" id="main">
      <Breadcrumbs path={service.path} />
      <div className="site-layout-2">
        <article>
          <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-6)" }}>
            <h1 className="site-h1">{service.h1}</h1>
            <p className="site-lead">{service.lead}</p>
          </div>

          <dl className="site-stat-row">
            {service.stats.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <Cover
            name={service.cover}
            page
            sizes="(min-width: 1024px) 736px, 100vw"
            style={{ margin: "var(--site-s-6) 0 0" }}
          />

          <Blocks blocks={service.blocks} />
          <CtaBand title={service.cta.title} text={service.cta.text} />
        </article>

        <aside className="site-aside">
          <div className="site-price">
            <p>
              <strong className="site-h3">{service.aside.title}</strong>
            </p>
            {service.aside.paragraphs.map((text) => (
              <p key={text}>
                <RichText text={text} />
              </p>
            ))}
            <Link className="site-btn site-btn--accent site-btn--block" href="/#form">
              {CHECK_FORM_TEXT.submit}
            </Link>
          </div>
        </aside>
      </div>
      <JsonLd data={[serviceLd(service, origin), breadcrumbLd(service.path, origin)]} />
    </main>
  );
}
