# Digital Profile Audit module

Evidence-first system that produces a corporate compliance-style report (PDF via
PPTX template) about a person's digital profile.

> **Status: Stage A** — DB schema + core types + empty (feature-flagged) module.
> No routes, UI, agents or renderer are wired yet.

## Principles (non-negotiable)

- **Evidence-first.** Every report statement, risk finding and profile references
  `EvidenceRef` (URL / screenshot / imported file / database record).
- **LLM ≠ source of fact.** The LLM only classifies, summarizes and drafts text
  from existing evidence. AI output carries a disclaimer and evidence refs.
- **Lawful only.** Compliance databases (LexisNexis, Dow Jones, World-Check) are
  integrated only via official API connectors or manual import. No leaked/illegal
  datasets. No automated Wikipedia publishing.
- **Isolation.** Everything is behind the `DIGITAL_PROFILE_ENABLED` feature flag,
  under `dp_*` tables, `/api/digital-profile/*` routes and `/admin/digital-profile` UI.

## Layout

```
src/modules/digital-profile/
  types.ts     # Core domain types + Agent interface + ReportJson
  config.ts    # Feature flag, storage/signed-url config, pricing catalog
  index.ts     # Public barrel
  README.md    # This file
prisma/
  schema.prisma  # 12 dp_* tables + enums
  seed.ts        # Sample data for one subject
```

## Data model (12 tables, all `dp_` prefixed)

`cases`, `subjects`, `agent_runs`, `search_queries`, `search_results`,
`screenshots`, `risk_findings`, `database_profiles`, `wikipedia_checks`,
`ai_profiles`, `report_versions`, `audit_logs`.

## Evidence-first pipeline (target)

create case → add subject → generate queries → run collectors → save raw evidence
→ normalize → deduplicate URLs → classify → create risk findings → **human review**
→ build `report_json` → render PPTX/PDF → save report version.

## Planned API (Stage B+)

| Method | Path |
| --- | --- |
| POST | `/api/digital-profile/cases` |
| GET  | `/api/digital-profile/cases` |
| GET  | `/api/digital-profile/cases/:id` |
| POST | `/api/digital-profile/cases/:id/run` |
| POST | `/api/digital-profile/cases/:id/agents/:agentName/run` |
| POST | `/api/digital-profile/cases/:id/report/generate` |
| GET  | `/api/digital-profile/cases/:id/report` |
| POST | `/api/digital-profile/findings/:id/review` |

## Security & compliance (target)

Role-based access · audit log of all actions · private storage for screenshots and
reports · signed URLs · no evidence deletion without explicit admin action ·
`lawfulBasis` / `consentStatus` on each case · "DRAFT" watermark until final review.
