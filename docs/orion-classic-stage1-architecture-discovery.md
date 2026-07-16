# ORION Classic Stage 1 — Architecture Discovery

Characterization only. No production wiring. Source: repo inventory on branch `Arsenkin-integration-1` (2026-07-16).

## Call chain overview

```text
UI "Запустить полный аудит"
  → POST /api/digital-profile/cases/[id]/audit/run
  → runFullAudit (Yandex/Serper/base agents; Arsenkin NOT included)
  → (separate) Arsenkin CaseAgents / full-audit / enrich overlay
  → arsenkin-report-binding + composite merge
  → ORION Golden prepare / manual-review / client-content rebuild
  → ThemeSet + report spec + First36 deck compose
  → render PPTX/PDF/PNG
  → acceptance + geometry + client-copy + metric-consistency gates
```

---

## 1. UI “Запустить полный аудит” → `runFullAudit`

| Layer | Path | Symbol |
|---|---|---|
| Label | `src/modules/digital-profile/i18n/dictionaries/ru.ts` | `agents.runFullAudit` = `"Запустить полный аудит"` |
| UI | `src/modules/digital-profile/client/CaseDetailView.tsx` | `handleRunAudit` → `runFullAudit(caseId, { runtimeMode: "real_first_with_fallback" })` |
| Admin page | `src/app/admin/digital-profile/[caseId]/page.tsx` | renders `CaseDetailView` |
| Client API | `src/modules/digital-profile/client/api.ts` | `runFullAudit` → `POST /cases/{id}/audit/run` |
| Route | `src/app/api/digital-profile/cases/[id]/audit/run/route.ts` | `POST` → `runFullAudit` |
| Service | `src/modules/digital-profile/services/agent-run-service.ts` | `runFullAudit` |
| Strategy | `src/modules/digital-profile/agents/runtime-strategy.ts` | `resolveRuntimeStrategy`, `FULL_AUDIT_DEFAULT_RUNTIME_MODE` |
| Re-export | `src/modules/digital-profile/agents/orchestrator.ts` | `runFullAudit` |
| Unified base step | `src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts` | `stepBaseCollection` |

**Agents scheduled by `runFullAudit`** (capability pairs; Arsenkin excluded):

| providerId | primary | fallback |
|---|---|---|
| yandex | `REAL_YANDEX_SEARCH` | `YANDEX_SEARCH` |
| google | `REAL_GOOGLE_SEARCH` | `GOOGLE_SEARCH` |
| wikipedia | `REAL_WIKIPEDIA` | `WIKIPEDIA` |
| orion_profile | `REAL_ORION_SEARCH_PROFILE` | — |
| orion_uae_international | `REAL_ORION_UAE_INTERNATIONAL` | — |
| surfaces | `REAL_SEARCH_SURFACES` | mock `SEARCH_SURFACES` / registry `MOCK_SEARCH_SURFACES` |
| orion_google_surfaces | `REAL_ORION_GOOGLE_SURFACES` | — |
| ai_profile | `AI_PROFILE` (mock) | — |
| compliance | `COMPLIANCE_DATABASE` (mock) | — |
| risk | `RISK_CLASSIFIER_V1` | `RISK_CLASSIFIER` |
| audit_summary | `AUDIT_SUMMARY_BUILDER` | — |

Related UI label: `runUnifiedCollection` = “Запустить полный аудит и собрать ORION Golden” (unified path, not the same as base `runFullAudit`).

---

## 2. Yandex / Serper / base agents

| Role | Path | Exports |
|---|---|---|
| Registry | `src/modules/digital-profile/agents/registry.ts` | mock + real agent registrations |
| Yandex agent | `.../agents/real/real-yandex-search-agent.ts` | `RealYandexSearchAgent` (`REAL_YANDEX_SEARCH`) |
| Google agent | `.../agents/real/real-google-search-agent.ts` | `RealGoogleSearchAgent` (`REAL_GOOGLE_SEARCH`) |
| Base persist | `.../agents/real/real-search-agent-base.ts` | `saveEvidence` → `searchQuery` + `searchResult` |
| Yandex provider | `.../providers/yandex-search-provider.ts` | `yandexSearchProvider` |
| Serper organic | `.../providers/serper-search-provider.ts` | `serperSearch` |
| Serper surfaces | `.../providers/serper-surfaces.ts` | `serperOrganicWithExtras`, images/videos/autocomplete helpers |
| Map Serper | `.../serp-observation/map-serper-organic.ts` | `mapSerperOrganicToObservationDrafts` |
| Map Yandex | `.../serp-observation/map-yandex-organic.ts` | `mapYandexOrganicToObservationDrafts` |
| Ingest | `.../serp-observation/ingest-serper-organic.ts`, `ingest-yandex-organic.ts` | ingest helpers |
| Persist obs | `.../serp-observation/persist.ts` | `persistSerpObservations`, `listSerpObservationsForAuditRun` |

