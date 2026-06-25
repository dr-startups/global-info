# QA — Smoke Tests

The module ships a suite of smoke tests (`scripts/smoke-*.mjs` / `.ts`) that hit
the running dev server and (for report tests) the Python renderer.

## Prerequisites

- `DIGITAL_PROFILE_ENABLED="true"` in `.env`
- Postgres running and migrated (`npm run db:migrate`)
- Dev server running: `npm run dev` (http://localhost:3000)
- Renderer running (for render/report tests):
  `docker compose up -d --build renderer` (http://localhost:8080)

Override targets with `BASE_URL` / `RENDERER_URL` env vars if needed.

## Individual scripts

| Script | Needs renderer | Checks |
| --- | --- | --- |
| `npm run smoke:agents` | no | mock agents + orchestration, dedup |
| `npm run smoke:wikipedia` | no | real Wikipedia connector (graceful) |
| `npm run smoke:search-providers` | no | provider availability (pure, tsx) |
| `npm run smoke:search-surfaces` | no | surfaces CRUD + mock/real agents |
| `npm run smoke:risk-classifier` | no | deterministic findings, dedup, review |
| `npm run smoke:audit-summary` | no | aggregation, regions, overall risk |
| `npm run smoke:render` | yes | base render + signed downloads |
| `npm run smoke:report-template` | yes | template v1 + simple fallback |
| `npm run smoke:report-template-v2` | yes | 36-page v2 + fallbacks |
| `npm run smoke:report-template-v3` | yes | polished v3, audience/watermark |

## Umbrella scripts

```bash
# typecheck + build + full smoke suite (assumes dev server + renderer running)
npm run smoke:all

# same, but builds/starts the Docker renderer first
npm run smoke:all:with-renderer
```

`smoke:all` runs: `typecheck` → `build` → `smoke:suite` (all ten smokes above).
Because the smokes call the running dev server, **start `npm run dev` first** (in
a separate terminal). `smoke:all:with-renderer` additionally runs
`docker compose up -d --build renderer` before the suite.

## What "pass" looks like

Each script prints `[PASS]/[FAIL]` lines and exits non-zero on any failure,
ending with `ALL CHECKS PASSED`. The report tests assert:
- PPTX has a `PK` (zip) signature; PDF has a `%PDF-` signature.
- `templateVersion`, `slideCount`, `audience`, `watermarkMode`, `warnings` are
  returned and correct.
- Empty/no-data cases do **not** crash and still produce a valid deck with
  renderer warnings.
- v1/v2/simple fallbacks keep working.
