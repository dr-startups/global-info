/**
 * GET /api/digital-profile/auth/me
 *   Returns the current user (or a synthetic admin when auth is disabled).
 *   { authEnabled, user: { id, email, name, role } | null }
 */

import { type NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getOptionalUser } from "@/modules/digital-profile/auth/guard";
import {
  isAuthEnabled,
  isSyntheticAuthBypassAllowed,
} from "@/modules/digital-profile/auth/auth-config";

export const dynamic = "force-dynamic";

export const GET = withModule(async (req: NextRequest) => {
  const user = await getOptionalUser(req);
  // Never advertise synthetic identity as a real session in deploy-like envs
  const safeUser =
    user && user.synthetic && !isSyntheticAuthBypassAllowed()
      ? null
      : user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            synthetic: Boolean(user.synthetic),
          }
        : null;
  return jsonOk({
    authEnabled: isAuthEnabled(),
    user: safeUser,
  });
});
