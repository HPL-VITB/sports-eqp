# Phase 2 report — Foundation (16 Nov 2026)

## 1. Implemented

- Project structure, configuration validation, `.env.example`, README with local and production setup, CI workflow.
- Database migration `0001_foundation`: users, sign-in codes, sessions, rate limits, append-only audit log, settings. Migration runner
  (refuses edited migrations) and `admin:create` bootstrap script for the first FR Sports user.
- Email sign-in for `@vitbhopal.ac.in` only, with hashed codes, expiry, attempt limit, resend cooldown and rate limits.
- Database sessions in a secure cookie, with role-based idle timeouts and a 30-day absolute limit.
- One server-side permission matrix for all six roles (blueprint Section E), plus role-based navigation.
- Profile completion (registration/employee number locked after first save), user administration for FR Sports (grant roles,
  deactivate/reactivate, correct registration numbers), protection of the last FR Sports user, audit entries for every change.
- CSRF origin checks on all state-changing API calls; security headers; daily housekeeping job.
- Next.js pages: sign-in, profile, app shell with role menu, dashboard, users & roles, audit log, 403 page, and placeholders for
  Phase 3–7 screens.
- Google Workspace SMTP mailer (relay or app password).

## 2. Tested

36 automated tests against a real PostgreSQL 16 database (`docs/test-results-phase2.txt`): migrations, database constraints,
append-only audit log, the full permission matrix, sign-in flow and every OTP rule, session timeouts, logout, deactivation,
profile locking, duplicate registration numbers, 403 for every non-FR role on admin APIs, CSRF refusal, audit-log access,
cron secret, and three concurrency cases (simultaneous code requests, simultaneous code submissions, two FR users demoting each
other at once — 15 rounds). Each concurrency test was checked to fail when its database lock is removed.

## 3. Results

- 36 of 36 pass, repeated 4 times with no flaky failures.
- Type check passes for all server code, scripts and tests.

## 4. Not yet verified (environment limits)

The build environment could not install packages, so these have **not** been run yet:
- `next build` and type-checking of the Next.js pages (all 21 page/component files pass a syntax check only);
- the node-postgres adapter (`src/server/db/pg.ts`) — tests ran through a test-only database client with the same SQL;
- the SMTP mailer against Google Workspace;
- the pages in a browser, on desktop and mobile.

CI runs all of the first two automatically on the first push to GitHub.

## 5. Dependencies to proceed to deployment

- GitHub repository; first `npm install` (creates `package-lock.json`, commit it).
- Neon project; Vercel project; `sports-store@vitbhopal.ac.in` with SMTP relay or app password; DNS record for
  `sports-eqp-issue.hplvitbhopal.site`.
- Hosting decision: Vercel Pro or the existing Sports Facility Portal's hosting.

## 6. Next steps

Phase 3 — Inventory: sports, categories, locations, equipment records with codes, stock receipts, the stock ledger with
balance constraints, item history, search and filters, Excel template and import with preview.
