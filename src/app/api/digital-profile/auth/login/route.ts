/**
 * POST /api/digital-profile/auth/login
 *   Body: { email, password }
 *   Sets the dp_session cookie on success. Generic failure (401) — no detail leak.
 */

import { NextResponse, type NextRequest } from "next/server";
import { jsonOk, UnauthorizedError, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import { authenticate } from "@/modules/digital-profile/auth/user-service";
import {
  assertAuthConfigSafe,
  getAuthConfig,
} from "@/modules/digital-profile/auth/auth-config";
import {
  DP_SESSION_COOKIE,
  DP_SESSION_TTL_SECONDS,
  createSessionToken,
} from "@/modules/digital-profile/auth/session";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";

export const dynamic = "force-dynamic";

export const POST = withModule(async (req: NextRequest) => {
  assertAuthConfigSafe();
  const cfg = getAuthConfig();
  const body = (await readJsonBody(req)) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  const user = email && password ? await authenticate(email, password) : null;
  if (!user) {
    await recordAudit({ action: "LOGIN_FAILED", metadata: { email: email.slice(0, 120) } });
    throw new UnauthorizedError("Invalid email or password");
  }

  const token = await createSessionToken(user.id, cfg.sessionSecret);
  await recordAudit({ action: "LOGIN", actorId: user.id });

  const res = jsonOk({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });
  res.cookies.set(DP_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DP_SESSION_TTL_SECONDS,
  });
  return res;
});
