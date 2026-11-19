# Sports Equipment Portal — VIT Bhopal Sports Department

Issue, return and stock records for the central sports store. Planned address: **https://sports-eqp-issue.hplvitbhopal.site**

Stack: Next.js (App Router) + TypeScript · PostgreSQL (Neon) · email sign-in codes sent through university Google Workspace mail · hosted on Vercel.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Architecture blueprint | Done |
| 2 | Foundation: database, sign-in, sessions, roles, user admin, audit log, app shell | Done |
| 3 | Inventory: sports, categories, locations, equipment codes, stock ledger, receipts, search, Excel import | Done |
| 4 | Requests & issue: browse & request, Approve & hand over, rejection, issue emails with retry | Done |
| 5 | Returns & damage: full-return reconciliation, damaged / missing / used-up records, photos, return and overdue emails | Done |
| 6 | Corrections & discards: FR-approved discards, physical stock counts, corrections, receipt reversal | Done |
| 7 | Dashboard & reports: role dashboards, seven registers, Excel / PDF / print | Done |
| 8 | Production hardening, page checks, deployment runbook, backups, user guide | **This release (1.0.0-rc.1)** — deployment itself is done by you, see docs/DEPLOYMENT.md |

## Project layout

```
db/migrations/          SQL migrations (numbered, never edited once applied)
scripts/                migrate, create-admin, purge
src/server/             all business logic, framework-independent and tested
  auth/                 otp (sign-in codes), sessions, permissions (role matrix), accounts (profile + user admin)
  inventory/            ledger (the only code that changes stock), items, masterdata, import, spreadsheet (.xlsx/.csv)
  requests/             catalog, requests, approve & hand over, rejection, cancel, ready flag
  notify/               email outbox (queue, dispatch, retry) and email templates
  returns/              full returns, damage / missing incidents and their resolution, overdue reminders
  adjustments/          discards, corrections, physical stock counts, reversal of mistaken receipts
  db/                   Db interface, node-postgres adapter, migration runner
  email/                mailer interface, Google Workspace SMTP mailer, templates
  http/handlers.ts      API handlers (standard Request -> Response), CSRF + cookie handling
  runtime.ts            production wiring (config + pg + SMTP)
src/app/                Next.js pages and API routes (thin: they call src/server)
tests/                  integration tests against a real PostgreSQL database
```

## Run locally

Requirements: Node 20.9+ (22 recommended), PostgreSQL 15+.

```bash
npm install
cp .env.example .env.local          # then edit DATABASE_URL and OTP_HMAC_SECRET
createdb sports_eqp
npm run db:migrate
npm run admin:create -- your.name@vitbhopal.ac.in "Your Name"
npm run dev                         # http://localhost:3000
```

With `MAIL_TRANSPORT=console`, sign-in codes are printed in the terminal instead of emailed.

## Tests

```bash
# needs a PostgreSQL server where the user may CREATE DATABASE
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
npm run typecheck
```

Each test file creates its own temporary database, applies all migrations and drops it afterwards.

## Production setup (Vercel + Neon + Google Workspace)

1. **Neon**: create a project (region: Singapore or Mumbai if offered). Copy the *pooled* connection string to `DATABASE_URL` and the direct one to `DATABASE_URL_UNPOOLED`.
2. **Google Workspace admin** (university IT): create `sports-store@vitbhopal.ac.in`; either enable the SMTP relay service for it with SMTP authentication (preferred: host `smtp-relay.gmail.com`), or create an app password for it (host `smtp.gmail.com`). Port 587.
3. **Vercel**: import the GitHub repository; set environment variables from `.env.example` with `NODE_ENV` left to Vercel, `APP_ORIGIN=https://sports-eqp-issue.hplvitbhopal.site`, `MAIL_TRANSPORT=smtp`, and a random `CRON_SECRET`.
4. **Migrate and create the first administrator** from your computer, pointing at the production database:
   `DATABASE_URL=<direct Neon URL> npm run db:migrate` then `npm run admin:create -- name@vitbhopal.ac.in "Full Name"`.
5. **Email retries**: in GitHub > Settings > Secrets and variables > Actions add `APP_URL` (the portal address) and `CRON_SECRET`
   (same value as in Vercel). `.github/workflows/email-retry.yml` then sends queued emails every 15 minutes.
6. **Domain**: in Vercel > Domains add `sports-eqp-issue.hplvitbhopal.site`; at your DNS provider for hplvitbhopal.site add the CNAME record Vercel shows.

Never put real secrets in the repository. `.env*` files are git-ignored.

## Security model (Phase 2)

- Sign-in: 6-digit code to a `@vitbhopal.ac.in` address; stored only as an HMAC; 10-minute expiry; 5 attempts; 60-second resend cooldown; 5 codes per email and 20 per network per hour.
- Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie; only its SHA-256 is stored; 12 idle hours for staff, 7 idle days for recipients, 30 days absolute; deactivation ends all sessions.
- Authorization: one permission matrix (`src/server/auth/permissions.ts`) checked on the server for every API call and page.
- CSRF: every state-changing request must carry this site's `Origin`.
- First sign-in creates a Recipient; only FR Sports grants roles; at least one active FR Sports user always remains; nobody changes their own role.
- Registration / employee number is set once by the user, then only FR Sports can change it.
- Audit log is append-only, enforced by a database trigger.

## Inventory rules (Phase 3)