Single-agent route: `POST /api/digital-profile/cases/[id]/agents/[agentName]/run` → `runAgent`.

**Stores:** `SearchResult`, `SearchSurfaceItem`, `SearchDocument`, `SerpObservation`, `ProviderTask`, `SurfaceCollectionCoverage` (Prisma).

---

## 3. Arsenkin CaseAgents + full enrichment

### CaseAgent name constants

`src/modules/digital-profile/agents/real/real-arsenkin-agents.ts`:

- `ARSENKIN_SEARCH_TOP_REAL`
- `ARSENKIN_SUGGESTIONS_REAL`
- `ARSENKIN_PAA_REAL`
- `ARSENKIN_AI_SEARCH_REAL`
- `ARSENKIN_URL_AUDIT_REAL`

### Executors

| Function | File |
|---|---|
| `executeCanonicalArsenkinStage` | `orion-golden/classic/execute-canonical-arsenkin-stage.ts` |
| `executeArsenkinExecutionPlan` | `providers/arsenkin/execute-arsenkin-execution-plan.ts` |
| `enrichReportRunWithArsenkin` | `orion-golden/classic/enrich-report-run-with-arsenkin.ts` |
| CaseAgent durable cycle | `services/arsenkin-case-agent-execution.ts` |
| UI orch | `services/arsenkin-ui-orchestration-service.ts` (`prepare`/`plan`/`execute`/`syncArsenkinResultsToOrion`) |
| Full audit | `providers/arsenkin/full-audit-orchestrator.ts` (`startArsenkinFullAudit`, …) |
| Binding append | `orion-golden/classic/arsenkin-report-binding.ts` `appendCaseAgentEnrichmentToReportBinding` |
| Overlay merge | `orion-golden/classic/composite-serp-overlay-merge.ts` `overlayInventoryByCoverageCells` |
| Panel overlay | `orion-golden/classic/build-arsenkin-surface-panels.ts` `overlaySurfacePanelAssets` |

### Routes

- `GET/POST .../cases/[id]/orion-golden/arsenkin` — prepare/plan/execute/sync/full-audit/recover\*
- `POST .../cases/[id]/agents/[agentName]/run` — individual CaseAgents

### Storage

- `storage/digital-profile/arsenkin-case-agent-runs/<caseId>/`
- Binding: `arsenkin-report-binding.json` under case Golden root

**Overlay rule (factual):** enrichment replaces covered `(region|engine|surface)` cells; uncovered cells keep base (`inherited_base`). Arsenkin must not become the sole base report run.

---

## 4. ORION Golden rebuild / review queue

| Method | Route |
|---|---|
| GET/POST | `.../orion-golden/prepare` |
| GET | `.../orion-golden/manual-review` |
| GET/POST | `.../orion-golden/manual-review/[evidenceId]` |
| GET | `.../orion-golden/admin-review-decisions` |
| POST | `.../orion-golden/client-content/regenerate` |
| GET/POST | `.../orion-golden/report/generate` |
| GET | `.../orion-golden/report/download` |
| GET | `.../orion-golden/report/diagnostics-bundle` |
| GET/POST | `.../orion-golden/arsenkin` |

Admin UI: `src/app/admin/digital-profile/[caseId]/orion-golden/manual-review/page.tsx`

| Function | File |
|---|---|
| `enqueueOrionGoldenPrepare`, `getOrionGoldenPrepareSummary` | `services/orion-golden-prepare-service.ts` |
| `getManualReviewQueue`, `submitAdminReviewDecision`, regenerate helpers | `orion-golden/services/admin-review-workflow-service.ts` |
| `buildManualReviewQueue` | `orion-golden/evidence/manual-review-queue.ts` |
| `runR10OrionGoldenE2e` | `orion-golden/run-r10-orion-golden-e2e.ts` |

**Artifacts:** `manual-review-queue.json`, `admin-review-decisions.json`, `orion-client-content.pre-review.json`, `orion-client-content.post-review.json`; prepare jobs under `storage/digital-profile/orion-golden-prepare-ui/cases/{caseId}/`.

---

## 5. Client content

