# Legacy ORION Classic monolithic composer — staged retirement

Status: **classification complete, deletion pending** (no runtime module deleted yet).

This document is the durable record required before deleting the legacy ORION Classic
monolithic composer cluster. Historical report №72 (v72) behaviour is preserved through
`baselines/report-72/**` (PDF, fingerprints, page inventory, KPI signals) and the
fixtures/snapshots referenced by the canonical parity tests — not through the deleted
runtime code.

The canonical pipeline
(`CompositeDataset -> SubjectResolution -> SurfaceAnalysis -> VerifiedFindingBundle ->
ExecutiveSummary -> SectionPacks -> DeckAssembler -> render -> acceptance`) is the sole
production report path. It does **not** import any module in the delete-set below
(proven by `smoke:orion-import-graph-isolation`).

---

## 1. Runtime delete-set (`src/**`)

All modules below form a closed subgraph: each is imported only by other delete-set
members, by the `orion-golden/index.ts` barrel (lines 59–64, 82), by legacy scripts, or
by an `architecture-manifest` documentation string. No canonical runtime, route, service
or UI imports them (previous live callers were migrated in the caller-migration stage).

Literal-bearing (fail the zero-allowlist `src/**` identity scan):

| Module | Subject literal |
|---|---|
| `orion-golden/classic/orion-classic-theme-set.ts` | `Glinka` |
| `orion-golden/classic/orion-classic-text-utils.ts` | `Glinka` |
| `orion-golden/classic/orion-classic-client-content-to-report-spec.ts` | `махмудов` |
| `orion-golden/classic/orion-first36-deck-composer.ts` | `Трансмаш` |

Monolithic composer / render / R10 pipeline (transitively depend on the literal modules):

| Module | Reason |
|---|---|
| `orion-golden/classic/orion-classic-audit-deck-composer.ts` | audit-variant monolithic composer |
| `orion-golden/classic/run-orion-classic-audit-render.ts` | legacy render entry (composer→PPTX/PDF) |
| `orion-golden/classic/render-first36-report.ts` | wraps `run-orion-classic-audit-render` |
| `orion-golden/run-r10-orion-golden-e2e.ts` | legacy R10 content-brain E2E |
| `orion-golden/rebuild-client-content-for-report-run.ts` | calls `runR10` (zero remaining callers) |
| `services/orion-classic-audit-report-service.ts` | legacy report queue/service (zero remaining callers) |

Legacy-only QA/gate helpers that import the literal/composer modules (used only by the
monolith + legacy scripts; the canonical pipeline has its own geometry/client-copy/
metric/acceptance gates):

| Module | Delete-set dependency |
|---|---|
| `orion-golden/classic/first36-acceptance-gate.ts` | imports `cross-slide-metric-consistency`, `OrionThemeSet` |
| `orion-golden/classic/cross-slide-metric-consistency.ts` | `OrionThemeSet` type |
| `orion-golden/classic/serp-position-tables-with-query.ts` | `orion-classic-text-utils` |
| `orion-golden/classic/orion-classic-commercial-pack.ts` | `orion-classic-text-utils` |
| `orion-golden/classic/orion-classic-audit-quality-inspection.ts` | report-spec + theme-set |

## 2. Barrel

`orion-golden/index.ts` re-exports the delete-set on lines 59–64 and 82. These re-export
lines must be removed. No `src/**` file imports the delete-set symbols via the barrel
(scripts import them by direct path), so removal is caller-safe.

## 3. Modules that STAY (subject-agnostic; no delete-set dependency)

`arsenkin-report-binding`, `composite-serp-overlay-merge`, `execute-canonical-arsenkin-stage`,
`arsenkin-execution-plan`, `arsenkin-subject-query-plan`, `arsenkin-stage-ledger`,
`arsenkin-canary-run-lifecycle`, `arsenkin-canonical-live-gate`, `arsenkin-client-binding-gate`,
`arsenkin-provenance-backfill-match`, `rerender-task-preflight`, `ai-answer-evaluation`,
`plan-arsenkin-exact-tasks`, `client-copy-completeness`, `sidebar-client-policy`,
`generate-first36-geometry-artifacts`, `source-artifact-reconciliation`, `client-language`,
`search-results-pagination`, `enrich-report-run-with-arsenkin`, `orion-first36-registry.v1`,
and the other canonical-shared `classic/arsenkin-*` modules. These carry no subject
literals and are not part of the monolithic composer runtime path.

