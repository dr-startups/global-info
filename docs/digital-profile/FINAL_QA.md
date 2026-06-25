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

## Regression

24. [ ] `npm run smoke:all:with-renderer` → `ALL CHECKS PASSED`
25. [ ] In Report Preview, confirm Template **v2** and **Simple** still generate
