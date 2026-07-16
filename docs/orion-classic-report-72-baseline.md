# ORION Classic — Report №72 baseline (Stage 1)

## Status

**PARTIAL_BASELINE** — PDF artifact characterized; run-level JSON/PPTX gates remain blockers.

Source PDF: [`baselines/report-72/artifacts/orion-classic-audit-v72.pdf`](../baselines/report-72/artifacts/orion-classic-audit-v72.pdf)  
(copied from `Downloads/orion-classic-audit (72).pdf`)

Note: repo `.gitignore` has `*.pdf`, so the binary may not be committed; SHA-256 in `baseline.json` is the durable fingerprint.

Machine record: [`baselines/report-72/baseline.json`](../baselines/report-72/baseline.json)

## Immutable PDF facts (MEASURED)

| Field | Value | Status |
|---|---|---|
| page count | 43 | MEASURED |
| page size | 921.6 × 576 pt (media box 921.5999…×576) | MEASURED |
| SHA-256 | `78adc2e3708feb551521b2ac6b75958947d46e241f6f5162a7e6c65e343d7091` | MEASURED |
| bytes | 2 045 174 | MEASURED |
| subject (cover) | Глинка Сергей Михайлович | MEASURED |

## Page inventory — base vs continuations (DERIVED)

Compared to [`orion-first36-registry.v1.ts`](../src/modules/digital-profile/orion-golden/classic/orion-first36-registry.v1.ts) (`FIRST36_EXACT_PAGE_COUNT = 36`):

| Class | Count | Pages |
|---|---|---|
| Registry-mapped **base** slots | 36 | All registry `slotId`s title-matched in PDF (see `baseline.json` → `pageInventory`) |
| **Dynamic inserts** (not in registry) | 3 | 20 (RU AI Yandex), 21 (RU Google AI Overview), 34 (UAE Google AI Overview 1/5) |
| Explicit **continuations** `(n/m)` | 4 | 35–38 (UAE Google AI Overview 2/5–5/5) |
| Total | 43 | 36 + 7 beyond registry |

Note: after AI inserts, PDF page numbers no longer equal registry `page` indices.

## Provider / dataset counts (MEASURED from visible PDF text)

Provider **mention** counts in PDF text (not DB observation rows):

| Provider | Mentions |
|---|---|
| Google | 25 |
| Arsenkin | 14 |
| Википедия | 12 |
| Яндекс | 9 |
| Wikipedia | 7 |
| LexisNexis / Lexis | 7 |
| Dow Jones | 5 |
| World-Check | 2 |
| Yandex (Latin) | 2 |
| Serper | 0 |

Dataset / organic denominators visible on slides:

| Metric | Value | Source pages |
|---|---|---|
| RU adverse links | 14 / 158 (9%) | 3, 5, 7 |
| UAE adverse links | 11 / 97 (11%) | 3, 5, 26, 27 |
| RU SERP table | 3 / 18 adverse | 9 |
| UAE SERP table | 4 / 18 adverse | 28 |
| RU suggestions KPI | 0 / 18 | 5, 7 |
| RU related KPI | 1 / 10 | 5, 7 |
| RU images KPI | 8 / 38 | 7 |
| UAE suggestions KPI | «Нет данных» | 5, 26, 27 |
| UAE related KPI | 0 / 1 | 5, 26, 27 |
| UAE images KPI | 4 / 45 | 26, 27 |
| RU related cards | 4 + 4 + 2 queries | 22–24 |

`observationRowCountsFromDb` = **UNAVAILABLE** (no merge/provenance JSON).

## Gates

| Gate | Status | Result |
|---|---|---|
| Geometry | **UNAVAILABLE** | Needs `rendered-client.pptx` + `geometry-artifacts.json` |
| Client-copy | **MEASURED** (offline PDF text via `inspectClientCopyText`) | 3 issues: wiki pages 13/31 (`сверить сверка личности`); page 39 `NOT_COLLECTED` |
| Acceptance | **UNAVAILABLE** | Needs `first36-acceptance.json` |
| Metric consistency | **DERIVED** (partial) | 14/158↔9% and 11/97↔11% OK; TOC repeats `(43 стр.)` on every entry |

## Missing run artifacts (blockers)

Exact names that cannot be reconstructed from the PDF alone:

- `final-deck-manifest.json`
- `orion-theme-set.json`
- `orion-classic-report-spec.json`
- `report-assets.json`
- `first36-acceptance.json`
- `geometry-artifacts.json`
- `geometry-report.json`
- `client-copy-report.json`
- `metric-consistency-report.json`
- `cross-slide-metric-report.json`
- `arsenkin-report-binding.json`
- `client-content-binding.json`
- `run-scoped-serp-merge.json`
- `composite-serp-merge-provenance.json`
- `serp-observations-provenance.json`
- `rendered-client.pptx`
- `pages-png/`
- `contact-sheet.png`

Also unavailable: DB `caseId`, `canonicalBaseReportRunId`, complete `enrichmentRunIds`.

## Field status policy

Every baseline field uses `MEASURED` | `DERIVED` | `UNAVAILABLE`.  
There is **no** blanket `ARTIFACTS_MISSING` overall state; overall is `PARTIAL_BASELINE`.

## Rebuild (offline)

```bash
python baselines/report-72/extract-v72-pdf.py
NETWORK_CALLS=0 npx tsx baselines/report-72/build-baseline-from-pdf.ts
NETWORK_CALLS=0 npm run smoke:orion-stage1-contracts
```

## Architecture manifest

[`baselines/report-72/architecture-manifest.json`](../baselines/report-72/architecture-manifest.json) — updated with PDF fingerprint; binding/run IDs still null pending missing JSON artifacts.
