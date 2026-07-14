-- Unique observation key within an audit run (no cross-query URL collapse).
-- Production DBs may already contain duplicate rows from earlier collectors;
-- dedupe before CREATE UNIQUE INDEX so migrate deploy is fail-closed but recoverable.

DELETE FROM "dp_serp_observations" AS doomed
WHERE doomed.id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          "auditRunId",
          "provider",
          "engine",
          "region",
          "language",
          "surface",
          "queryId",
          "rank",
          "url"
        ORDER BY "capturedAt" DESC, id DESC
      ) AS rn
    FROM "dp_serp_observations"
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "serp_obs_run_unique"
ON "dp_serp_observations" ("auditRunId", "provider", "engine", "region", "language", "surface", "queryId", "rank", "url");
