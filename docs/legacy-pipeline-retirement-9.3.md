# Legacy report pipelines — retirement 9.3

Status: **completed for this session** (extract → 410 routes → delete Batch 1/2 → verify).
Prisma microstage migration and Python template deletion remain follow-ups.

Companion to `docs/legacy-orion-retirement.md` (classic monolith composer). This document
covers the remaining gated legacy pipelines: section-pipeline, client-storyboard,
report-spec QA runners, and report generate/render v1–v3 HTTP surfaces.

UI for these paths is already behind `DIGITAL_PROFILE_LEGACY_REPORT_UI` (default off).
After this step, matching API routes return **410** with `LEGACY_REPORT_PATH_RETIRED`.
Canonical path remains unified-collection + canonical prepare/download.

---

## Delete-set

| Area | Paths |
|---|---|
| Section pipeline | `src/modules/digital-profile/orion-section-pipeline/**` |
| Client storyboard | `src/modules/digital-profile/orion-client-storyboard/**` (after extract) |
| Report-spec QA/runners | Batch 1 files under `orion-report-spec/` (see REMEDIATION / session checklist) |
| Report services/UI | `services/orion-v2-report-service.ts`, `services/orion-client-storyboard-report-service.ts`, `client/OrionV2ReportPanel.tsx`, `client/OrionClientStoryboardReportPanel.tsx` |
| HTTP routes (410 stubs preferred) | `report/orion-v2`, `report/orion-client-storyboard`, `report/generate`, `report/render` (+ downloads) |
| Microstage Prisma models | **deferred** — migration not in this session |
| Python `report_template_v1/v2/v3` + report-builder internals | **deferred** — still used by `report-builder-service` / download helpers |

## Keep / extract set (moved out of legacy folders)

| Symbol / module | New home |
|---|---|
| `media-asset-svg.ts` | `orion-golden/assets/media-asset-svg.ts` |
| `openai-rate-limit.ts` | `orion-golden/gpt/openai-rate-limit.ts` |
| `lexis-asset-builder.ts` | `orion-golden/assets/lexis-asset-builder.ts` |
| `OrionRealCaseContext` (+ row types golden needs) | `orion-golden/evidence/real-case-context.ts` |

Remaining `orion-report-spec/` modules still imported by golden/canonical
(`asset-builder`, `section-evidence-adapter`, `normalized-evidence`, `client-policy-scan`,
`orion-serp-snapshot-builder`, `highlight-explanation`, `report-spec-schema`, …) stay until a
later 9.3 follow-up.

## Routes → 410

Same pattern as `orion-golden/report/generate` (`LEGACY_REPORT_PATH_RETIRED`):

- `/report/orion-v2` + `/download`
- `/report/orion-client-storyboard` + `/download`
- `/report/generate`
- `/report/render` (legacy PPTX/PDF via report-renderer; not used by unified-collection)

Do **not** break: `unified-collection`, canonical prepare, `orion-golden` retired stubs already present.

## Follow-ups (deferred this session)

1. Prisma migration removing microstage / ORION v2 persistence models.
2. Delete or quarantine Python `report_template_v1/v2/v3` once nothing imports
   `report-builder-service` / `report-renderer-service` render paths.
3. Further collapse of leftover `orion-report-spec/` shared helpers into `orion-golden/`.
4. Dead npm scripts outside `ci:smokes` that still name deleted QA runners (removed when touched).
