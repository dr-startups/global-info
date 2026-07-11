# First36 v57 Phase 0 — Baseline

- Branch: `feature/ceo-first36-client-sidebar-v57` (from `f35863b`, orient `1665154`)
- Baseline PDF: `orion-classic-audit (56).pdf`
- Artifacts dir: `storage/digital-profile/qa-first36-v57-baseline/`
- Confirmed: **36 pages**, aspect **16:10** (921.6 × 576 pt)
- Contact sheets: `contact-sheet-01-12.png`, `contact-sheet-13-24.png`, `contact-sheet-25-36.png`
- Case data unchanged; no fake/demo evidence added

## Generation command

```bash
ORION_FIRST36_CEO_MODE=1 ORION_GOLDEN_FORCE_LOCAL_RENDER=1 npx tsx scripts/recompose-first36-v55-checkpoint.ts
```

Source: `storage/digital-profile/qa-first36-live-render/cmreamy2t0002o30f29urzcog/1783723714287`

Live: `npm run render:first36-live`
