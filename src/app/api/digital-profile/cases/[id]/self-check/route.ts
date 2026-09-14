/**
 * /api/digital-profile/cases/[id]/self-check
 *   GET — запись проверки с сайта, которой заведено дело; `null` — дело
 *         заведено не с сайта.
 *
 * В записи данные посетителя — согласие с адресом и браузером, контакты
 * заявки, — поэтому роль и доступ к делу проверяются до чтения, как у
 * остальных ручек карточки.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { loadSelfCheckForCase } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.view");
  await requireCaseAccess(user, id, "VIEWER");
  return jsonOk(await loadSelfCheckForCase(id));
});
