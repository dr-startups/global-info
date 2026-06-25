/**
 * POST /api/digital-profile/auth/logout — clears the session cookie.
 */

import { type NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getOptionalUser } from "@/modules/digital-profile/auth/guard";
import { DP_SESSION_COOKIE } from "@/modules/digital-profile/auth/session";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";

export const dynamic = "force-dynamic";

export const POST = withModule(async (req: NextRequest) => {
  const user = await getOptionalUser(req);
  if (user && !user.synthetic) {
    await recordAudit({ action: "LOGOUT", actorId: user.id });
  }
  const res = jsonOk({ ok: true });
  res.cookies.set(DP_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
});
