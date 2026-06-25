/**
 * /api/digital-profile/health
 *   GET — liveness/readiness for ops & monitoring. No auth (so probes work even
 *         when login is required for the app), no secrets. Returns component
 *         status for database, storage and renderer plus whether auth is enabled.
 *         200 when database + storage are healthy, 503 otherwise.
 */

import { NextResponse } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { getDigitalProfileHealth } from "@/modules/digital-profile/services/health-service";

export const dynamic = "force-dynamic";

export const GET = withModule(async () => {
  const health = await getDigitalProfileHealth();
  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
});
