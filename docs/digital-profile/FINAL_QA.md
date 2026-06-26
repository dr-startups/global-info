# Final QA — Demo / Acceptance Checklist

Run through this end-to-end before a demo or pilot. Expected result in brackets.

## Setup

1. [ ] Fresh install: `npm install`
2. [ ] `.env` from `.env.example`, set `DIGITAL_PROFILE_ENABLED="true"` + `DATABASE_URL`
3. [ ] DB: `npm run db:generate && npm run db:migrate`
4. [ ] Seed: `npm run db:seed` (→ 3 demo cases `DPA-2026-0001/0002/0003`)
5. [ ] Renderer: `docker compose up -d --build renderer`
       (`curl http://localhost:8080/health` → `200`)
6. [ ] App: `npm run dev` → open `http://localhost:3000/admin/digital-profile`

## Happy path (rich mock case)

7. [ ] Open case `DPA-2026-0001` (Maria Demidova — DEMO)
8. [ ] Run **Mock full audit** (→ search/wiki/compliance evidence appears, demo-flagged)
9. [ ] Run **Mock Search Surfaces** (→ suggestions/related/images/videos/knowledge)
10. [ ] Run **Risk Classifier** (→ PENDING findings with evidence refs)
11. [ ] **Build Audit Summary** (→ overall risk, regions, recommended actions)
12. [ ] **Report Preview**: Template **v3**, Audience **Internal**, Watermark **Draft** → **Generate**
       (→ success message, `slideCount ~50`, `templateVersion = report-template-v3`)
13. [ ] **Download PPTX** (opens; polished cover, cards, tables, commercial block, DRAFT)
14. [ ] **Download PDF** (opens; renders cohesively)
15. [ ] Re-generate with Audience **Client**, Watermark **None**
       (→ technical notes softened; no watermark)

## Real Yandex Search (Stage N1) — optional, paid API

> Only run with a real Yandex Cloud API key + folder id. The flag must be ON.

R1. [ ] With the flag OFF: `GET /api/digital-profile/providers` shows
        `Yandex Search Real` → `enabled=false`, `supportsRealCalls=false`
R2. [ ] Without keys (flag ON): provider shows `NOT_CONFIGURED` +
        `missingConfigKeys` (names only, no values)
R3. [ ] `npm run smoke:yandex-provider` → ALL CHECKS PASSED (offline)
R4. [ ] Set `DIGITAL_PROFILE_YANDEX_REAL_ENABLED=true` + key/folder → provider
        shows `enabled=true, configured=true, supportsRealCalls=true`
R5. [ ] Agents tab → **Yandex Search (real)** → Run → confirm cost dialog
        (RU/EN) → success shows queries/results saved
R6. [ ] `search_results` now contain rows with `source = real:YANDEX`
        (mock rows untouched); re-run does **not** duplicate
R7. [ ] Generate **SERP Snapshot** → "Includes real search results" badge;
        `sourceMode = REAL_ONLY` or `MIXED`
R8. [ ] Audit log has `REAL_YANDEX_SEARCH_RUN` with counts/duration — **no key**
R9. [ ] A non-ADMIN/ANALYST role cannot run the real agent (403)

## Empty / data-quality case

16. [ ] Open `DPA-2026-0002` (Ivan Pustov — DEMO empty) → Build Audit Summary
        (→ data-quality warnings; overall risk UNKNOWN/low)
17. [ ] Generate Template v3 (→ no crash, valid deck, renderer warnings present)

## Mixed real-safe case

18. [ ] Open `DPA-2026-0003` (Sven Andersson — DEMO real-safe)
19. [ ] Check **Providers**: Wikipedia `ENABLED`, Google/Yandex `DISABLED`/`NOT CONFIGURED`
20. [ ] Run real-safe Wikipedia agent (→ check written, not demo)

## Negative / hardening checks

21. [ ] Stop the renderer (`docker compose stop renderer`), Generate report
        (→ graceful `RENDERER_UNAVAILABLE` message, no crash). Restart it after.
22. [ ] Tamper a download URL token (→ `404`, no file leak)
23. [ ] Temporarily set `DIGITAL_PROFILE_ENABLED="false"`, hit any module route
        (→ `404 MODULE_DISABLED`). Re-enable after.

## Auth + roles (Stage M1)

Run with `DIGITAL_PROFILE_AUTH_ENABLED="true"` and a set
`DIGITAL_PROFILE_SESSION_SECRET`, after `npm run db:seed` (creates demo users).

26. [ ] `npm run db:migrate && npm run db:seed` (→ `dp_users` + `dp_case_access`
        seeded; 4 demo users printed)
27. [ ] Open `/admin/digital-profile` without logging in (→ redirected to
        `/admin/digital-profile/login`)
28. [ ] Log in as `superadmin@demo.local` (→ full access; user + role badge shown)
29. [ ] Log in as `analyst@demo.local` (→ can add evidence / run agents / classify;
        **Delete** and admin-only actions hidden; delete API → `403`)
30. [ ] Log in as `reviewer@demo.local` (→ can review/dismiss findings + generate
        **client** report; cannot classify or run agents)
