/**
 * GET /api/site/config — настройки, которые статическая страница сайта узнаёт во
 * время показа: рубильник проверки, ключ виджета капчи, счётчик Метрики.
 *
 * Выключенный рубильник здесь не отказ, а значение: форме нужно знать, что
 * прятать. Ручки самой проверки при выключенном рубильнике отвечают `503`.
 */

import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { sitePublicConfig } from "@/modules/site/config";

export const dynamic = "force-dynamic";

const handler = withModule(async () => jsonOk(sitePublicConfig()));

export async function GET() {
  const res = await handler();
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-robots-tag", "noindex");
  return res;
}
