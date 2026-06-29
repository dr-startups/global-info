# Global Info

Full-stack platform (Next.js + TypeScript + Prisma + PostgreSQL).

## Modules

### Digital Profile Audit (`src/modules/digital-profile`)

Evidence-first system that produces a corporate compliance-style PDF report about a
person's digital profile. The module is **isolated behind a feature flag** and ships
in stages — see `src/modules/digital-profile/README.md`.

Full module documentation lives in [`docs/digital-profile/`](docs/digital-profile/README.md):
[Architecture](docs/digital-profile/ARCHITECTURE.md) ·
[Deployment](docs/digital-profile/DEPLOYMENT.md) ·
[QA](docs/digital-profile/QA.md) ·
[Final QA checklist](docs/digital-profile/FINAL_QA.md) ·
[Security & privacy](docs/digital-profile/SECURITY.md).

Core principles:

- **Evidence-first.** Every statement in a report must reference evidence: a URL,
  a screenshot, an imported file, or a database record.
- **LLM is not a source of truth.** The LLM may only classify, summarize and draft
  text based on existing evidence.
- **Lawful only.** Compliance databases (LexisNexis, Dow Jones, World-Check) are
  integrated strictly via official API connectors or manual import. No leaked or
  illegal datasets. No automated Wikipedia publishing.
- **Auth & roles (Stage M1).** Optional session-cookie auth (`DIGITAL_PROFILE_AUTH_ENABLED`)
  with roles `SUPER_ADMIN`/`ADMIN`/`ANALYST`/`REVIEWER`/`CLIENT_VIEWER` and
  per-case access. Disabled by default (demo); **enable in production**. See
  [Security & privacy](docs/digital-profile/SECURITY.md).
- **Private storage & deploy hardening (Stage M2).** All files go through a
  `StorageProvider` (local/private driver; S3/R2-ready interface), with
  traversal-safe keys, signed downloads that never bypass authorization, and
  health endpoints (`/api/digital-profile/health`, renderer `/health`). See
  [Deployment](docs/digital-profile/DEPLOYMENT.md).
- **Production deploy rehearsal (Stage M3).** Containerized app (`Dockerfile`) +
  full `docker-compose.prod.yml` (app + postgres + renderer), runtime env
  validation (fail-fast in production), `admin:create`, and `smoke:prod`. See
  [Deployment](docs/digital-profile/DEPLOYMENT.md#production-like-deployment-docker-compose--stage-m3).
- **Railway deployment (Stage M4).** Config-as-code (`railway.app.json`,
  `railway.renderer.json`) for a 3-service Railway project with a **stateless
  renderer** (returns PPTX/PDF over HTTP; app persists them on its Volume),
  private renderer/Postgres and a public app domain. See
  [Railway deployment](docs/digital-profile/RAILWAY_DEPLOYMENT.md).
- **Real Yandex search (Stage N1).** Optional `REAL_YANDEX_SEARCH` agent backed
  by the official **Yandex Cloud Search API v2** (`POST /v2/web/search`, Api-Key
  header) fills `search_results` with real evidence so the ORION-style SERP
  snapshot is built from real (not mock) data. Disabled by default
  (`DIGITAL_PROFILE_YANDEX_REAL_ENABLED=false`); it is a **paid** API and the key
  is never logged/stored. Results are evidence candidates, not verified facts.
  See [Deployment](docs/digital-profile/DEPLOYMENT.md#real-yandex-search-stage-n1).
- **SERP snapshot source preference (Stage N1.2).** The ORION snapshot prefers
  real `search_results` when present, with a predictable fallback. A
  `sourcePreference` (`prefer_real` default / `real_only` / `mock_only` / `mixed`)
  selects real-vs-mock per engine; the result, metadata and `report_json` expose
  `sourceMode` (`REAL_ONLY` / `MIXED` / `MOCK_ONLY` / `EMPTY`) plus a `perEngine`
  breakdown, and the image carries a secrets-free source label.
- **Result classification + ORION highlights (Stage N1.3).** A **deterministic**
  (no-LLM) classifier tags each `search_result` (RELEVANT / NEUTRAL / NEWS /
  CORPORATE / SOCIAL_PROFILE / ADVERSE_MEDIA / SANCTIONS / PEP / CRIMINAL /
  LEGAL_DISPUTE / HIGH_RISK) with a `riskTheme` + `confidence` from RU/EN keyword
  dictionaries. Analysts can **manually** mark a result adverse/neutral, assign a
  theme, or clear the override. The ORION snapshot draws a **red frame** only when
  a result is manually adverse, linked to an active `risk_finding`, or auto-classified
  risky at MEDIUM/HIGH confidence — never on a single weak term. A search result is
  an evidence candidate, not a verified fact; a red frame is not a final legal
  conclusion. Offline: `npm run smoke:real-result-classifier`.
- **Real Google search (Stage N2).** Optional `REAL_GOOGLE_SEARCH` agent with a
  **provider-agnostic** strategy (`GOOGLE_SEARCH_PROVIDER`): `custom_search`
  (Google Programmable Search / Custom Search JSON API) or `external_serp` (a
  separately-selected paid SERP API; skeleton only). **No scraping, no Playwright.**
  Results are stored as `source=real:GOOGLE` and flow into the SERP snapshot, so
  real Yandex + real Google make page 10 `REAL_ONLY`. API errors (no-access / quota /
  timeout) surface as normalized errors and are **never** hidden under mock. Keys
  (`key`/`cx`) are never logged or persisted. Note: the Custom Search API may be
  unavailable to new Google Cloud projects (migration risk). Offline:
  `npm run smoke:google-provider`. See
  [Deployment](docs/digital-profile/DEPLOYMENT.md#real-google-search-stage-n2).

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env   # then edit DATABASE_URL etc.

# 3. Set up the database
npm run db:generate
npm run db:migrate
npm run db:seed          # 3 demo cases + 4 demo users (auth)

# 4. Start the report renderer (Docker)
docker compose up -d --build renderer

# 5. Run the app
npm run dev
# open http://localhost:3000/admin/digital-profile
```

## Useful scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start Next.js dev server |
| `npm run typecheck` | TypeScript type checking |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:seed` | Insert 3 demo cases + 4 demo users |
| `npm run db:studio` | Open Prisma Studio |
| `npm run smoke:auth` | Auth + RBAC smoke (roles, password, session, access) |
| `npm run smoke:yandex-provider` | Real Yandex v2 provider smoke (offline: availability, XML decode, XXE guard, status mapping, sourceMode) |
| `npm run smoke:google-provider` | Real Google provider smoke (offline: strategy gating, Custom Search normalize, URL redaction, error mapping, external skeleton, sourceMode) |
| `npm run smoke:serp-snapshot-real-source` | SERP snapshot source preference (offline: prefer_real/real_only/mock_only/mixed, perEngine, sourceMode) |
| `npm run smoke:real-result-classifier` | N1.3 result classifier + highlight resolver (offline: neutral vs risky, confidence, manual override, findings, theme grouping) |
| `npm run smoke:storage` | Storage abstraction + key/path-traversal + signed tokens + download policy |
| `npm run smoke:health` | Health checks (storage round-trip, renderer ping, compose) |
| `npm run admin:create` | Create the first SUPER_ADMIN (env `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME`) |
| `npm run db:deploy` | `prisma migrate deploy` (production migrations) |
| `npm run smoke:prod` | Smoke a running deployment (health, auth, no secret leak, invalid token) |
| `npm run smoke:all` | typecheck + build + full smoke suite (needs dev server + renderer) |
| `npm run smoke:all:with-renderer` | builds/starts the Docker renderer, then `smoke:all` |
