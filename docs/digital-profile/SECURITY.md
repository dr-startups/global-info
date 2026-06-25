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

## Authentication, roles & access control (Stage M1)

Auth is gated by `DIGITAL_PROFILE_AUTH_ENABLED` (default **false**).

- **Disabled (local demo / smoke):** every request is treated as a synthetic
  `SUPER_ADMIN`; the existing demo flow and smoke tests are unchanged.
- **Enabled:** API routes require a valid session; page routes redirect to the
  login page; roles and per-case access are enforced.

Mechanism (minimal, dependency-free):

- [x] Passwords are stored as **scrypt** hashes only (`auth/password.ts`). No
      plaintext is ever stored or logged.
- [x] Sessions are **stateless HMAC-signed cookies** (`dp_session`, httpOnly,
      sameSite=lax, secure in production) signed with
      `DIGITAL_PROFILE_SESSION_SECRET` (Web Crypto, also used by middleware).
- [x] **Fail-closed:** with auth enabled in `production`, a missing/default/weak
      session secret aborts startup (`auth/auth-config.ts`).
- [x] Session tokens / passwords / secrets are **never logged**.

Roles & permissions (`auth/roles.ts`):

| Action | SUPER_ADMIN | ADMIN | ANALYST | REVIEWER | CLIENT_VIEWER |
| --- | --- | --- | --- | --- | --- |
| Manage users / view audit logs | ✓ | | | | |
| List / view cases | ✓ | ✓ | ✓ | ✓ | assigned only |
| Create / update case | ✓ | ✓ | ✓ | | |
| Delete / soft-delete | ✓ | ✓ | | | |
| Add evidence | ✓ | ✓ | ✓ | | |
| View **raw** evidence | ✓ | ✓ | ✓ | ✓ | |
| Run agents | ✓ | ✓ | ✓ | | |
| Run **real** providers | ✓ | ✓ | | | |
| Classify risks | ✓ | ✓ | ✓ | | |
| Review / dismiss findings | ✓ | ✓ | | ✓ | |
| Generate internal report | ✓ | ✓ | ✓ | ✓ | |
| Generate client report | ✓ | ✓ | | ✓ | |
| Download internal report | ✓ | ✓ | ✓ | ✓ | |
| Download client report | ✓ | ✓ | | ✓ | assigned only |

Case access (`dp_case_access`): staff roles have **global** access; `CLIENT_VIEWER`
sees only cases with an explicit grant (`OWNER`/`EDITOR`/`REVIEWER`/`VIEWER`).

- [x] **Signed downloads never bypass authorization.** When auth is enabled, the
      download routes validate the signed token **and** the user's role + case
      access. `CLIENT_VIEWER` can never download internal/draft (watermarked)
      reports or any raw evidence/screenshot — even with a valid token.
- [x] Auth events are audit-logged with `actorId`: `LOGIN`, `LOGIN_FAILED`,
      `LOGOUT`, plus the existing case/evidence/report/download actions.

## Demo users (DEMO-ONLY — never use in production)

`npm run db:seed` creates four demo users (override the admin via
`DIGITAL_PROFILE_DEMO_ADMIN_EMAIL` / `DIGITAL_PROFILE_DEMO_ADMIN_PASSWORD`):

| Email | Role | Password (demo-only) |
| --- | --- | --- |
| `superadmin@demo.local` | SUPER_ADMIN | `demo-Admin-12345` |
| `analyst@demo.local` | ANALYST | `demo-Analyst-12345` |
| `reviewer@demo.local` | REVIEWER | `demo-Reviewer-12345` |
| `client@demo.local` | CLIENT_VIEWER | `demo-Client-12345` |

`client@demo.local` is granted `VIEWER` access to **one** case
(`DPA-2026-0001`) only. Rotate/remove all demo credentials before any real use.
