# File split §9.5 — giant module decomposition

Mechanical refactor only (REMEDIATION_PLAN §9.5). Public export names and runtime behavior unchanged; old paths remain as thin re-export shims.

## New paths

### Fragment builders

| Path | Role |
|------|------|
| `src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/` | Section builders directory |
| `…/fragment-builders/shared.ts` | Shared types + cross-builder helpers |
| `…/fragment-builders/front-matter.ts` | `buildFrontMatterFragment` |
| `…/fragment-builders/executive.ts` | Executive / risk / overview + freshness helpers |
| `…/fragment-builders/regional-summary.ts` | Regional summary |
| `…/fragment-builders/serp.ts` | SERP table + screenshot |
| `…/fragment-builders/suggestions.ts` | Suggestions |
| `…/fragment-builders/images.ts` | Images |
| `…/fragment-builders/identity.ts` | Identity / Wikipedia |
| `…/fragment-builders/knowledge-ai.ts` | Knowledge / AI |
| `…/fragment-builders/related.ts` | Related queries |
| `…/fragment-builders/compliance.ts` | Compliance |
| `…/fragment-builders/appendix.ts` | Appendix |
| `…/fragment-builders/index.ts` | Public API barrel |
| `…/fragment-builders.ts` | **Shim** → `./fragment-builders/index` |

### Arsenkin UI orchestration

| Path | Role |
|------|------|
| `src/modules/digital-profile/services/arsenkin-ui-orchestration/` | Layer directory |
| `…/types.ts` | DTO / deps types |
| `…/shared.ts` | Mapping, readiness, recovery, matrix helpers |
| `…/poll.ts` | Status / readiness refresh |
| `…/submit.ts` | Prepare / plan / execute |
| `…/ingest.ts` | Sync results to ORION |
| `…/dto.ts` | Public DTO helpers |
| `…/index.ts` | Public API barrel |
| `…/arsenkin-ui-orchestration-service.ts` | **Shim** → `./arsenkin-ui-orchestration/index` |

### Arsenkin case-agent execution

| Path | Role |
|------|------|
| `src/modules/digital-profile/services/arsenkin-case-agent-execution/` | Layer directory |
| `…/shared.ts` | Types, persistence, plan, outcome helpers |
| `…/submit.ts` | Start / worker / resume |
| `…/ingest.ts` | Finalize / tick |
| `…/index.ts` | Public API barrel |
| `…/arsenkin-case-agent-execution.ts` | **Shim** → `./arsenkin-case-agent-execution/index` |

### ORION Golden Python renderer

| Path | Role |
|------|------|
| `renderer/orion_golden_render/` | Package |
| `…/common.py` | Theme, fonts, layout telemetry, `_Ctx`, image helpers |
| `…/visual.py` | Sidebar, KPI, search table, visual+sidebar |
| `…/executive.py` | Executive dashboard / risk / profile templates |
| `…/slides.py` | `_render_slide` dispatch |
| `…/export.py` | PDF fallback + PNG pages |
| `…/api.py` | `render_orion_golden` entrypoint |
| `…/__init__.py` | Public re-exports |
| `renderer/orion_golden_renderer.py` | **Shim** → `orion_golden_render` |

## Verification

- `npm run typecheck`
- `npm test`
- `NETWORK_CALLS=0 npm run ci:smokes`
- `python -m py_compile` on shim + package modules