- Every stock change goes through `src/server/inventory/ledger.ts`: it locks the item's balance row, refuses to go below zero,
  updates the balance and appends a `stock_movements` row with before/after values, all in one transaction.
- The database also refuses negative balances (CHECK constraints) and any edit or deletion of movement history (trigger).
- `stock_ledger_mismatches` (a database view) recomputes every balance from the movement history; the daily job reports any
  mismatch. Tests assert it is always empty.
- Item codes are `SPORT-CATEGORY-NNNN` (e.g. `CRI-BAL-0001`), numbered per category; sport, category and code never change.
- Duplicate equipment definitions (same category, name, brand, model, size, ignoring case) are refused.
- Forms send a one-time request key, so a double click or retry records stock once.
- Excel import: download template → upload → preview (nothing changes) → confirm. All rows import or none do; the import is
  re-checked at confirmation and refused if records changed since the preview; previews expire after 30 minutes.

## Requests and issuing (Phase 4)

- A request never moves stock. **Approve & hand over** is one transaction: it locks the request (a second officer waits and is
  then told it was already processed), re-checks every line's availability, moves Available → Issued, creates the issue
  record (`ISS-YYYY-NNNNNN`) and queues the emails. If any line is short, nothing is issued.
- Only FR Sports and the Assistant Sports Officer approve; nobody approves their own request. The person physically handing over
  (FR Sports, ASO or a storekeeper) is recorded separately from the approver.
- Overdue is calculated from today's date (IST) whenever a page loads; no stored flag can go stale.
- Emails go through a database outbox written in the same transaction, are sent right after, retried after 1, 5, 15, 60 and
  240 minutes, and shown to FR Sports under Email delivery if they still fail. Stock records never depend on email.

## Returns and damage (Phase 5)

- **Full returns only.** Every issued unit is recorded as usable, damaged, missing or (consumable items only) used up; the totals
  must match what was issued or nothing is recorded. A note is required for missing or used-up units. One transaction moves stock
  out of Issued, opens incidents, closes the issue and queues the return emails. A second return of the same issue is refused.
- **Damaged** units sit in Damaged and cannot be issued until FR Sports or the ASO marks them usable. **Missing** units can be
  recorded as found (usable or damaged). **Used-up** units wait for an FR Sports discard (Phase 6). No penalties are calculated.
- Damage found in the store (not on issue) moves units from Available to Damaged.
- **Photos** are compressed in the browser (~300 KB), checked by file signature on the server, stored in PostgreSQL and visible
  only to staff. Unattached uploads are removed after a day.
- **Daily job** (`/api/cron/daily`, Vercel Cron 09:00 IST): overdue reminders, housekeeping, photo clean-up and the ledger check.
  Reminders follow the schedule FR Sports sets under Email delivery (default: 1 day late, then every 3 days, 4 at most; the last is
  copied to the issuing staff member).

## Corrections and discards (Phase 6)

- **Discards:** the ASO or a storekeeper requests; FR Sports approves or rejects (with a reason). Pending units are held: they
  cannot be issued, marked usable or recovered. Equipment on issue can never be discarded. Used-up consumables raise a discard
  request automatically at return. Item records and history are never deleted.
- **Corrections:** expected vs counted is stored as a difference and applied on FR Sports approval, so issues and returns made in
  between are not lost. A correction that would take stock below zero is refused with nothing changed.
- **Stock counts:** count usable and damaged units on the shelf by sport, category, location or whole store; issued and missing
  units are shown but never treated as shortages. Submitting turns differences into corrections and keeps a verification report.
- **Reversal:** FR Sports can undo a receipt or opening stock entered by mistake, once, with a reason; the original stays in history.
- Nobody approves their own discard or correction.

## Dashboard and reports (Phase 7)

- **Dashboard** (all staff and management): available / issued / damaged / missing totals, overdue issues, pending requests,
  low stock, recent issues and returns, sport-wise and location-wise stock. "Needs your action" lists only what the signed-in
  role can act on; management sees figures only.
- **Reports:** stock register, issue and return register, damage and missing register, stock verification, discards,
  corrections, stock received. Each has date / sport / category / status / search filters, shows up to 500 rows on screen and
  downloads all rows (up to 20,000) as **Excel** (numbers stored as numbers, totals row) or **PDF** (A4 landscape, header on
  every page), or prints from the browser. Every download is recorded in the audit log.
- Who sees which report: Procurement — stock register and stock received; Storekeeper — stock, issues, damage, counts;
  FR Sports, ASO and Management — all seven. Recipients see none.

## Going live (Phase 8)

- **docs/DEPLOYMENT.md**: step-by-step setup on GitHub, Neon, Vercel, Google Workspace mail and your DNS, plus operations
  (monitoring, updates, rollback, secret rotation, backups and restore).
- **docs/UAT-CHECKLIST.md**: 28 acceptance checks to run on the live site before announcing it.
- `npm run preflight`: checks production settings, database, schema, administrator, mail sign-in (and sends a test email
  with `--send-test you@vitbhopal.ac.in`) and the live health check. `/api/health` is for uptime monitors.
- `npm run typecheck:pages` and `npm run check:pages`: type-check every page, render every page for every role against a
  seeded database, record who can open what (`docs/page-access-matrix.json`) and run accessibility checks. These use
  small stand-ins for React and Next.js (`tools/preview/`) and are a development check only; `npm run build` is the real
  compile, done in CI.
- Optional nightly encrypted database backup: `.github/workflows/backup.yml` (off until its secrets are set).
