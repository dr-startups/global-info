# Deployment Notes

## Required services

| Service | Role |
| --- | --- |
| Next.js app | API + Admin UI (`/admin/digital-profile`) |
| PostgreSQL | Evidence store (`dp_*` tables) |
| Python renderer (FastAPI) | PPTX generation (`python-pptx`) |
| LibreOffice (headless) | PPTX → PDF conversion (inside renderer image) |
| Private storage | Screenshots + `report_json` + PPTX/PDF (never public) |

The renderer + LibreOffice + fonts are packaged in `renderer/Dockerfile`. The app
is packaged in the root `Dockerfile` (Stage M3). For a full production-like stack
(app + postgres + renderer) use `docker-compose.prod.yml` — see
[Production-like deployment](#production-like-deployment-docker-compose--stage-m3).
The app and renderer share a private storage volume (`dp_storage` →
`/app/storage/digital-profile` and `/data`) so they exchange files by storage key.

## Environment variables

See `.env.example` for the full, commented list. Key ones:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `DIGITAL_PROFILE_ENABLED` | Master module switch (`true` to enable) |
| `DIGITAL_PROFILE_MOCK_AGENTS` | Mock agents emit deterministic demo data |
| `DIGITAL_PROFILE_STORAGE_DRIVER` | Storage driver (`local` only today; `s3`/`r2`/`supabase` reserved) |
| `DIGITAL_PROFILE_STORAGE_ROOT` | Private storage root (alias: `DIGITAL_PROFILE_STORAGE_DIR`) |
| `DIGITAL_PROFILE_STORAGE_PUBLIC_BASE_URL` | Optional CDN/bucket base URL (unused by `local`) |
| `DIGITAL_PROFILE_SIGNED_URL_SECRET` | Signing secret (alias: `DIGITAL_PROFILE_SIGNING_SECRET`) |
| `DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS` | Signed URL TTL, seconds (alias: `DIGITAL_PROFILE_SIGNED_URL_TTL`) |
| `RENDERER_URL` | Renderer base URL (alias: `DIGITAL_PROFILE_RENDERER_URL`) |
| `DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION` | Server-side fallback template |
| `DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED` | Master switch for keyed SERP providers |
| `DIGITAL_PROFILE_WIKIPEDIA_ENABLED` | Wikipedia (public API; independent) |
| `DIGITAL_PROFILE_GOOGLE_ENABLED` + `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_ENGINE_ID` | Google official API |
| `DIGITAL_PROFILE_YANDEX_ENABLED` + `YANDEX_SEARCH_API_KEY` + `YANDEX_SEARCH_FOLDER_ID` + `YANDEX_SEARCH_REGION` | Yandex official API |
| `DIGITAL_PROFILE_PROVIDER_TIMEOUT_MS` / `DIGITAL_PROFILE_PROVIDER_MAX_RESULTS` | Keyed provider HTTP limits |
| `DIGITAL_PROFILE_AUTH_ENABLED` | Auth + roles master switch (default `false`) |
| `DIGITAL_PROFILE_SESSION_SECRET` | HMAC secret for the session cookie (required when auth enabled) |
| `DIGITAL_PROFILE_DEMO_ADMIN_EMAIL` / `DIGITAL_PROFILE_DEMO_ADMIN_PASSWORD` | Seed-only demo admin (DEMO-ONLY) |

**Production:** always set a strong, unique `DIGITAL_PROFILE_SIGNED_URL_SECRET`
and a non-default `DATABASE_URL`. Never commit real secrets.

### Auth (Stage M1)

- `DIGITAL_PROFILE_AUTH_ENABLED=false` (default) → no login; every actor is a
  synthetic `SUPER_ADMIN`. Use only for local demo / CI smoke.
- `DIGITAL_PROFILE_AUTH_ENABLED=true` → login required, roles + per-case access
  enforced, page routes redirect to `/admin/digital-profile/login`.
- **Production must enable auth** and set a strong `DIGITAL_PROFILE_SESSION_SECRET`
  (>=16 chars, e.g. `openssl rand -base64 32`). With auth enabled in production,
  a missing/default secret aborts startup (fail-closed).
- Roles: `SUPER_ADMIN`, `ADMIN`, `ANALYST`, `REVIEWER`, `CLIENT_VIEWER` — see
  `SECURITY.md` for the full permission matrix and demo users.

### Storage (Stage M2)

- **Abstraction.** All file I/O goes through a `StorageProvider`
  (`src/modules/digital-profile/storage/`). Only the `local` driver is
  implemented; `s3`/`r2`/`supabase` are recognized values reserved for future
  drivers and fail fast if selected without an implementation (no silent
  fallback).
- **Key conventions** (all relative, validated against path traversal / absolute
  paths before any I/O):
  - `cases/{caseId}/reports/{reportVersionId}/report.pptx`
  - `cases/{caseId}/reports/{reportVersionId}/report.pdf`
  - `cases/{caseId}/screenshots/{screenshotId}.{ext}`
  - `cases/{caseId}/evidence/{evidenceId}/{filename}` (reserved)
  - `cases/{caseId}/exports/{exportId}/{filename}` (reserved)
- **Private only.** Objects are never served from a public path. Reads go through
  the signed-URL download routes (`/api/digital-profile/.../download`). A valid
  signed token never bypasses auth/role/case-access checks when auth is enabled.
- **Signed tokens** are HMAC-signed over the storage key + expiry. Because the
  key embeds `caseId`, `reportVersionId` and the artifact type, the token is
  bound to exactly that resource. TTL is governed by
  `DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS` (default 900s).

### Storage root permissions

- The storage root (`DIGITAL_PROFILE_STORAGE_ROOT`) must be writable by the app
  process **and** readable/writable by the renderer container (it is mounted at
  `/data`). It must **not** be inside `public/` or any web-served directory.
- Recommended: a dedicated directory/volume owned by the service user with `700`
  (dir) / `600` (file) permissions; for the Docker volume, keep it private and do
  not bind-mount it under a static asset path.

## Migrations

```bash
npm run db:generate      # prisma generate
npm run db:deploy        # prisma migrate deploy (production)
# dev only:
npm run db:migrate       # prisma migrate dev
npm run db:seed          # demo cases + DEMO-ONLY users (omit in production)
```

Run `db:deploy` (never `migrate dev`) in production, after backing up the
database. The Stage M1 migration is additive (adds `dp_users` / `dp_case_access`
+ enums); no existing tables change.

## Docker (renderer)

```bash
docker compose up -d --build renderer
docker compose logs -f renderer
docker inspect --format '{{.State.Health.Status}}' global-info-renderer
```

Hardening (Stage M2):

- The renderer image installs LibreOffice **only** in the renderer (the Node app
  never needs it) and `curl` for the container healthcheck.
- `HEALTHCHECK` / compose `healthcheck` poll `/health`; the container is reported
  unhealthy if LibreOffice is missing.
- `/tmp` is a `tmpfs` and LibreOffice runs with a per-call temp profile dir that
  auto-cleans, so no PPTX/PDF temp files accumulate.
- `init: true` reaps LibreOffice child processes.
- The image contains **no secrets**; the renderer only needs `DATA_ROOT`.

## Railway (managed) deployment — Stage M4

For a managed cloud deployment (app + renderer + Postgres as Railway services),
see **[RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md)**. On Railway the renderer is
**stateless** (no shared Volume): it returns PPTX/PDF bytes over HTTP and the app
persists them via its storage provider onto the app-only Volume. The same
stateless handoff is used by Docker Compose (the renderer mounts storage
read-only for input images only).

## Production-like deployment (Docker Compose) — Stage M3

`docker-compose.prod.yml` brings up the full stack — **app** (Next.js), **postgres**
and **renderer** — with named volumes (`dp_pgdata`, `dp_storage`) and healthchecks.
The app image is built from the root `Dockerfile` (multi-stage: `npm ci` →
`prisma generate` → `npm run build`; runtime keeps `node_modules` so migrations
and `admin:create` can run inside the container). **No `.env`/secrets are baked
into the image** (`.dockerignore`); configuration is injected at runtime via
`env_file: .env.production`.

### Steps

```bash
# 1. Configure (never commit the result)
cp .env.production.example .env.production
#    -> edit: set strong POSTGRES_PASSWORD, DATABASE_URL, DIGITAL_PROFILE_SESSION_SECRET,
#       DIGITAL_PROFILE_SIGNED_URL_SECRET (e.g. `openssl rand -base64 32`)

# 2. Build & start
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps      # all healthy?

# 3. Run migrations (production: deploy, NEVER migrate dev)
docker compose -f docker-compose.prod.yml exec app npm run db:deploy

# 4. Create the first admin (production users are created explicitly)
docker compose -f docker-compose.prod.yml exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='strong-password-12+' -e ADMIN_NAME='Admin' \
  app npm run admin:create
#    (demo only, non-production:  ... exec app npm run db:seed:demo)

# 5. Verify health
curl -fsS http://localhost:3000/api/digital-profile/health
curl -fsS http://localhost:8080/health

# 6. Smoke the running stack
SMOKE_ADMIN_EMAIL=you@example.com SMOKE_ADMIN_PASSWORD='strong-password-12+' npm run smoke:prod
```

Open the Admin UI at `http://<host>:3000/admin/digital-profile`.

### Seed separation (important)

- `npm run db:seed` / `db:seed:demo` create **DEMO-ONLY** cases + users — never run
  them in production.
- Production users are created explicitly via `npm run admin:create`
  (`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME`; password is hashed and never logged;
  no-op if the email already exists).

### Storage volume

- `dp_storage` is shared between **app** (`/app/storage/digital-profile`) and
  **renderer** (`/data`) so they exchange files by storage key. Keep it private
  (not under any web-served path) and include it in backups alongside Postgres.

### Env validation (fail-fast)

- On startup the app validates its environment (`src/instrumentation.ts` →
  `config/env-validation.ts`). In **production** missing/weak critical config
  (e.g. `DATABASE_URL`, a weak `DIGITAL_PROFILE_SESSION_SECRET` while auth is on,
  a weak signing secret, an unimplemented storage driver) **aborts startup**. In
  development the same problems are logged as warnings. Secret **values** are
  never logged.

### Railway / VPS notes

- **VPS:** install Docker + Compose, clone the repo, create `.env.production`,
  then run the steps above. Put a TLS-terminating reverse proxy (Caddy/Nginx) in
  front of the app on `:3000`; only expose `443` publicly. Keep `dp_storage` on a
  persistent disk and back it up.
- **Railway / single-image PaaS:** deploy the app image and the renderer image as
  two services; add a managed Postgres; set the env vars from
  `.env.production.example`; point `RENDERER_URL` at the renderer service and
  `DATABASE_URL` at the managed DB. Run `npm run db:deploy` as a one-off/release
  command. Use a persistent volume for storage (or a future S3/R2 driver).

### Logs

```bash
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f renderer
docker compose -f docker-compose.prod.yml logs -f postgres
```

Logs never contain secrets or session tokens. Errors are returned to clients as a
safe envelope (no stack traces).

### Rollback

- **App:** redeploy the previous image tag / git revision and
  `up -d --build app`. The app is stateless apart from the DB + storage.
- **DB migrations:** Prisma migrations are forward-only. To roll back a bad
  migration, restore the pre-migration Postgres backup (take one before every
  `db:deploy`). Do not hand-edit `_prisma_migrations`.
- **Storage:** restore the `dp_storage` volume from backup consistent with the DB
  snapshot.

### Migration warnings

- Always **back up Postgres before `db:deploy`**.
- Use `db:deploy` (`prisma migrate deploy`) in production — **never** `migrate dev`
  (it can reset/alter schema interactively).
- Keep DB and storage backups close in time so report rows and their artifacts
  stay consistent.

## Health checks

| Check | How | Healthy |
| --- | --- | --- |
| Renderer | `GET http://localhost:8080/health` | `{"ok":true,"service":"digital-profile-renderer","libreOfficeAvailable":true,...}` |
| Node module | `GET /api/digital-profile/health` | `200` `{"ok":true,"database":"ok","storage":"ok","renderer":"ok"|"unavailable","authEnabled":...}` |
| Node degraded | `GET /api/digital-profile/health` | `503` when database or storage is unhealthy (renderer down is non-fatal) |
| API (module off) | any `/api/digital-profile/*` | `404` `MODULE_DISABLED` |

The Node health endpoint requires **no auth** (so probes work even when login is
required) and never exposes secrets or connection strings — only component status
and the `authEnabled` flag.

## Production env checklist

- [ ] `DIGITAL_PROFILE_ENABLED=true`
- [ ] `DATABASE_URL` points at the production Postgres (not the default)
- [ ] `DIGITAL_PROFILE_AUTH_ENABLED=true`
- [ ] `DIGITAL_PROFILE_SESSION_SECRET` set to a strong random value (≥16 chars)
- [ ] `DIGITAL_PROFILE_SIGNED_URL_SECRET` set to a strong random value
- [ ] `DIGITAL_PROFILE_STORAGE_DRIVER=local` (until a remote driver is added)
- [ ] `DIGITAL_PROFILE_STORAGE_ROOT` on a private, writable volume (not under `public/`)
- [ ] `RENDERER_URL` reachable from the app; renderer container healthy
- [ ] **No demo passwords** — change/remove the seeded demo users; do not run
      `db:seed` in production
- [ ] `prisma migrate deploy` applied; DB + storage backed up
- [ ] `/api/digital-profile/health` and renderer `/health` return healthy

## Backup & retention

**Back up (separately):**

- **PostgreSQL** — all case/evidence/report metadata, users and audit logs
  (`pg_dump` on a schedule; test restores).
- **Storage root** (`DIGITAL_PROFILE_STORAGE_ROOT`) — screenshots and rendered
  PPTX/PDF. Keep it consistent with the DB (a report row references a storage
  key; back them up together or close in time).
- **Secrets** — `DIGITAL_PROFILE_SESSION_SECRET`, `DIGITAL_PROFILE_SIGNED_URL_SECRET`,
  API keys and `DATABASE_URL` — stored in your secret manager, **never** in the
  repo or image. Rotating the signed-URL secret invalidates outstanding download
  links (expected).

**Retention (set per your legal/compliance policy):**

- **Raw evidence** (screenshots, imported files): retain per engagement /
  regulatory requirements; evidence is tamper-evident (SHA-256) and never
  silently destroyed.
- **Report versions**: keep historical versions for traceability; prune old
  rendered artifacts on a defined schedule if storage is a concern.
- **Audit logs**: retain long enough to investigate access/security events.

**Deletion:**

- Cases use **soft delete** (`deletedAt`); files stay on disk so evidence is not
  silently lost. Hard deletion of evidence is an admin/superadmin-only operation.
- Treat evidence/report deletion with legal/compliance caution — deleting may be
  irreversible and could affect an ongoing engagement.

## Known limitations

- No automatic SERP screenshots and no browser automation/scraping.
- Google/Yandex require official API keys; without them providers are
  `NOT_CONFIGURED` (no fake calls).
- Compliance databases (LexisNexis / Dow Jones / World-Check) are **manual import
  only** until official API contracts are in place.
- Wikipedia uses the public MediaWiki/REST API (rate-limited, read-only; never
  auto-publishes).
- Report branding is a neutral "Digital Profile Audit" brand — no third-party
  logos/brands.
- Auth is a minimal session-cookie + RBAC layer (Stage M1): no OAuth/SAML, no
  org hierarchy, no billing. Queues / background jobs remain out of scope.
- Storage is local/private only (Stage M2). The `StorageProvider` interface is
  S3/R2/Supabase-shaped, but remote drivers are not yet implemented.
- Production deployment (Stage M3) is Docker Compose only — no Kubernetes, no
  managed-PaaS manifests beyond the notes above. The app image keeps
  `node_modules` (incl. Prisma CLI / tsx) so migrations + `admin:create` run
  in-container; it is functional rather than minimal.
