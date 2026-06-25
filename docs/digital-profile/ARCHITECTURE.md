# Architecture — Digital Profile Audit

## High-level

```
Admin UI (Next.js client)
      │  fetch /api/digital-profile/*
      ▼
Next.js API routes  ──  withModule() envelope (feature flag + error handling)
      │
      ▼
Module services (src/modules/digital-profile/*)
   ├─ case-service            CRUD for cases/subjects/evidence
   ├─ agents (G/H)            mock + real-safe agents, orchestration
   ├─ providers (H1–H3)       Wikipedia / Google / Yandex availability + calls
   ├─ search-surfaces (H3)    suggestions/related/images/videos/knowledge
   ├─ risk classifier (I)     deterministic, evidence-first findings
   ├─ audit-summary (J)       deterministic aggregation -> summary blocks
   ├─ report-builder (D)      builds report_json from DB evidence
   └─ report-renderer (E)     calls Python renderer, stores PPTX/PDF keys
      │
      ▼
Prisma / PostgreSQL          dp_* tables (evidence-first)
Private storage (./storage)  screenshots + report_json + pptx/pdf
      │  HTTP POST /render
      ▼
Python renderer (FastAPI)    python-pptx + headless LibreOffice -> PPTX/PDF
```

## Module isolation

Everything lives under `src/modules/digital-profile` and `src/app/api/digital-profile`.
The master flag `DIGITAL_PROFILE_ENABLED` gates the whole module via
`withModule()` (`src/modules/digital-profile/http/errors.ts`): when disabled,
every route returns `{ ok:false, error:{ code:"MODULE_DISABLED" } }` (404).

## Data model (Prisma, `dp_*`)

`Case` → `Subject`, `SearchQuery`, `SearchResult`, `SearchSurfaceItem`,
`Screenshot`, `WikipediaCheck`, `DatabaseProfile`, `AiProfile`, `RiskFinding`,
`ReportVersion`, `AgentRun`, `AuditLog`.

Evidence-first invariants:
- Findings carry mandatory `evidenceRefs`.
- Raw provider payloads (`rawMetadata` / `rawPayload`) are stored but never
  rendered raw.
- Evidence is soft-deleted (never hard-deleted without explicit admin action).
- Demo/mock data is flagged (`demo`, `source = "mock:*"`).

## Agents & orchestration (G/H)

- `CaseAgent` interface with `AgentKind` (MOCK | REAL) and `AgentAvailability`.
- Mock agents produce deterministic demo evidence (flagged demo).
- Real-safe agents (Wikipedia) call official public APIs only.
- `REAL_SAFE_AUDIT_ORDER` defines the safe run order. Re-runs are idempotent
  (dedup by hash) so audits don't duplicate evidence.

## Providers (H1–H3)

`providers/config.ts` resolves availability **from config only** (no network):
`ENABLED | DISABLED | NOT_CONFIGURED`. `/api/digital-profile/providers` exposes
`status`, `missingConfigKeys`, `capabilities`, `supportsRealCalls`, `notes`.
Capabilities declare what is/ isn't supported (e.g. image search = NOT_SUPPORTED,
no scraping).

## Risk classifier (I)

Deterministic rules over existing evidence → `RiskFinding` rows with
`signalType`, `riskTheme`, `confidence`, `rationale`, `dedupHash`. Findings are
**review-first** (`PENDING`). No LLM, no network.

## Audit summary (J)

`audit-summary/*` deterministically aggregates evidence + findings into structured
blocks (overall risk, per-region negative shares, suggestions/media, Wikipedia
status, compliance status, recommended actions). Persisted into `report_json`.

## Report build + render (D/E/K)

1. `report-builder-service` builds `report_json` (a new DRAFT `ReportVersion`),
   including the `offer` block from `report/offer-config.ts`.
2. `report-renderer-service.renderReportVersion(caseId, version, ctx, options)`
   POSTs `report_json` + storage keys + `{ templateVersion, audience,
   watermarkMode }` to the Python renderer, then persists `pptxStorageKey`,
   `pdfStorageKey`, `templateVersion`, `renderWarnings` and records
   `slideCount` / `audience` / `watermarkMode` in the audit log + DTO.
3. Downloads are served only via **signed URLs** (`storage/signed-url.ts`).

### Renderer (Python)

`renderer/` (FastAPI). `render_pptx.build_pptx()` dispatches by
`templateVersion`:
- `report_template_v1/v2/v3.py` build decks; `report_mapper.py` turns
  `report_json` into a safe view model with defaults.
- `theme.py` (K3) holds the design system (palette, typography, spacing,
  cards/badges/tables) used by v3.
- Robustness: each slide is wrapped in try/except (warnings, not crashes), and a
  whole-template failure falls back to the `simple` renderer. PDF is produced via
  headless LibreOffice.
