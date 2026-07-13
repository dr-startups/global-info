-- Crash-safe Arsenkin account request leases (sliding RPM + TTL concurrency).
CREATE TABLE IF NOT EXISTS "dp_provider_account_request_leases" (
  "id" TEXT NOT NULL,
  "limiterId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "dp_provider_account_request_leases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dp_provider_account_request_leases_limiterId_createdAt_idx"
ON "dp_provider_account_request_leases"("limiterId", "createdAt");

CREATE INDEX IF NOT EXISTS "dp_provider_account_request_leases_limiterId_expiresAt_idx"
ON "dp_provider_account_request_leases"("limiterId", "expiresAt");