31. [ ] Log in as `client@demo.local` (→ sees **only** `DPA-2026-0001`; no Agents
        / raw Evidence / mock/debug tabs; can view report tab only)
32. [ ] As client viewer, attempt to download an internal/draft report (→ blocked /
        `403`); raw screenshot/evidence download blocked even with a valid token
33. [ ] Sign out (→ redirected to login; session cookie cleared)
34. [ ] `npm run smoke:auth` → `smoke:auth PASSED`
35. [ ] Set `DIGITAL_PROFILE_AUTH_ENABLED="false"` again → demo flow works without
        login (synthetic admin); smoke suite still green

## Storage + deployment hardening (Stage M2)

36. [ ] `npm run db:migrate && npm run db:seed`
37. [ ] `docker compose up -d --build renderer` →
        `docker inspect --format '{{.State.Health.Status}}' global-info-renderer`
        becomes `healthy`
38. [ ] `npm run dev`, log in as `superadmin@demo.local`
39. [ ] Generate a **Template v3** report; download PPTX **and** PDF (→ both open;
        artifacts land under `storage/digital-profile/cases/{caseId}/reports/...`)
40. [ ] Log in as `client@demo.local` → only the assigned client report is
        downloadable; internal/draft report download → `403`/blocked
41. [ ] Tamper a download token (→ `404`); wait past TTL / use an expired token
        (→ `404`)
42. [ ] Stop the renderer (`docker compose stop renderer`); open
        `GET /api/digital-profile/health` (→ `"renderer":"unavailable"`, still
        `200` while DB+storage ok). Generating a report shows a graceful
        `RENDERER_UNAVAILABLE` message.
43. [ ] Restart the renderer; `GET /api/digital-profile/health` →
        `{"ok":true,"database":"ok","storage":"ok","renderer":"ok",...}`
44. [ ] Renderer `GET http://localhost:8080/health` →
        `{"ok":true,"libreOfficeAvailable":true,...}`
45. [ ] `npm run smoke:storage` → `smoke:storage OK`
46. [ ] `npm run smoke:health` → `smoke:health OK`

## Production deploy rehearsal (Stage M3)

47. [ ] `git status` clean
48. [ ] `cp .env.production.example .env.production` and fill in real secrets
        (strong `POSTGRES_PASSWORD`, `DATABASE_URL`, `DIGITAL_PROFILE_SESSION_SECRET`,
        `DIGITAL_PROFILE_SIGNED_URL_SECRET`)
49. [ ] `docker compose -f docker-compose.prod.yml up -d --build`
50. [ ] `docker compose -f docker-compose.prod.yml ps` → postgres/renderer/app **healthy**
51. [ ] `curl http://localhost:3000/api/digital-profile/health` → `200` ok
52. [ ] `curl http://localhost:8080/health` → `{"ok":true,...}`
53. [ ] `docker compose -f docker-compose.prod.yml exec app npm run db:deploy`
54. [ ] Create admin: `... exec -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... app npm run admin:create`
        (or, demo only, `... exec app npm run db:seed:demo`)
55. [ ] Open `/admin/digital-profile`, log in
56. [ ] Open a rich demo case (or create one); generate Template **v3** in RU and EN
57. [ ] Download PPTX + PDF (both open)
58. [ ] `docker compose -f docker-compose.prod.yml stop renderer` → health shows
        `"renderer":"unavailable"` (still `200` while db+storage ok)
59. [ ] `docker compose -f docker-compose.prod.yml start renderer` → health all `ok`
60. [ ] `SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... npm run smoke:prod` →
        `smoke:prod OK`
61. [ ] Env validation: with auth on and a weak `DIGITAL_PROFILE_SESSION_SECRET`,
        the **production** app refuses to start (fail-fast); dev only warns

## Railway deployment (Stage M4)

Pre-deploy (local): `npm run typecheck`, `npm run build`, both `railway.*.json`
valid, renderer returns bytes (stateless handoff verified).

62. [ ] app + renderer build from the same repo with Custom Config Paths
        `/railway.app.json` and `/railway.renderer.json`
63. [ ] app has a public domain; renderer has a **private domain only**
64. [ ] Postgres is managed and has **no public TCP proxy**
65. [ ] app Volume mounted at `/app/storage/digital-profile`; renderer has **no** Volume
66. [ ] app deployment ACTIVE/SUCCESS; renderer deployment ACTIVE/SUCCESS
67. [ ] `GET https://<app-domain>/api/digital-profile/health` →
        `database=ok storage=ok renderer=ok authEnabled=true`
68. [ ] unauthorized admin route redirects to login; admin login works
        (`railway ssh -s app` → `npm run admin:create`, hidden password)
69. [ ] create a case, generate RU Template v3, download PPTX + PDF
70. [ ] restart app → report still downloadable (persisted on Volume)
71. [ ] invalid download token rejected
72. [ ] logs contain no passwords / tokens / API keys
73. [ ] PostgreSQL + app Volume backups enabled; first manual backup taken

## Regression

24. [ ] `npm run smoke:all:with-renderer` → `ALL CHECKS PASSED`
25. [ ] In Report Preview, confirm Template **v2** and **Simple** still generate