| Function | File |
|---|---|
| `buildOrionClientContent`, `assembleOrionClientContentFromSections`, … | `orion-golden/content/orion-client-content-builder.ts` |
| `rebuildClientContentForReportRun` | `orion-golden/rebuild-client-content-for-report-run.ts` |
| Relevance | `orion-golden/evidence/relevance-classifier.ts` `classifyInventoryRelevance` |
| Judgments | `orion-golden/evidence/evidence-judgment-builder.ts` |
| Load for render | `loadPostReviewClientContent` in `run-orion-classic-audit-render.ts` |

Content-brain intermediates: `full-evidence-inventory.json`, `relevance-filter-inspection.json`, `evidence-judgment-*.json`.

---

## 6. Composer / deck spec

| Function | File |
|---|---|
| `buildOrionClassicReportSpecFromClientContent` | `classic/orion-classic-client-content-to-report-spec.ts` |
| `buildOrionThemeSet` | `classic/orion-classic-theme-set.ts` |
| `buildOrionClassicAuditAssets` | `classic/orion-classic-asset-builder.ts` |
| `composeOrionFirst36CeoDeck` | `classic/orion-first36-deck-composer.ts` |
| `composeOrionClassicAuditDeck` | `classic/orion-classic-audit-deck-composer.ts` |
| Registry | `classic/orion-first36-registry.v1.ts` |

**Artifacts:** `orion-theme-set.json`, `orion-classic-report-spec.json`, `final-deck-manifest.json`, `report-assets.json`.

---

## 7. PPTX / PDF / PNG renderer

| Step | Path / symbol |
|---|---|
| Enqueue / job | `services/orion-classic-audit-report-service.ts` `enqueueOrionClassicAuditReport`, `executeOrionClassicAuditReportJob` |
| Core | `classic/run-orion-classic-audit-render.ts` `runOrionClassicAuditRender` |
| First36 wrapper | `classic/render-first36-report.ts` |
| TS client | `renderer/orion-golden-render-client.ts` `renderOrionGoldenArtifacts` |
| Python | `scripts/render-orion-golden-artifacts.py` |
| Geometry Python | `scripts/inspect-first36-pptx-geometry.py` |

**Outputs under run `outputRoot`:** `rendered-client.pptx`, `rendered-client.pdf`, `pages-png/`, `contact-sheet.png`.

**UI download aliases:** `orion-classic-audit.pdf` / `.pptx`.

**Classic UI storage root:** `storage/digital-profile/orion-classic-audit-ui/cases/{caseId}/runs/{uiRunId}/`.

**Golden case root:** `ORION_GOLDEN_QA_STORAGE_ROOT` = `storage/digital-profile/qa-r10-orion-golden-parallel/cases/{caseId}/`.

---

## 8. Gates

| Gate | Functions | Artifact(s) |
|---|---|---|
| Acceptance | `inspectFirst36Acceptance` (`classic/first36-acceptance-gate.ts`) | `first36-acceptance.json` |
| Geometry | `generateFirst36GeometryArtifacts`, `geometryReportIsClean` (`classic/generate-first36-geometry-artifacts.ts`) | `geometry-artifacts.json`, `geometry-report.json`, `geometry-finalize-block.json` |
| Client-copy | `inspectClientCopyText`, `inspectClientCopySlides` (`classic/client-copy-completeness.ts`) | `client-copy-report.json` |
| Metric consistency | `inspectCrossSlideMetricConsistency` (`classic/cross-slide-metric-consistency.ts`) | `metric-consistency-report.json`, `cross-slide-metric-report.json` |
| Sidebar / SERP | `inspectSidebarClientPolicy`, `evaluateClassicProviderSerpGate` | `sidebar-client-policy.json`, visual gate errors |
| Binding | `assertArsenkinTransferredClientContent`, `validateClientBindingArtifacts` | `client-content-binding.json`, `arsenkin-render-binding-gate.json` |

Merge/provenance artifacts: `run-scoped-serp-merge.json`, `composite-serp-merge-provenance.json`, `serp-observations-provenance.json`, `surface-coverage.json`, `provider-tasks.json`.

---

## 9. LLM usage points (Golden / Classic path)

