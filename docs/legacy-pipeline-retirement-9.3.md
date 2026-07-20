# Legacy report pipelines — retirement 9.3

Status: **follow-ups completed** (shared helpers collapsed into golden →
legacy report v1–v3 runtime retired → Prisma microstage tables dropped → verify).

Companion to `docs/legacy-orion-retirement.md` (classic monolith composer). This document
covers the remaining gated legacy pipelines: section-pipeline, client-storyboard,
report-spec QA runners, and report generate/render v1–v3 HTTP surfaces.

UI for these paths is already behind `DIGITAL_PROFILE_LEGACY_REPORT_UI` (default off).
Matching API routes return **410** with `LEGACY_REPORT_PATH_RETIRED`.
Canonical path remains unified-collection + canonical prepare/download.

---

## Delete-set (done)

| Area | Paths |
|---|---|
| Section pipeline | `src/modules/digital-profile/orion-section-pipeline/**` |
| Client storyboard | `src/modules/digital-profile/orion-client-storyboard/**` (after extract) |
| Report-spec package | `src/modules/digital-profile/orion-report-spec/**` (helpers moved into `orion-golden/`) |
| Report services/UI | `services/orion-v2-report-service.ts`, `services/orion-client-storyboard-report-service.ts`, `services/report-builder-service.ts`, `client/OrionV2ReportPanel.tsx`, `client/OrionClientStoryboardReportPanel.tsx` |
| HTTP routes (410) | `report` (GET), `report/orion-v2`, `report/orion-client-storyboard`, `report/generate`, `report/render` (+ downloads where applicable) |
| Microstage Prisma models | Migration `20260720153000_drop_orion_microstage_persistence` |
| Python `report_template_v1/v2/v3` | Deleted; `render_pptx.build_pptx` only supports `simple`; `/render` returns 410 for `report-template-v*` |

## Keep / extract set

| Symbol / module | Home |
|---|---|
| `media-asset-svg.ts` | `orion-golden/assets/media-asset-svg.ts` |
| `openai-rate-limit.ts` | `orion-golden/gpt/openai-rate-limit.ts` |
| `lexis-asset-builder.ts` | `orion-golden/assets/lexis-asset-builder.ts` |
| `OrionRealCaseContext` | `orion-golden/evidence/real-case-context.ts` |
| `asset-builder.ts` / `orion-serp-snapshot-builder.ts` / `client-safe-evidence.ts` | `orion-golden/assets/` |
| `normalized-evidence.ts` / `section-evidence-adapter.ts` / `highlight-explanation.ts` / `qa-case-context.ts` | `orion-golden/evidence/` |
| `report-spec-schema.ts` | `orion-golden/report-spec/report-spec-schema.ts` |
| `client-policy-scan.ts` | `orion-golden/qa/client-policy-scan.ts` |
| `ReportVersion` + archival download | Kept — `GET /reports/[id]/download` streams stored PPTX/PDF only (`report-renderer-service.getReportFileForDownload`) |
| `OrionReportRun` / `OrionArsenkinStageRun` | Kept for unified-collection / Arsenkin ledger |

## Routes → 410

Same pattern as `orion-golden/report/generate` (`LEGACY_REPORT_PATH_RETIRED`):

- `/report` (GET latest report_json)
- `/report/orion-v2` + `/download`
- `/report/orion-client-storyboard` + `/download`
- `/report/generate`
- `/report/render` (legacy PPTX/PDF via report-renderer; not used by unified-collection)

**Archival keep:** `GET /api/digital-profile/reports/[id]/download` still streams already-stored
artifacts for historical `ReportVersion` rows (no template generation).

Do **not** break: `unified-collection`, canonical prepare, `orion-golden` render (`/orion/render-golden`).
