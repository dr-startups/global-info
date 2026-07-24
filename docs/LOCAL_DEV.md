# Local development stack (Docker)

Full local environment for the Digital Profile / ORION report pipeline:
Postgres + Python renderer (LibreOffice) + Next.js app, all wired together,
with every artifact readable from the host.

## Files

| File | Purpose |
| --- | --- |
| `docker-compose.dev.yml` | The three services (`postgres`, `renderer`, `app`) |
| `Dockerfile.dev` | Dev image for the app (bind-mounted source, hot reload) |
| `scripts/dev/app-entrypoint.sh` | `npm ci` → `prisma generate` → `prisma migrate deploy` → `next dev` |
| `.env` | All configuration and secrets (gitignored) |

## Start / stop

```bash
docker compose -f docker-compose.dev.yml up -d --build   # first run: ~10 min
docker compose -f docker-compose.dev.yml logs -f app      # follow the app
docker compose -f docker-compose.dev.yml down             # stop (keeps data)
docker compose -f docker-compose.dev.yml down -v          # stop + wipe DB/volumes

# After editing .env — env_file is read at container CREATION, so `restart`
# would silently keep the old values (and providers fail with 401):
docker compose -f docker-compose.dev.yml up -d --force-recreate app
docker compose -f docker-compose.dev.yml exec app bash -lc 'echo ${YANDEX_SEARCH_API_KEY:0:6}'  # verify
```

Endpoints:

| Service | URL |
| --- | --- |
| Admin UI | http://localhost:3000/admin/digital-profile |
| App health | http://localhost:3000/api/digital-profile/health |
| Renderer health | http://localhost:8080/health |
| Postgres | `postgresql://postgres:postgres@localhost:5432/global_info` |

## Where the intermediate results live

Everything the pipeline writes is bind-mounted to the host — no `docker cp` needed:

```
storage/digital-profile/
  unified-orion-collection/<caseId>/<jobId>/   # job.json + per-stage artifact JSON
  ...                                          # report_json, visual assets (PNG), PPTX/PDF
```

Useful inspection commands:

```bash
# Latest artifacts written by a run
find storage/digital-profile -type f -newermt '-15 minutes' | sort

# Job state (UNIFIED_COLLECTION_JOB_STORE=db)
docker compose -f docker-compose.dev.yml exec postgres \
  psql -U postgres -d global_info -c 'select id, "caseId", stage, status, "updatedAt" from "dp_unified_collection_jobs" order by "updatedAt" desc limit 5;'

# Browse all tables
npx prisma studio            # host, uses DATABASE_URL=localhost:5432
```

## Host-side tooling

`.env` holds host-facing values (`localhost:5432`, `localhost:8080`), so QA/smoke
scripts run directly on the host against the same stack:

```bash
npm run typecheck
npm test                      # vitest, offline
npx tsx scripts/<qa-script>.ts
```

The container overrides only the hostnames it must (`postgres`, `renderer`) via
`docker-compose.dev.yml`.

## Notes

- `node_modules` lives in the `dp_dev_node_modules` volume — container-native
  binaries (sharp, prisma engines) never mix with the host install.
- The renderer directory is bind-mounted too: editing `renderer/*.py` only needs
  `docker compose -f docker-compose.dev.yml restart renderer`.
- Playwright browsers are **not** installed in the dev image. Live SERP screenshot
  capture (`src/modules/digital-profile/serp-capture`) needs
  `docker compose -f docker-compose.dev.yml exec app npx playwright install --with-deps chromium`.
- Changing `.env` requires an `app` restart (Next.js reads env at boot).
