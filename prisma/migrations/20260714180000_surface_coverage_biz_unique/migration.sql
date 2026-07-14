-- Additive unique business key for SurfaceCollectionCoverage (no providerTaskId).
-- Enables atomic Prisma upsert; concurrent collectors must not create duplicate rows.

CREATE UNIQUE INDEX IF NOT EXISTS "dp_surface_coverage_biz_unique"
ON "dp_surface_collection_coverage" (
  "reportRunId",
  "provider",
  "tool",
  "queryId",
  "surface",
  "engine",
  "region",
  "language",
  "device"
);
