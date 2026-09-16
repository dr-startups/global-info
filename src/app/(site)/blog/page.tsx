import type { Metadata } from "next";
import { BlogList } from "@/modules/site/components/content/BlogList";
import { Breadcrumbs } from "@/modules/site/components/content/Breadcrumbs";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { ARTICLES, BLOG, BLOG_TOPICS, readingTimeText } from "@/modules/site/content/articles";
import { formatContentDate } from "@/modules/site/content/dates";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { breadcrumbLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/blog");

/** Список статей — по макету `#blog`. Фильтр — на клиенте, тексты статей в браузер не уходят. */
export default function BlogPage() {
  const posts = ARTICLES.map((article) => ({
    path: article.path,
    title: article.h1,
    excerpt: article.excerpt,
    topic: article.topic,
    topicLabel: BLOG_TOPICS.find((t) => t.id === article.topic)!.label,
    date: formatContentDate(article.updated),
    readingTime: readingTimeText(article),
    cover: article.cover,
  }));
  return (
    <main className="site-container site-page" id="main">
      <Breadcrumbs path={BLOG.path} />
      <div className="site-page__head">
        <h1 className="site-h1">{BLOG.h1}</h1>
        <p className="site-lead">{BLOG.lead}</p>
      </div>
      <BlogList posts={posts} topics={BLOG_TOPICS} filterLabel={BLOG.filterLabel} allLabel={BLOG.all} />
      <JsonLd data={[breadcrumbLd(BLOG.path, siteOrigin())]} />
    </main>
  );
}
