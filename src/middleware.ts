/**
 * Edge middleware: protects Digital Profile admin pages (Stage M1 / R10.10a).
 *
 * When DIGITAL_PROFILE_AUTH_ENABLED=true, page loads under /admin/digital-profile
 * require a valid session cookie; otherwise the user is redirected to the login
 * page. The session signature is verified here (edge-safe Web Crypto). Full
 * checks (user active, role, case access) happen in the API layer.
 *
 * R10.10a: in deploy-like environments (production/staging), auth must be
 * enabled — otherwise admin pages redirect to login (fail-closed). Local demo
 * with auth disabled remains a no-op only outside deploy-like runtimes.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthConfig,
  isDeployLikeEnvironment,
} from "@/modules/digital-profile/auth/auth-config";
import {
  DP_SESSION_COOKIE,
  verifySessionToken,
} from "@/modules/digital-profile/auth/session";

const LOGIN_PATH = "/admin/digital-profile/login";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // The login page must always be reachable.
  if (pathname === LOGIN_PATH) return NextResponse.next();

  const cfg = getAuthConfig();
  const deployLike = isDeployLikeEnvironment();

  // Fail-closed: deploy-like without auth enabled → force login redirect.
  if (!cfg.enabled) {
    if (!deployLike) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = `?next=${encodeURIComponent(pathname)}&reason=auth_required`;
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get(DP_SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token, cfg.sessionSecret);
  if (payload) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/digital-profile/:path*"],
};
