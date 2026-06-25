# Security & Privacy Checklist

The Digital Profile Audit module is **evidence-first** and **lawful-only** by
design. This checklist captures the guarantees and the operational rules.

## Data handling

- [x] Raw evidence (screenshots, `report_json`, PPTX/PDF) is stored in **private
      storage** only — never exposed as a public URL.
- [x] Downloads are served exclusively via **signed URLs** with a configurable
      TTL (`storage/signed-url.ts`). Tampered/expired tokens return `404`.
- [x] Raw provider payloads (`rawMetadata` / `rawPayload`) are stored for
      provenance but **never rendered raw** into reports.
- [x] Evidence is **soft-deleted** (never hard-deleted without an explicit admin
      action).

## Secrets & logging

- [x] `.env` is git-ignored; only `.env.example` (no real values) is committed.
- [x] Signing secret and API keys are read from env; **never logged**.
- [x] Signed-URL tokens are **never logged**.
- [x] Errors return a safe envelope `{ ok:false, error:{ code, message } }` —
      **no stack traces** are exposed to clients (`http/errors.ts`).
- [x] Production must set a strong unique `DIGITAL_PROFILE_SIGNED_URL_SECRET`.

## Lawfulness (hard rules)

- [x] **No scraping** and **no browser automation**.
- [x] **No SERP screenshots** captured by automation (synthetic snapshots are
      generated from API data and clearly labelled, not live screenshots).
- [x] **No captcha bypass**.
- [x] **No leaked / illegally obtained datasets.**
- [x] Compliance databases (LexisNexis / Dow Jones / World-Check) integrated via
      **official API or manual import only**.
- [x] Google/Yandex via **official APIs only**; missing keys → `NOT_CONFIGURED`
      (never a fake call).
- [x] Wikipedia via the **public** MediaWiki/REST API; read-only, never
      auto-publishes.

## LLM policy

- [x] The LLM is **not a source of fact**. It may only classify/summarise/draft
      text from existing evidence. (Current classifier is fully deterministic and
      uses **no** LLM.)

## Demo data

- [x] All demo/seed subjects are **fictional** — no real persons, no real
      identifiers, no real compliance records.
- [x] Demo/mock evidence is flagged (`demo` boolean, `source = "mock:*"`, `[DEMO]`
      title prefixes) so it is never mistaken for verified evidence.

## Review-first

- [x] Risk findings are created as `PENDING` and require manual review.
- [x] Reports carry a `DRAFT` watermark by default until final review.
