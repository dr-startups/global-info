# Optional remediation steps 2.4 & 3.3 (+ 5.3 status)

Offline-capable GPT helpers behind env flags. **Default off** — do not enable on Railway unless explicitly opted in.

## §2.4 — LLM disambiguation of `AMBIGUOUS` (`ORION_GPT_IDENTITY`)

| | |
|---|---|
| Flag | `ORION_GPT_IDENTITY=1` |
| Default | off (`false`) |
| Module | `src/modules/digital-profile/orion-golden/gpt/gpt-identity-resolver.ts` |
| Wire-in | `run-analytics-pipeline.ts` after analyst overrides, before surfaces/findings |
| Artifact | `{artifactsDir}/gpt-identity-resolution.json` (under analytics dir when prepare writes there) |

Behavior:

- Batches ~20 AMBIGUOUS materials; prompt includes subject profile + namesakes.
- Model returns `{ref, decision: LIKELY\|AMBIGUOUS\|OTHER, reason}`.
- Code clamps so results can only become `LIKELY_SUBJECT` or `OTHER_SUBJECT` — **never** `SUBJECT_MATCH`.
- Fail-safe: transport/schema errors leave materials `AMBIGUOUS`.
- Uses GPT call queue from §4.2.

## §3.3 — LLM theme suggestion (`ORION_GPT_THEMES`)

| | |
|---|---|
| Flag | `ORION_GPT_THEMES=1` |
| Default | off (`false`) |
| Module | `src/modules/digital-profile/orion-golden/gpt/gpt-theme-suggester.ts` |
| Wire-in | `run-analytics-pipeline.ts` after finding synthesis |
| Artifact | `{artifactsDir}/gpt-theme-suggestion.json` |

Behavior:

- Model receives uncategorized `SUBJECT_MATCH` / `LIKELY_SUBJECT` materials (§3.2).
- Proposes `{themeLabel, keywords[], evidenceRefs[]}`.
- Deterministic verification: each accepted keyword appears in ≥2 materials; refs exist; label does not duplicate configured themes.
- Accepted → findings with `origin: "llm-suggested"`, confidence ≤ 0.45, `subjectMatch: LIKELY_SUBJECT` (matrix «Требует подтверждения», not KPI).
- Fail-safe: invalid / errors → no findings added.

## §5.3 — Real screenshots preferred over synthetic

**Already satisfied** (no new code in this change):

- Selection rule in `canonical-visual-assets.ts`: `pickRealSerpScreenshot` for p10 (RU) / p27 (UAE); fresh LIVE/fixture wins over synthetic.
- Offline assertion: `scripts/smoke-evidence-supplement.ts` → `buildCanonicalVisualAssets prefers real screenshot for p10`.

## Config

Flags are also mirrored on `digitalProfileConfig.orionGptIdentity` / `orionGptThemes` (both default `false`). See `.env.example` comments.
