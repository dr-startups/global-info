# Digital Profile Audit — Module Docs

Evidence-first system that produces a corporate compliance-style **PDF/PPTX report**
about a person's digital profile. The module is **isolated behind a feature flag**
(`DIGITAL_PROFILE_ENABLED`) and was built in stages (A–K4).

> All report statements must reference verifiable evidence (URL, screenshot,
> imported record, database record). The LLM is **not** a source of fact, and no
> scraping / browser automation / leaked datasets are used.

## Documents

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Modules, data flow, renderer, templates |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Services, env, health checks, limitations |
| [QA.md](./QA.md) | Smoke tests + how to run them |
| [FINAL_QA.md](./FINAL_QA.md) | Step-by-step demo/acceptance checklist |
| [SECURITY.md](./SECURITY.md) | Privacy & security checklist |

## Quick start (local)

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   set DIGITAL_PROFILE_ENABLED="true"
#   set DATABASE_URL to your Postgres

# 3. Database
npm run db:generate
npm run db:migrate
npm run db:seed          # creates 3 demo cases

# 4. Renderer (PPTX/PDF microservice; needs Docker)
docker compose up -d --build renderer
curl http://localhost:8080/health

# 5. App
npm run dev
# open http://localhost:3000/admin/digital-profile
```

## Generate a report (demo)

1. Open `/admin/digital-profile` and open the **rich mock** demo case
   (`DPA-2026-0001`).
2. Run **Mock full audit** → **Mock Search Surfaces** → **Risk Classifier** →
   **Build Audit Summary**.
3. In **Report Preview** choose **Template v3**, Audience **Internal**, Watermark
   **Draft**, then **Generate report**.
4. Download the **PPTX** / **PDF**.
5. Re-generate with Audience **Client** and Watermark **None** to see the
   client-facing variant.

## Report templates

| Version | Description |
| --- | --- |
| `simple` | Generic page-per-slide renderer (fallback) |
| `report-template-v1` | Corporate audit template |
| `report-template-v2` | Full 36-page dynamic audit |
| `report-template-v3` | Polished audit + final commercial block (~50 slides) |

Render requests also accept `audience` (`internal` \| `client`) and
`watermarkMode` (`draft` \| `none`) — these only affect v3. v1/v2/simple always
remain available as fallbacks.

## Connectors (real, safe)

- **Wikipedia** — public MediaWiki/REST API (no key). Independent flag
  `DIGITAL_PROFILE_WIKIPEDIA_ENABLED` (default `true`).
- **Google / Yandex** — official SERP APIs only. Require the master switch
  `DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED=true` **and** their own flags **and**
  API keys. Without keys they resolve to `NOT_CONFIGURED` (never a fake call).
- **Compliance DBs** (LexisNexis / Dow Jones / World-Check) — official API or
  **manual import** only.

## Limitations (by design)

- No automatic SERP screenshots, no browser automation, no scraping.
- No LLM-generated facts (classification/summaries only, evidence-backed).
- Compliance screening is manual import until official API contracts exist.
- Report branding is a neutral "Digital Profile Audit" brand (no third-party
  logos/brands).
