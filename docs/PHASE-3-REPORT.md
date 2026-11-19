# Phase 3 report — Inventory (16 Nov 2026)

## 1. Implemented

- Migration `0002_inventory`: sports, categories, locations (location › room), equipment items, current balances
  (`item_stock`), append-only movement ledger (`stock_movements`), ledger consistency view, request keys, import batches.
  Seeded with the central store and 11 sports.
- Sports, categories and locations: FR Sports adds, renames, deactivates; codes are generated once and never change.
- Equipment records: automatic codes `SPORT-CATEGORY-NNNN`; opening quantity recorded as an OPENING movement; duplicate
  definitions refused; descriptive fields editable and audited; sport, category and code fixed; deactivation only at zero stock.
- Stock receipts: Available += quantity with before/after, who, when and remarks; protected against double submission.
- Search and filters: text (name, code, brand, model, category), sport, category, location, low stock, active/deactivated, with
  totals.
- Item history page with every movement.
- Excel import: downloadable template (with lists of sports, categories, units, locations), `.xlsx` and `.csv` upload, row-by-row
  preview, merging of repeated rows, all-or-nothing confirmation with re-check, 30-minute preview expiry.
- Daily job now also runs the ledger consistency check.
- Pages: Inventory list, Add equipment, Item page (stock, history, receive stock, edit), Import from Excel, Sports & locations admin.

## 2. Tested

27 new automated tests (63 in total) against real PostgreSQL 16 — see `docs/test-results-phase3.txt`:
- Blueprint arithmetic: opening 40, receipt 20 → 60; every movement checked as before + quantity = after, chained.
- 25 simultaneous receipts on one item: every unit counted, ledger unbroken. Verified to fail when the row lock is removed.
- Same request submitted 6 times at once: stock added once.
- 10 simultaneous creations in one category: codes 0001–0010 with no gaps or repeats; 5 identical creations: exactly 1 created.
- Database refuses negative stock and any edit or deletion of history.
- Permissions for every role on master data, item creation, receipts, search and import.
- Import: preview changes nothing; a file with any error imports nothing; double confirmation imports once; a change made after
  the preview blocks the import with nothing applied; expiry; role limits per row; multipart upload over HTTP.
- Spreadsheet reading verified against files saved by **openpyxl** and **LibreOffice**; the generated template opens in LibreOffice.

## 3. Results

63 of 63 pass, three consecutive runs. Server code type-checks.

## 4. Not yet verified (environment limits)

Same as Phase 2: the Next.js pages (now 30 page/component files) pass a syntax check only and have not been compiled or opened in
a browser; the production database adapter and Excel download in a real browser are untested here. CI covers compilation.

## 5. Dependencies

Unchanged from Phase 2. For go-live: the department's opening stock list, ideally entered in the downloaded template.

## 6. Next steps

Phase 4 — Requests and issuance: recipient browse-and-request (multi-item), pending queue, Approve & hand over in one transaction
with stock deduction, rejection, Ready-for-handover flag, issue records, email outbox and issue emails.
