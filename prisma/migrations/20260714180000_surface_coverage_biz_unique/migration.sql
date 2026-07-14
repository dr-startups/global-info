-- Additive unique business key for SurfaceCollectionCoverage (no providerTaskId).
-- Enables atomic Prisma upsert; concurrent collectors must not create duplicate rows.
-- Fails closed if duplicate business-key groups already exist (no silent deletes).

DO $$
DECLARE
  dup_groups integer;
BEGIN
  SELECT COUNT(*) INTO dup_groups
  FROM (
    SELECT 1
    FROM "dp_surface_collection_coverage"
    GROUP BY
      "reportRunId",
      "provider",
      "tool",
      "queryId",
      "surface",
      "engine",
      "region",
      "language",
      "device"
    HAVING COUNT(*) > 1
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'dp_surface_coverage_biz_unique blocked: % duplicate business-key group(s). Run scripts/audit-surface-coverage-duplicates.ts and resolve before migrating.',
      dup_groups;
  END IF;
END $$;

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
