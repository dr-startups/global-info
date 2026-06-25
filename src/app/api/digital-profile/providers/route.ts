/**
 * /api/digital-profile/providers
 *   GET — availability of the real connectors (Wikipedia / Google / Yandex),
 *   derived from config only (no network calls). Powers UI badges and lets
 *   smoke tests assert the DISABLED / NOT_CONFIGURED states.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { listProviderAvailability } from "@/modules/digital-profile/providers/config";

export const dynamic = "force-dynamic";

export const GET = withModule(async (_req: NextRequest) => {
  return jsonOk(listProviderAvailability());
});
