# Unified collection job store (§9.4)

Durable store for `UnifiedCollectionJob` (unified ORION + Arsenkin collection).

## Flag

`UNIFIED_COLLECTION_JOB_STORE=file|db`

| Value | Behavior |
|---|---|
| unset / `file` (default) | File-backed `job.json` under `storage/digital-profile/unified-orion-collection/`. No Postgres required. Used by CI / offline smokes. |
| `db` | Prisma table `dp_unified_collection_jobs` (`UnifiedCollectionJobRecord`) with atomic lease CAS via `UPDATE … WHERE versionNum`. |

Default is **`file`** so `NETWORK_CALLS=0` smokes stay green without a database.

## Layout

- Path helpers unchanged: `unifiedJobDir`, `unifiedJobPath`, `unifiedArtifactsDir`.
- Artifacts always write JSON under the job artifact directory on local disk.
- In `db` mode, `artifactKeys` / `reportLinkKeys` on the row record relative storage keys such as `unified-orion-collection/{caseId}/{unifiedJobId}/{name}`.
- S3 / remote object storage is **not** implemented.

## Concurrency

- **File mode:** lease reject when held by another owner; optional optimistic version check on save.
- **DB mode:** `saveUnifiedCollectionJob` CAS (`versionNum === expected` then increment; one retry). `claimUnifiedJobLease` uses `updateMany` where lease is null/expired or same owner.

## Cutover

On `db` load, if the Prisma row is missing but `job.json` exists on disk, the store bootstrap-imports once into Postgres.
