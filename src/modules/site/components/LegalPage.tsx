import Link from "next/link";
import { Fragment } from "react";
import type { LegalDocument } from "@/modules/site/content/legal";
import { Value } from "./Value";

/** Текст с плейсхолдерами `{{…}}`: незаполненные значения видны на странице. */
function WithPlaceholders({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\{\{[^}]+\}\})/u).map((part, i) => (
        <Value key={i} text={part} />
      ))}
    </>
  );
}

/** Юридическая страница — черновик, и это видно до первого абзаца. */
export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <main className="site-narrow site-page" id="main">
      <ol className="site-breadcrumbs" aria-label="Вы здесь">
        <li>
          <Link href="/">Главная</Link>
        </li>
        <li>{doc.title}</li>
      </ol>
      <article>
        <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-5)" }}>
          <h1 className="site-h1">{doc.title}</h1>
          <p className="site-article__meta">
            <span>Черновик от {doc.updated}</span>
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
                  <WithPlaceholders text={paragraph} />
                </p>
              ))}
              {section.items ? (
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>
                      <WithPlaceholders text={item} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Fragment>
          ))}
        </div>
      </article>
    </main>
  );
}
