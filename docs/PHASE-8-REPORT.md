# Phase 8 report — Testing, hardening and deployment readiness

Version 1.0.0-rc.1 · 17 Nov 2026

## 1. Implemented

- **Page checks** (`tools/preview/`, `npm run typecheck:pages`, `npm run check:pages`, both added to CI):
  - All 48 page and component files are type-checked against minimal React/Next.js stand-ins.
  - All 25 app pages, plus the login, forbidden and home pages, are rendered for all 6 roles against a seeded database.
  - Who can open what is recorded in `docs/page-access-matrix.json`.
  - Automated accessibility checks run on each rendered page.
- **Fixes found by those checks:**
  - A report opened by a role that may not see it crashed the page instead of showing the access page.
  - Phones had no Sign out button.
  - Short pages on phones showed a blank band under the menu.
  - Stacked tables on phones had a stray right alignment and showed empty labels.
  - Reference numbers wrapped across lines.
- **Production hardening:**
  - Content-Security-Policy header.
  - `/api/health`, which reports database up/down and whether the schema matches the build, and nothing else.
  - Production refuses to start with a missing or short job secret, or with example secrets.
  - Constant-time comparison of the job secret.
  - SMTP `verify()`.
- **`npm run preflight`:** checks configuration, database, schema (with optional `--migrate`), presence of an FR Sports
  administrator, stock ledger consistency, mail-server sign-in, an optional test email, and the live health check and
  headers.
- **Backups:** optional nightly encrypted `pg_dump` workflow, with restore instructions.
- **Documentation:**
  - `docs/DEPLOYMENT.md`: the full go-live runbook and operations guide.
  - `docs/UAT-CHECKLIST.md`: 28 acceptance checks.
  - User guide for all roles: a shareable doc.
  - `docs/screenshots/`.

## 2. Tested

- `tests/health.test.ts` (4 tests):
  - The schema version constant matches the newest migration.
  - Health returns ok, degraded when the schema is behind, and down without leaking error details.
  - Production configuration rules hold.
  - The job secret must match exactly.
- The page access matrix was compared cell by cell with the permission rules. Management pages contain no action
  controls other than Sign out, the report filter's Apply, and Print.
- The accessibility checker was itself tested on a page with six planted faults; it found all six. Colour contrast of
  all text colours was computed against WCAG AA.
- The page type-check was tested by planting two errors; both were caught.
- Backup pipeline: dump → encrypt → decrypt → restore into a new database gave the same data, and a wrong passphrase was
  refused.
- Desktop (1280 px) and phone (390 px) screenshots of the main screens were captured in headless Chrome and reviewed.
- Static review:
  - No server code is imported by browser components (type imports only).
  - No secrets are read outside the config module, and no `NEXT_PUBLIC_` variables exist.
  - No raw HTML injection.
  - SQL text is built only from constants, with all values passed as parameters.
  - Every GET route is dynamic, so none is pre-rendered at build time.

## 3. Results

- Full suite: **134 / 134 passed, 0 skipped**, in three consecutive clean runs (`docs/test-results-phase8.txt`).
- Page type-check: 0 errors.
- Page render: 0 failures across 6 roles.
- Accessibility: 86 rendered pages, 0 issues. All text colours meet WCAG AA, at 5.3:1 to 15.7:1.

## 4. Unresolved issues

- **Not deployed and not built with Next.js here.** This environment cannot install packages or reach the internet. The
  first real `next build` happens in CI on your first push, and is the first point to check (DEPLOYMENT.md §1).
- **Real email not tested.** Google Workspace sending is verified only by `npm run preflight -- --send-test`, run with
  real credentials.
- **Not checked in a real browser.** Interactive parts (forms, client-side loading, photo upload, Excel upload) were
  exercised through their APIs in tests, not by clicking. The rendered pages show only the first state of browser
  components, and the print layout has not been checked on paper. The UAT covers all of these.
- The CSP allows inline scripts (a standard Next.js setup). Moving to nonces is possible later.
- Neon's free plan holds 1 GB; damage photos are the main growth. DEPLOYMENT.md §0.2 explains what to watch.

## 5. Dependencies

- No new runtime packages.
- The checks use esbuild, already present, plus Python 3 (on CI runners).
- Deployment needs:
  - a GitHub organisation or account
  - Neon
  - Vercel (Pro advised) or the university's own hosting
  - a dedicated Google Workspace sending account (app password or SMTP relay)
  - your DNS record for `sports-eqp-issue`

## 6. Next steps

1. Push to a private GitHub repository and get CI green (send the log if `next build` fails).
2. Neon → Google Workspace mail account → Vercel settings → `npm run preflight -- --migrate --send-test …` →
   `npm run admin:create` → deploy → add the CNAME → set the GitHub secrets (DEPLOYMENT.md §1–8).
3. Run the UAT checklist with FR Sports, the ASO and a storekeeper, on a desktop and a phone. Then import the opening
   stock and do one physical count.
4. After a clean UAT, tag 1.0.0.
