/**
 * Открыт ли сайт поиску и какой у него адрес.
 *
 * Ответ один на всех: `robots.txt`, `noindex` страниц, карта сайта и сводка на
 * старте. Страницы сайта пререндерятся при сборке, поэтому значения читаются при
 * сборке и доходят до образа объявленными `ARG` в `Dockerfile`.
 *
 * Включённая настройка при адресе не `https` или локальном индексацию не
 * открывает. Адрес попадает в canonical и карту сайта, и забытая переменная сборки
 * оставила бы там `http://localhost:3000`: открыть поиску такие страницы хуже, чем
 * не открыть никакие.
 */

import { TEXT_DEFAULTS, boolSetting, textSetting } from "@/modules/digital-profile/config/defaults";

type Env = Record<string, string | undefined>;

export interface SiteIndexing {
  open: boolean;
  origin: URL;
  /** Почему закрыто — словами и с именем переменной; у открытого `null`. */
  reason: string | null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export function siteOrigin(env: Env = process.env): URL {
  try {
    return new URL(textSetting("SITE_PUBLIC_ORIGIN", env));
  } catch {
    // Опечатка в адресе не должна ронять сборку всего приложения.
    return new URL(TEXT_DEFAULTS.SITE_PUBLIC_ORIGIN);
  }
}

export function siteIndexing(env: Env = process.env): SiteIndexing {
  const origin = siteOrigin(env);
  if (!boolSetting("SITE_INDEXING_ENABLED", env)) {
    return { open: false, origin, reason: "SITE_INDEXING_ENABLED не равен true" };
  }
  if (origin.protocol !== "https:") {
    return { open: false, origin, reason: "SITE_PUBLIC_ORIGIN не https" };
  }
  if (LOCAL_HOSTS.has(origin.hostname)) {
    return { open: false, origin, reason: "SITE_PUBLIC_ORIGIN — локальный адрес" };
  }
  return { open: true, origin, reason: null };
}
