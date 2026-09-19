import { ARTICLE_AUTHOR, type ArticleContent, readingTimeText } from "@/modules/site/content/articles";
import { formatContentDate } from "@/modules/site/content/dates";
import { sitePage } from "@/modules/site/content/pages";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { articleLd, breadcrumbLd, faqLd } from "@/modules/site/seo/json-ld";
import { JsonLd } from "../JsonLd";
import { Blocks, tocAnchors } from "./Blocks";
import { Breadcrumbs } from "./Breadcrumbs";
import { Cover } from "./Cover";
import { CtaBand } from "./CtaBand";

const ARTICLE_CTA = {
  title: "Проверьте, что о вас находят в интернете",
  text: "Несколько минут, и вы знаете, есть ли негатив и в каких темах.",
};

/** Статья блога — по макету `#article`: заголовок, автор и дата, обложка, содержание, текст, проверка. */
export function ArticlePage({ article }: { article: ArticleContent }) {
  const origin = siteOrigin();
  const page = sitePage(article.path);
  const toc = tocAnchors(article.blocks);
  const faq = article.blocks.flatMap((block) => (block.type === "faq" ? block.items : []));
  return (
    <>
      <main className="site-narrow site-page" id="main">
        <Breadcrumbs path={article.path} />
        <article>
          <div className="site-stack" style={{ gap: "var(--site-s-4)", marginBottom: "var(--site-s-5)" }}>
            <h1 className="site-h1">{page.h1}</h1>
            <p className="site-article__meta">
              <span>Автор: {ARTICLE_AUTHOR}</span>
              <span>Обновлено {formatContentDate(article.updated)}</span>
              <span>{readingTimeText(article)}</span>
            </p>
          </div>

          <Cover
            name={article.cover}
            page
            sizes="(min-width: 1024px) 736px, 100vw"
            style={{ margin: "0 0 var(--site-s-6)" }}
          />

          {toc.length > 0 ? (
            <nav className="site-toc" aria-label="Содержание">
              <p className="site-toc__title">Содержание</p>
              <ol>
                {toc.map((entry) => (
                  <li key={entry.id}>
                    <a href={`#${entry.id}`}>{entry.label}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}

          <Blocks blocks={article.blocks} firstProseStyle={{ marginTop: "var(--site-s-6)" }} />
        </article>
        <JsonLd
          data={[
            articleLd(article, origin),
            breadcrumbLd(article.path, origin),
            ...(faq.length > 0 ? [faqLd(faq)] : []),
          ]}
        />
      </main>
      {/* Закрывающий блок идёт во всю ширину окна, поэтому стоит за узкой колонкой статьи */}
      <CtaBand title={ARTICLE_CTA.title} text={ARTICLE_CTA.text} />
    </>
  );
}
