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
and renderer share a private storage volume (`./storage/digital-profile` →
`/data` in the container) so they exchange files by storage key.

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
