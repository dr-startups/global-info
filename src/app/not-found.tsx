import type { Metadata } from "next";
import Link from "next/link";
import "./(site)/site.css";
import { SiteChrome } from "@/modules/site/components/SiteChrome";
import { ArrowIcon } from "@/modules/site/components/SiteIcons";

/**
 * 404. Неизвестный адрес Next рисует в корневом layout, мимо layout сайта, — поэтому
 * стили и каркас сайта подключены здесь.
 *
 * Заголовок — целиком: `notFound()` страницы сайта (неизвестная статья или услуга)
 * рисует эту же страницу внутри layout сайта, и его шаблон «%s — Global Info»
 * повторил бы название.
 */

export const metadata: Metadata = {
  title: { absolute: "Страница не найдена — Global Info" },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <SiteChrome>
      <main className="site-narrow site-page" id="main">
        <div className="site-stack" style={{ gap: "var(--site-s-4)" }}>
          <p className="site-status">Ошибка 404</p>
          <h1 className="site-h1">Такой страницы нет</h1>
          <p className="site-lead">
            Ссылка устарела или в ней опечатка. Начните с главной или сразу запустите бесплатную проверку.
          </p>
          <div className="site-actions">
            <Link className="site-btn site-btn--accent site-btn--lg" href="/#form">
              Проверить бесплатно
              <ArrowIcon />
            </Link>
            <Link className="site-btn site-btn--secondary site-btn--lg" href="/">
              На главную
            </Link>
          </div>
        </div>
      </main>
    </SiteChrome>
  );
}
