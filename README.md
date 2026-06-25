# Global Info

Full-stack platform (Next.js + TypeScript + Prisma + PostgreSQL).

## Modules

### Digital Profile Audit (`src/modules/digital-profile`)

Evidence-first system that produces a corporate compliance-style PDF report about a
person's digital profile. The module is **isolated behind a feature flag** and ships
in stages — see `src/modules/digital-profile/README.md`.

Full module documentation lives in [`docs/digital-profile/`](docs/digital-profile/README.md):
[Architecture](docs/digital-profile/ARCHITECTURE.md) ·
[Deployment](docs/digital-profile/DEPLOYMENT.md) ·
[QA](docs/digital-profile/QA.md) ·
[Final QA checklist](docs/digital-profile/FINAL_QA.md) ·
[Security & privacy](docs/digital-profile/SECURITY.md).

Core principles:

- **Evidence-first.** Every statement in a report must reference evidence: a URL,
  a screenshot, an imported file, or a database record.
- **LLM is not a source of truth.** The LLM may only classify, summarize and draft
  text based on existing evidence.
- **Lawful only.** Compliance databases (LexisNexis, Dow Jones, World-Check) are
  integrated strictly via official API connectors or manual import. No leaked or
  illegal datasets. No automated Wikipedia publishing.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env   # then edit DATABASE_URL etc.

# 3. Set up the database
npm run db:generate
npm run db:migrate
npm run db:seed          # 3 demo cases

# 4. Start the report renderer (Docker)
docker compose up -d --build renderer

# 5. Run the app
npm run dev
# open http://localhost:3000/admin/digital-profile
```

## Useful scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start Next.js dev server |
| `npm run typecheck` | TypeScript type checking |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:seed` | Insert 3 demo cases |
| `npm run db:studio` | Open Prisma Studio |
| `npm run smoke:all` | typecheck + build + full smoke suite (needs dev server + renderer) |
| `npm run smoke:all:with-renderer` | builds/starts the Docker renderer, then `smoke:all` |