| Caller | File | Notes |
|---|---|---|
| HTTP primitive | `orion-golden/gpt/openai-json-client.ts` `callOpenAiStrictJson` | shared |
| Section analysis | `orion-golden/gpt/orion-section-analysis-orchestrator.ts`, `orion-section-analyzer.ts` | prepare/e2e |
| Executive synthesis | `orion-golden/gpt/orion-executive-synthesis-from-sections.ts`, `orion-executive-synthesizer.ts` | prepare/e2e |
| GPT auto-analyst | `orion-golden/evidence/gpt-auto-analyst.ts` | `ORION_GPT_AUTO_ANALYST=1` |
| GPT-5.5 microstage | `orion-section-pipeline/gpt55-microstage-analyzer.ts` | section pipeline |
| Classic render | `run-orion-classic-audit-render.ts` | **reads** `executive-synthesis.output.json`; does **not** call OpenAI |

---

## 10. Destructive replacement / run substitution points

| Point | Behavior |
|---|---|
| `overlayInventoryByCoverageCells` | Enrichment owns covered cells; base SERP in those cells dropped |
| `overlaySurfacePanelAssets` | Same `assetRef` → Arsenkin panel wins (Wikipedia knowledge protected) |
| Missing / stale binding | PDF may render base-only or Arsenkin-skewed without full overlay |
| Acceptance `enrichmentRunIds` under-list | Gate may pass incomplete enrichment vs merge list |
| GPT findings suppress SERP tables | In report-spec builder when `gptFindings.length > 0` |
| Empty-run strip | Mitigated; force only with `ORION_FIRST36_STRIP_EMPTY_RUN=1` |
| Orphan CaseAgent runs | Observations not in `enrichmentRuns` skipped by merge/panels |

---

## 11. Stale / foreign artifact risks

- Post-review client content older than fresh Arsenkin observations (render without rebuild).
- Foreign `effectiveReportRunId` in binding pointing at another case/run.
- Orphan CaseAgent `auditRunId`s (`ORPHAN_CASE_AGENT_OBS` in `report-evidence-provenance.ts`).
- Dual merge systems: unified `mergeCompositeSerp` vs Classic `mergeCompositeSerpObservations` not joined.
- Classic UI `uiRunId = classic-${Date.now()}` — **no sequential “report №N” counter in code**.

---

## 12. Stage table (observed defects)

| Stage | Input | Output | Store | Consumer | Observed defect |
|---|---|---|---|---|---|
| UI full audit | caseId | audit run | DB | base agents | Arsenkin not started here |
| Base Yandex/Serper | queries | SearchResult / SerpObservation | DB | merge | Do not rewrite |
| Arsenkin CaseAgent / full enrich | plan | ProviderTask + observations | DB + case-agent storage | binding | Cell replace can drop base provenance in covered cells |
| Binding + composite merge | base + enrichment | inventory + provenance | merge JSON | content/themes | Dual merge; incomplete enrichmentRunIds in acceptance |
| Golden rebuild / review | inventory | post-review client content | case JSON | composer | Stale content if no rebuild |
| Client content | judgments | OrionClientContent | post-review JSON | report spec | Multiple subject enums; no Stage-1 contracts wired |
| Composer / deck spec | content + themes | deck manifest / spec | JSON | renderer | Top-N theme truncation; analysis mixed with copy |
| Renderer | deck + assets | PPTX/PDF/PNG | output root | gates | Out of redesign scope for Stage 1 |
| Gates | deck + reports | acceptance | gate JSON | ops | Geometry/copy/metrics interactions; binding under-list |

---

## 13. Theme coverage checklist (where signals can be lost)

Checked against Classic ThemeSet / composer (not ORION claim copy):

| Theme | Primary handling | Loss risk |
|---|---|---|
| Politics / Moldova | `political_exposure` in `orion-classic-theme-set.ts` | Soft bio/birthplace demoted to corporate; weak cards dropped |
| Business associations / spouse | `business_associates` | Top-6 theme cap |
| Offshore | `offshore` + compliance enrich | Cap / soft-press filters |
| Corporate ownership | `corporate` | Non-adverse corporate skipped |
| PEP/RCA | `pep_rca` | Cap |
| Criminal / judicial | `criminal_legal` | Soft-press-only discarded |
| Defense / national-security | Forced into `criminal_legal` | Cap / filter |
| OTHER_SUBJECT / namesake | `WRONG_SUBJECT` filters, IMSLP/Mikhail patterns | Surname-only “Глинка” residual leak into KPI |

---

## 14. Report number assignment

No app counter assigns “отчет №72”. Closest IDs:

- Classic UI: `classic-${Date.now()}`
- Arsenkin: `orion-arsenkin-{suggest-canary|first36-full}-{nowMs}-{rand}`
- Deck: sequential `pageNumber` 1..N

External “№72” must be resolved from operator exports / local filenames (see `docs/orion-classic-report-72-baseline.md`).
