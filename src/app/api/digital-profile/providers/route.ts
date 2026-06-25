/**
 * /api/digital-profile/providers
 *   GET — availability of the real connectors (Wikipedia / Google / Yandex),
 *   derived from config only (no network calls). Powers UI badges and lets
 *   smoke tests assert the DISABLED / NOT_CONFIGURED states.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { listProviderStatus } from "@/modules/digital-profile/providers/config";

export const dynamic = "force-dynamic";

export const GET = withModule(async (req: NextRequest) => {
  const user = await requireDigitalProfileUser(req);
  // Provider/connector internals are staff-only.
  requireRole(user, "evidence.viewRaw");
  return jsonOk(listProviderStatus());
});
