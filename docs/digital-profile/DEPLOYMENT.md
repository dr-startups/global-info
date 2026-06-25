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
| `DIGITAL_PROFILE_STORAGE_DIR` | Private storage root |
| `DIGITAL_PROFILE_SIGNED_URL_SECRET` | Signing secret (alias: `DIGITAL_PROFILE_SIGNING_SECRET`) |
| `DIGITAL_PROFILE_SIGNED_URL_TTL` | Signed URL TTL (seconds) |
| `RENDERER_URL` | Renderer base URL (alias: `DIGITAL_PROFILE_RENDERER_URL`) |
| `DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION` | Server-side fallback template |
| `DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED` | Master switch for keyed SERP providers |
| `DIGITAL_PROFILE_WIKIPEDIA_ENABLED` | Wikipedia (public API; independent) |
| `DIGITAL_PROFILE_GOOGLE_ENABLED` + `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_ENGINE_ID` | Google official API |
| `DIGITAL_PROFILE_YANDEX_ENABLED` + `YANDEX_SEARCH_API_KEY` + `YANDEX_SEARCH_FOLDER_ID` + `YANDEX_SEARCH_REGION` | Yandex official API |
| `DIGITAL_PROFILE_PROVIDER_TIMEOUT_MS` / `DIGITAL_PROFILE_PROVIDER_MAX_RESULTS` | Keyed provider HTTP limits |

**Production:** always set a strong, unique `DIGITAL_PROFILE_SIGNED_URL_SECRET`
and a non-default `DATABASE_URL`. Never commit real secrets.

## Migrations

```bash
npm run db:generate      # prisma generate
npm run db:deploy        # prisma migrate deploy (production)
# dev only:
npm run db:migrate       # prisma migrate dev
npm run db:seed          # demo cases (omit in production)
```

## Docker (renderer)

```bash
docker compose up -d --build renderer
docker compose logs -f renderer
```

## Health checks

| Check | How |
| --- | --- |
| Renderer | `GET http://localhost:8080/health` → `200` |
| API (module on) | `GET /api/digital-profile/providers` → `200` + provider statuses |
| API (module off) | any `/api/digital-profile/*` → `404` `MODULE_DISABLED` |

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
- No auth/roles, queues, or background jobs in this module (out of scope).
