import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticlePage } from "@/modules/site/components/content/ArticlePage";
import { ARTICLES, articleBySlug } from "@/modules/site/content/articles";
import { pageMetadata } from "@/modules/site/seo/metadata";

/**
 * Статьи собираются при сборке по реестру; статьи, которой нет в реестре, нет и на сайте —
 * 404 через `notFound()`. Почему не `dynamicParams = false` — в странице услуги.
 */
type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = articleBySlug((await params).slug);
  if (!article) notFound();
  return pageMetadata(article.path);
}

export default async function ArticleRoute({ params }: Props) {
  const article = articleBySlug((await params).slug);
  if (!article) notFound();
  return <ArticlePage article={article} />;
}
