/**
 * Настройки сайта, которые статическая страница узнаёт во время показа.
 *
 * Образ собирается без переменных окружения, и прочитанное при `next build`
 * вшилось бы пустым: форма на площадке уходила бы без токена капчи, а
 * выключенный рубильник не прятал бы её. Поэтому рубильник, ключ виджета капчи и
 * счётчик Метрики страница спрашивает у `GET /api/site/config`. Отдаётся ровно
 * то, что браузер и так увидит: серверный ключ капчи и секреты сюда не входят.
 */

import { boolSetting, textSetting } from "@/modules/digital-profile/config/defaults";
import type { SitePublicConfig } from "./check/types";

export function sitePublicConfig(env: NodeJS.ProcessEnv = process.env): SitePublicConfig {
  const captchaClientKey = String(env.SMARTCAPTCHA_CLIENT_KEY ?? "").trim();
  const metrikaId = textSetting("YANDEX_METRIKA_ID", env);
  return {
    selfCheckEnabled: boolSetting("SELF_CHECK_ENABLED", env),
    captchaClientKey: captchaClientKey || null,
    metrikaId: metrikaId || null,
  };
}
