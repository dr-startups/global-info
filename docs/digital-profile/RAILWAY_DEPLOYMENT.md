# Railway Deployment (Stage M4)

Production deployment of the Digital Profile Audit module on
[Railway](https://railway.com) as **three services in one project/environment**.

## Architecture

```
                 ┌────────────────────────── Railway project ──────────────────────────┐
   Internet ───► │  app (Next.js)          renderer (Python/LibreOffice)   Postgres     │
   (HTTPS)       │  • public domain        • PRIVATE domain only            (managed)    │
                 │  • Railway Volume   ┌──► • no volume, stateless     ◄─┐   • private    │
                 │    /app/storage/... │    • returns PPTX/PDF bytes     │               │
                 │  • app saves bytes ─┘      over HTTP                   │               │
                 │  • DATABASE_URL ───────────────────────────────────────┘ (private)    │
                 └──────────────────────────────────────────────────────────────────────┘
```

- **app** — Next.js. The only service with a **public domain** and the only one
  with a **persistent Volume**. Talks to the renderer over the private network
  (`http://`, not `https://`) and to Postgres via `DATABASE_URL`.
- **renderer** — Python + LibreOffice. **Private domain only.** Stateless: it
  renders into a temp dir, returns PPTX/PDF **bytes over HTTP**, and deletes the
  temp dir. It has **no Volume** and must not be public.
- **Postgres** — Railway **managed** PostgreSQL. Private (no public TCP proxy).

Both `app` and `renderer` build from the **same GitHub repo** using different
Dockerfiles selected by a per-service **Custom Config Path**.

> The renderer never shares a disk with the app. Embedded screenshots (which live
> on the app Volume) are therefore **not available** to the renderer in a split
> deployment and are skipped gracefully — see [Limitations](#limitations).

## Config-as-code

| Service | Custom Config Path | Builder | Dockerfile |
| --- | --- | --- | --- |
| app | `/railway.app.json` | DOCKERFILE | `Dockerfile` |
| renderer | `/railway.renderer.json` | DOCKERFILE | `renderer/Dockerfile` |

- `railway.app.json` — `preDeployCommand: npm run db:deploy`,
  `healthcheckPath: /api/digital-profile/health`, `healthcheckTimeout: 300`,
  `restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 5`.
- `railway.renderer.json` — `healthcheckPath: /health`, same timeout/restart
  policy, **no** migrations / pre-deploy command.

Both listen on Railway's injected `PORT`:
- app: `next start` respects `PORT` (binds `0.0.0.0`).
- renderer: binds `::` (IPv6) by default for Railway private networking; locally
  Docker Compose sets `RENDERER_HOST=0.0.0.0` (IPv4 bridge).

## Create the services (one project)

1. Create a project (e.g. `digital-profile-audit`) — one environment (e.g. `production`).
2. **Postgres:** New → Database → PostgreSQL (managed). Leave it private.
3. **app:** New → GitHub repo → this repo. Settings → **Config-as-code /
   Custom Config Path** = `/railway.app.json`. Add a **Volume** mounted at
   `/app/storage/digital-profile`. Generate a **public domain**.
4. **renderer:** New → GitHub repo → the **same** repo. Settings → Custom Config
   Path = `/railway.renderer.json`. **Do not** add a Volume. **Do not** generate
   a public domain (keep the private domain only).

## Variables (names only — never commit values)

Set these in the Railway dashboard (or `railway variables`). Names match the
runtime env validation (`src/modules/digital-profile/config/env-validation.ts`).

**app**

| Variable | Value / source |
| --- | --- |
| `NODE_ENV` | `production` |
| `DIGITAL_PROFILE_ENABLED` | `true` |
| `DIGITAL_PROFILE_AUTH_ENABLED` | `true` |
| `DIGITAL_PROFILE_DEFAULT_LOCALE` | `ru` |
| `DIGITAL_PROFILE_MOCK_AGENTS` | `false` (or `true` for a demo) |
| `DIGITAL_PROFILE_STORAGE_DRIVER` | `local` |
| `DIGITAL_PROFILE_STORAGE_ROOT` | `/app/storage/digital-profile` |
| `DIGITAL_PROFILE_RENDERER_URL` | `http://${{renderer.RAILWAY_PRIVATE_DOMAIN}}:${{renderer.PORT}}` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `DIGITAL_PROFILE_SESSION_SECRET` | strong random (`openssl rand -base64 32`) |
| `DIGITAL_PROFILE_SIGNED_URL_SECRET` | strong random (`openssl rand -base64 32`) |
| `DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS` | `900` (optional) |
| `DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION` | `report-template-v3` (optional) |

**renderer**

| Variable | Value |
| --- | --- |
| `PORT` | `8080` (must exist — app references `renderer.PORT`) |
| `PYTHONUNBUFFERED` | `1` |

> Reference variables: `DIGITAL_PROFILE_RENDERER_URL` and `DATABASE_URL` use
> Railway reference syntax so they resolve to the renderer's private domain/port
> and the managed Postgres connection string. Use `http://` (not `https://`)
> between app and renderer. Never use `localhost` between services.

## Networking

- **Public:** only `app` (generate a domain).
- **Private:** `renderer` (private domain only) and `Postgres` (no public TCP
  proxy). The app reaches both over the private network.

## Migrations

- `app` runs `npm run db:deploy` (`prisma migrate deploy`) as the
  **preDeployCommand** before each new deployment goes live.
- If a migration fails, the deploy **stops** (the new version is not promoted).
- Never `migrate dev` and never reset the database in production.
- Do **not** run the demo seed (`db:seed` / `db:seed:demo`) in production.

## LIVE SERP capture (Stage S2)

- Chromium is installed in the **app** Docker image via
  `npx playwright install --with-deps chromium` (see root `Dockerfile`).
- You do **not** run Playwright install manually on Railway after deploy.
- Optional env: `SERP_CAPTURE_PROXY_RU`, `SERP_CAPTURE_PROXY_UAE`. Without them
  captures still work as DIRECT + `geoStatus=UNVERIFIED` (staging/preview OK).
- Capture is triggered only from Manual Review UI / API — never from PDF render.

## First admin user

No demo users in production. After a successful deploy, open an app shell and
create the first SUPER_ADMIN. The password is entered interactively (hidden) and
never logged:

```bash
railway ssh -s app
# inside the container:
ADMIN_EMAIL=you@example.com ADMIN_NAME="Admin" npm run admin:create
#   -> prompts: "Admin password (hidden):"  (input is not echoed)
```

`admin:create` is a no-op if the email already exists; it never prints the
password. Do not store the password in Railway variables, docs or git.

## Health verification

- Public app: `GET https://<app-domain>/api/digital-profile/health` →
  `{"ok":true,"database":"ok","storage":"ok","renderer":"ok","authEnabled":true}`.
- The endpoint exposes only component status + `authEnabled` (no secrets).
- Renderer `/health` is reachable only on the private network (by design).

Optional production smoke (no secrets printed, no demo users, no public renderer
needed):

```bash
BASE_URL=https://<app-domain> \
SMOKE_ADMIN_EMAIL=you@example.com SMOKE_ADMIN_PASSWORD='...' \
npm run smoke:prod
```

## Backups

- Enable **PostgreSQL backups** (Railway managed) — daily + weekly.
- Enable **app Volume backups** (storage holds rendered PPTX/PDF + screenshots).
- Take a **first manual backup** right after the first successful smoke.
- Keep DB and Volume backups close in time so report rows and their artifacts
  stay consistent. Do not run restore/wipe as part of routine deploys.

## Rollback

- **App / renderer:** redeploy the previous deployment (Railway keeps history) or
  the previous git commit.
- **DB:** migrations are forward-only — restore the pre-deploy Postgres backup to
  roll back a bad migration. Never hand-edit `_prisma_migrations`.
- **Storage:** restore the Volume from a backup consistent with the DB snapshot.

## Logs

```bash
railway logs -s app
railway logs -s renderer
```

Logs never contain passwords, session tokens or API keys. Client errors are
returned as a safe envelope (no stack traces).

## Limitations

- **Storage is local to the app Volume.** No S3/R2 yet (the `StorageProvider`
  interface is ready for it). A single app instance owns the Volume — do not scale
  the app to multiple replicas while using `local` storage.
- **Embedded screenshots** are not rendered into the deck on a split deployment
  (the renderer has no access to the app Volume). All other report content is
  fully rendered. To embed screenshots later, pass them inline in `report_json`
  or move to shared object storage (S3/R2 driver).
- Renderer and Postgres are private by design; verify them via the app's health
  endpoint and `railway ssh`, not a public URL.
