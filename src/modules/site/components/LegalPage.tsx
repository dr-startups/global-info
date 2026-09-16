import { Fragment } from "react";
import { formatContentDate } from "@/modules/site/content/dates";
import type { LegalDocument } from "@/modules/site/content/legal";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd } from "@/modules/site/seo/json-ld";
import { Breadcrumbs } from "./content/Breadcrumbs";
import { RichText } from "./content/RichText";
import { JsonLd } from "./JsonLd";

/** Юридическая страница — черновик, и это видно до первого абзаца. Плейсхолдеры `{{…}}` видны на странице. */
export function LegalPage({ doc }: { doc: LegalDocument }) {
  const path = `/legal/${doc.slug}`;
  return (
    <main className="site-narrow site-page" id="main">
      <Breadcrumbs path={path} />
      <article>
        <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-5)" }}>
          <h1 className="site-h1">{doc.title}</h1>
          <p className="site-article__meta">
            <span>Черновик от {formatContentDate(doc.updated)}</span>
            <span>Версия {doc.version}</span>
          </p>
        </div>
        <div className="site-note" role="note">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <use href="#ic-warn" />
          </svg>
          <p>
            <b>Черновик, на проверку юристу заказчика.</b> Текст не опубликован и может измениться.
          </p>
        </div>
        <div className="site-prose" style={{ marginTop: "var(--site-s-6)" }}>
          {doc.sections.map((section) => (
            <Fragment key={section.heading}>
              <h2>{section.heading}</h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph}>
                  <RichText text={paragraph} />
                </p>
              ))}
              {section.items ? (
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>
                      <RichText text={item} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Fragment>
          ))}
        </div>
      </article>
      <JsonLd data={[breadcrumbLd(path, siteOrigin())]} />
    </main>
  );
}
