import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/modules/site/components/content/Breadcrumbs";
import { Cover } from "@/modules/site/components/content/Cover";
import { RichText } from "@/modules/site/components/content/RichText";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { ArrowIcon } from "@/modules/site/components/SiteIcons";
import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import { SERVICES, SERVICES_HUB } from "@/modules/site/content/services";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/uslugi");

/** Хаб услуг — по макету `#services`: проверка отдельным листом, три услуги строками, разбор и стоимость. */
export default function ServicesHubPage() {
  const [check, ...removal] = SERVICES;
  return (
    <main className="site-container site-page" id="main">
      <Breadcrumbs path={SERVICES_HUB.path} />

      <div className="site-page__head">
        <h1 className="site-h1">{SERVICES_HUB.h1}</h1>
        <p className="site-lead">{SERVICES_HUB.lead}</p>
      </div>

      <article className="site-offer site-ticks" aria-labelledby="offer-title">
        <Cover name={check!.cover} sizes="(min-width: 1168px) 536px, (min-width: 900px) 46vw, 100vw" />
        <div className="site-offer__body">
          <h2 className="site-h2" id="offer-title">
            {check!.hub.title}
          </h2>
          <p className="site-offer__text">{check!.hub.text}</p>
          <dl className="site-facts-inline">
            {check!.hub.facts.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="site-actions">
            <Link className="site-btn site-btn--accent site-btn--lg" href="/#form">
              {CHECK_FORM_TEXT.submit}
              <ArrowIcon />
            </Link>
            <Link className="site-btn site-btn--secondary site-btn--lg" href={check!.path}>
              {SERVICES_HUB.offerMore}
            </Link>
          </div>
        </div>
      </article>

      <section className="site-hub" aria-labelledby="hub-title">
        <div className="site-hub__head">
          <h2 className="site-h2" id="hub-title">
            {SERVICES_HUB.hubTitle}
          </h2>
          <p className="site-lead">{SERVICES_HUB.hubLead}</p>
        </div>
        <ul className="site-services">
          {removal.map((service) => (
            <li key={service.slug} className="site-service">
              <Cover name={service.cover} sizes="(min-width: 768px) 240px, 100vw" />
              <div className="site-service__body">
                <h3 className="site-h3">
                  <Link className="site-service__link" href={service.path}>
                    {service.hub.title}
                  </Link>
                </h3>
                <p>{service.hub.text}</p>
                <dl className="site-facts-inline">
                  {service.hub.facts.map(([term, value]) => (
                    <div key={term}>
                      <dt>{term}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <span className="site-service__arrow" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <use href="#ic-arrow" />
                </svg>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="site-hub__terms" aria-label="Как мы работаем">
        {SERVICES_HUB.terms.map((term) => (
          <div key={term.title}>
            <h2 className="site-h3">{term.title}</h2>
            <p>
              <RichText text={term.text} />
            </p>
          </div>
        ))}
      </section>
      <JsonLd data={[breadcrumbLd(SERVICES_HUB.path, siteOrigin())]} />
    </main>
  );
}