---

## 4. Script classification

Canonical replacements already covering the retired assertions (all `NETWORK_CALLS=0`):
`smoke:canonical-report-prepare`, `smoke:canonical-orchestration-e2e`,
`smoke:canonical-route-ui-e2e`, `smoke:canonical-glinka-parity`,
`smoke:canonical-artifact-download`, `smoke:orion-deck-sections`,
`smoke:orion-import-graph-isolation`, `smoke:orion-subject-universality`,
`smoke:orion-src-identity-scan`. These assert base-slot coverage (36/36), continuation
adjacency, geometry/client-copy/metric gates, provider binding/provenance, stale/foreign
rejection, recovery/idempotence and Glinka parity on the canonical pipeline.

### LEGACY_ONLY_RETIRE — exercise only the removed monolith (delete after doc + fixture preservation)

| Script | package.json command | Imports (delete-set) |
|---|---|---|
| `smoke-classic-first36-mode.ts` | `smoke:classic-first36` | composer, report-spec, quality-inspection |
| `smoke-dynamic-first36-pagination.ts` | `smoke:dynamic-first36-pagination` | composer, report-spec |
| `smoke-first36-ai-slides.ts` | `smoke:first36-ai-slides` | composer, report-spec |
| `smoke-first36-ai-continuation.ts` | `smoke:first36-ai-continuation` | composer, report-spec |
| `smoke-first36-image-pagination.ts` | `smoke:first36-image-pagination` | composer, report-spec |
| `smoke-first36-continuation-slides.ts` | `smoke:first36-continuation-slides` | composer, report-spec |
| `smoke-first36-sidebar-client-policy.ts` | `smoke:first36-sidebar-client-policy` | composer, report-spec |
| `smoke-classic-compliance-visuals.ts` | `smoke:classic-compliance-visuals` | audit-deck-composer, composer, report-spec |
| `smoke-cross-slide-metric-consistency.ts` | `smoke:cross-slide-metric-consistency` | cross-slide-metric-consistency, theme-set |
| `smoke-first36-p0-acceptance-defects.ts` | `smoke:first36-p0-acceptance` | first36-acceptance-gate, serp-position-tables, theme-set |
| `smoke-first36-acceptance-hardening.ts` | `smoke:first36-acceptance-hardening` | first36-acceptance-gate |
| `validate-first36-render.ts` | (none) | composer, report-spec, gates |
| `render-first36-real-case65.ts` | (none) | composer, report-spec, theme-set, gates |
| `rebuild-first36-p0-offline.ts` | (none) | composer, report-spec |
| `rerender-canary-first36.ts` | (none) | run-orion-classic-audit-render, rebuild-client-content |
| `run-first36-live-render.ts` | (none) | run-orion-classic-audit-render |
| `accept-first36-report.ts` | (none) | first36-acceptance-gate, renderFirst36Report |
| `r10-7-run-calibration.ts` | (none) | runR10 (dynamic) |
| `qa-r10-orion-golden-real-case.ts` | (see package.json) | R10 pipeline |
| `qa-r10-11-classic-orion-audit.ts` | (see package.json) | classic audit |
| `recompose-first36-v55-checkpoint.ts` | (none) | composer |
| `offline-first36-compose-render.ts` | (none) | composer/render |
| `smoke-first36-v57-sidebar.ts` | (none) | composer |
| `smoke-classic-image-grid.ts` | `smoke:classic-image-grid` | composer |
| `smoke-classic-uae-media-table.ts` | `smoke:classic-uae-media-table` | composer |
| `smoke-classic-orion-content.ts` | (see package.json) | classic content |

