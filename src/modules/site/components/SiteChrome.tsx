import type { ReactNode } from "react";
import { golosText } from "@/app/(site)/fonts/fonts";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { SiteIcons } from "./SiteIcons";
import { SiteRuntime } from "./SiteRuntime";

/**
 * Каркас страницы сайта: шрифты, ссылка «к содержанию», значки, шапка, подвал.
 * Общий у layout сайта и страницы 404 — ту Next рисует в корневом layout, мимо
 * layout сайта.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <div className={`site-body ${golosText.variable}`}>
      <a className="site-skip" href="#main">
        К содержанию
      </a>
      <SiteIcons />
      <SiteHeader />
      {children}
      <SiteFooter />
      <SiteRuntime />
    </div>
  );
}
