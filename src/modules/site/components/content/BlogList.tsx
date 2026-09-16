"use client";

/**
 * Список статей с фильтром тем — по макету `#blog`. Фильтр — кнопки, а не ссылки:
 * адрес не меняется, и поиск не получает копий одного списка. Сколько статей
 * осталось, экранный диктор читает из живой области — иначе нажатие для него ничего
 * не меняет. Без скрипта список виден целиком.
 *
 * Подписи фильтра приходят свойствами, а не импортом модуля статей: тот несёт
 * тексты всех статей, и клиентский бандл списка вырос бы на весь блог.
 */

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { BlogTopic } from "@/modules/site/content/articles";

export interface BlogPost {
  path: string;
  title: string;
  excerpt: string;
  topic: BlogTopic;
  topicLabel: string;
  date: string;
  readingTime: string;
  cover: string;
}

/** Две первые статьи — крупно: две крупных и четыре обычных дают полные ряды на любой ширине. */
const LEAD_POSTS = 2;

export function BlogList({
  posts,
  topics,
  filterLabel,
  allLabel,
}: {
  posts: readonly BlogPost[];
  topics: readonly { id: BlogTopic; label: string }[];
  filterLabel: string;
  allLabel: string;
}) {
  const [topic, setTopic] = useState<BlogTopic | "all">("all");
  const [status, setStatus] = useState("");
  const matches = (post: BlogPost, value: BlogTopic | "all") => value === "all" || post.topic === value;

  const choose = (next: BlogTopic | "all") => {
    setTopic(next);
    setStatus(`Статей: ${posts.filter((post) => matches(post, next)).length}`);
  };

  return (
    <>
      <div className="site-filter" role="group" aria-label={filterLabel}>
        {[{ id: "all" as const, label: allLabel }, ...topics].map((item) => (
          <button
            key={item.id}
            className="site-filter__btn"
            type="button"
            aria-pressed={topic === item.id}
            onClick={() => choose(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="site-visually-hidden" aria-live="polite">
        {status}
      </p>

      <div className="site-blog">
        {posts.map((post, i) => {
          const lead = i < LEAD_POSTS;
          return (
            <article
              key={post.path}
              className={`site-post${lead ? " site-post--lead" : ""}`}
              hidden={!matches(post, topic)}
            >
              <div className="site-cover" aria-hidden="true">
                <Image
                  src={`/site/covers/${post.cover}.webp`}
                  width={1200}
                  height={805}
                  sizes={
                    lead
                      ? "(min-width: 1024px) 548px, (min-width: 640px) 50vw, 100vw"
                      : "(min-width: 1024px) 262px, (min-width: 640px) 50vw, 100vw"
                  }
                  alt=""
                  loading="lazy"
                />
              </div>
              <div className="site-post__body">
                <h2 className="site-post__title">
                  <Link className="site-post__link" href={post.path}>
                    {post.title}
                  </Link>
                </h2>
                <p className="site-post__excerpt">{post.excerpt}</p>
                <p className="site-post__meta">
                  <span>{post.topicLabel}</span>
                  <span>{post.date}</span>
                  <span>{post.readingTime}</span>
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