### MIGRATE_TO_CANONICAL — mixed arsenkin/canonical value; drop the monolith-gate portion

| Script | Keep (canonical) | Drop (delete-set) |
|---|---|---|
| `smoke-composite-serp-overlay.ts` | composite overlay merge, base-preservation | first36-acceptance-gate, theme-set |
| `smoke-arsenkin-p0-hardening.ts` | arsenkin p0 assertions | first36-acceptance-gate |
| `smoke-arsenkin-p0-followup.ts` | arsenkin provenance/preflight | first36-acceptance-gate |
| `import-glinka-case.ts` | case import fixture | runR10 + legacy render (replace with unified job / fixture load) |

### DOCUMENTATION / ARTIFACT_ONLY

`baselines/report-72/**` (v72 PDF, fingerprints, KPI signals, page inventory) — retained.
`architecture/orion-architecture-manifest.ts` references `runR10OrionGoldenE2e` only as a
documentation string; update the string when the module is deleted.

---

## 5. Deletion order (executed only after script imports resolved)

1. Migrate/retire scripts above; prove canonical replacements pass.
2. Remove `orion-golden/index.ts` re-export lines 59–64 and 82.
3. Delete the 15 runtime delete-set modules.
4. Remove dangling `package.json` commands for retired scripts.
5. Run final gates; emit `SUBJECT_UNIVERSALITY_PASS=true` only after all pass.

---

## 6. Deletion executed (staged retirement complete)

**Runtime modules deleted (15):**
`orion-classic-theme-set`, `orion-classic-text-utils`,
`orion-classic-client-content-to-report-spec`, `orion-first36-deck-composer`,
`orion-classic-audit-deck-composer`, `run-orion-classic-audit-render`,
`render-first36-report`, `first36-acceptance-gate`, `cross-slide-metric-consistency`,
`serp-position-tables-with-query`, `orion-classic-commercial-pack`,
`orion-classic-audit-quality-inspection`, `run-r10-orion-golden-e2e`,
`rebuild-client-content-for-report-run`, `services/orion-classic-audit-report-service`.

**Scripts retired (29):** all `LEGACY_ONLY_RETIRE` scripts listed above plus
`smoke-arsenkin-report-generate-route-e2e.ts` (targeted the retired legacy report route).
The 4 `MIGRATE_TO_CANONICAL` scripts were rewritten against the canonical pipeline and kept.

**Barrel:** `orion-golden/index.ts` legacy re-exports removed (classic composer cluster + run-r10);
non-deleted R10 client variants (`report-spec/orion-client-content-to-report-spec`,
`composer/orion-client-audit-deck-composer`) retained.

**package.json:** all commands for retired scripts removed. `smoke:suite`/`smoke:all` never
referenced the delete-set, so no aggregate breakage.

**Historical v72 behavior preserved via:** `baselines/report-72/**` (PDF, fingerprints, KPI
signals, page inventory), the architecture manifest's legacy `llmUsagePoints` /
`destructiveReplacementPoints` catalog (historical description only), and this document.

### Deletion gate — proven before deletion
- Zero static imports of the delete-set (ripgrep `src/` + `scripts/`): CLEAN.
- Zero dynamic imports (`import(...)`) of the delete-set in `src/`: CLEAN.
- Zero barrel exports: removed.
- Zero route callers: legacy report routes return `LEGACY_REPORT_PATH_RETIRED` (410), no composer import.
- Zero UI callers: `ReportPreviewPanel`/admin views use canonical status/links only.
- Every previous live caller has a passing canonical replacement test (see gates below).

### Final gates — all green
- Zero-literal `src/**` identity scan + import-graph isolation + subject-universality: 14/14.
- Canonical suite (prepare, orchestration E2E, route/UI E2E, Glinka 41-page parity,
  artifact-download auth/traversal, deck-sections) + migrated scripts: 121/121.
- Arsenkin UI orchestration / workflow isolation / p05 lifecycle: 44/44.
- `npm run typecheck`: clean (exit 0).

`SUBJECT_UNIVERSALITY_PASS=true`
