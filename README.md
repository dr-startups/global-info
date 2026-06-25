# Global Info

Full-stack platform (Next.js + TypeScript + Prisma + PostgreSQL).

## Modules

### Digital Profile Audit (`src/modules/digital-profile`)

Evidence-first system that produces a corporate compliance-style PDF report about a
person's digital profile. The module is **isolated behind a feature flag** and ships
in stages — see `src/modules/digital-profile/README.md`.

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
npm run db:seed

# 4. Run the app
npm run dev
```

## Useful scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start Next.js dev server |
| `npm run typecheck` | TypeScript type checking |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:seed` | Insert sample data (one subject) |
| `npm run db:studio` | Open Prisma Studio |
