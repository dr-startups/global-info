-- Unique observation key within an audit run (no cross-query URL collapse).
CREATE UNIQUE INDEX IF NOT EXISTS "serp_obs_run_unique"
ON "dp_serp_observations" ("auditRunId", "provider", "engine", "region", "language", "surface", "queryId", "rank", "url");
