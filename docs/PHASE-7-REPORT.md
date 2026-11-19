# Phase 7 report — Dashboard and reports

Version 0.7.0 · 17 Nov 2026

## 1. Implemented

- **Dashboard** (`/dashboard`): stock totals (available excluding units held for discard, issued, damaged, missing, accountable),
  overdue issues (top 8, days late), pending requests, low stock, recent issues and returns, sport-wise and location-wise
  tables. "Needs your action" is built per role from the permissions matrix; Management gets none (read-only).
- **Seven reports** (`/reports`, `/reports/[key]`): stock register; issue and return register (recipient, registration no.,
  approved by, handed over by, due, returned, condition, overdue); damage and missing register; stock verification; discards;
  corrections; stock received (including reversals). Filters: dates, sport, category, status, free-text search.
- **Exports:** Excel (`.xlsx`, numeric cells, totals row, "About" sheet with filters and generation time) and PDF (A4 landscape,
  repeated header, page numbers, totals) via `GET /api/reports/[key]?format=xlsx|pdf`; browser print with a print stylesheet
  that hides navigation and filters. Every export writes `report.export` to the audit log.
- Dashboard links open filtered inventory views (`/inventory?lowStock=1`, `?sportId=`).
- APIs: `GET /api/dashboard`, `GET /api/reports`, `GET /api/reports/[key]`.

## 2. Tested

`tests/reports.test.ts` (10 tests) builds a realistic week — receipts, a mistaken receipt and its reversal, two issues, a return
with damage, an approved discard, an approved correction, a stock count — then checks:

- stock register totals equal the live `item_stock` balances and each row's accountable total adds up;
- issue register: names, approvers, handover staff, condition text, leading zeros in registration numbers, overdue computed;
  status, search and date filters;
- damage, discard, correction, count and receipt registers record each event and who decided it; receipt totals net out the
  reversal;
- role access (Procurement 2 reports, Storekeeper 4, Management 7, Recipient 0), unknown report, invalid and reversed dates;
- Excel: same rows as the page, numeric cells, totals row, audit entry; **opened in LibreOffice** (converted to CSV);
- PDF: **`qpdf --check` passes**, `pdftotext` finds title, references, names, totals and page number; 120-row PDF paginates
  with the header on each page and shortens long text;
- dashboard totals match the stock register; action lists differ by role; recipient refused;
- HTTP: content types, download filenames, bad format → 400, recipient → 403.

## 3. Results

Full suite **130 / 130 passed, 0 skipped**, three consecutive clean runs (output in `docs/test-results-phase7.txt`).
Server code type-checks (`tsc --noEmit -p tsconfig.core.json`); every page and component passes a syntax check.

## 4. Unresolved issues

- Pages are syntax-checked but **not compiled by Next.js or viewed in a browser** in this environment (no package install);
  the CI workflow compiles them on first push. The print layout has not been checked on paper.
- PDFs print Latin text only (see DECISIONS Phase 7 #1).
- Very large exports (> 20,000 rows) are refused with a message to narrow the filters; not load-tested on Vercel's 60 s limit.
- Unchanged from earlier phases: SMTP sending to Google Workspace not yet tested with real credentials; hosting choice open.

## 5. Dependencies

No new packages. Uses jszip (already present) for Excel. Tests use LibreOffice, qpdf and pdftotext when installed, and skip
those three checks otherwise.

## 6. Next steps — Phase 8 (on authorization)

Compile and fix in CI, browser testing on desktop and mobile, accessibility pass, security review, real SMTP test, Neon and
Vercel setup on `sports-eqp-issue.hplvitbhopal.site` (DNS record by you), seed master data and staff accounts, user guide and
handover notes. Needs: hosting decision, Neon/Vercel access, a Google Workspace sending account and app password.
