/**
 * Метаданные сайта: база адресов, шаблон заголовка, `noindex` мастера.
 *
 * Страницы сайта пререндерятся при сборке, поэтому `SITE_PUBLIC_ORIGIN` здесь
 * читается на сборке. Образ собирается без переменных — на площадке база адресов
 * будет стендовой, пока этап SEO не решит, как значение попадает в сборку.
 */

import type { Metadata } from "next";
import { TEXT_DEFAULTS, textSetting } from "@/modules/digital-profile/config/defaults";

export const SITE_NAME = "Global Info";

function originOf(env: Record<string, string | undefined>): URL {
  try {
    return new URL(textSetting("SITE_PUBLIC_ORIGIN", env));
  } catch {
    // Опечатка в адресе не должна ронять сборку всего приложения.
    return new URL(TEXT_DEFAULTS.SITE_PUBLIC_ORIGIN);
  }
}

export function siteMetadata(env: Record<string, string | undefined> = process.env): Metadata {
  return {
    metadataBase: originOf(env),
    title: {
      template: `%s — ${SITE_NAME}`,
      default: `${SITE_NAME} — проверка репутации в открытых источниках`,
    },
    description:
      "Бесплатная проверка репутации по открытым источникам: есть ли о вас негативные материалы, в каких темах и насколько это серьёзно.",
    applicationName: SITE_NAME,
  };
}

/**
 * Страницы `/check/*`: мастер с данными конкретного человека и служебные экраны.
 * В поиск не попадают и ссылок для обхода не дают.
 */
export const checkPageMetadata: Metadata = {
  title: "Проверка",
  robots: { index: false, follow: false },
};
