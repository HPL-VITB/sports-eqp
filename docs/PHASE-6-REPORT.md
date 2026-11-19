# Phase 6 report — Corrections and discards (17 Nov 2026)

## 1. Implemented

- Migration `0005_corrections`: discard requests, holds on damage / missing records, stock count sessions and lines, corrections,
  one-time reversal rule; automatic discard requests for any used-up consumables already recorded.
- **Discards:** request from store stock (item page) or from a damage / missing record; units held while pending; FR Sports approves
  (stock moves to Discarded, record closed) or rejects with a reason (hold released); requester can cancel. Issued equipment can
  never be discarded. Used-up consumables are sent to FR Sports automatically at return.
- **Corrections:** "physical count differs" on the item page, or from a stock count; stored as a difference; FR Sports approval
  applies the difference; refused if it would take stock below zero; damaged corrections keep damage records in step.
- **Stock counts:** start by sport, category, location or whole store; count sheet with save-and-continue; issued units shown but
  not expected on the shelf; submission captures the system figures, creates corrections and leaves a verification report.
- **Reversal:** FR Sports undoes a mistaken receipt / opening stock from the item history, once, with a reason.
- Pages: Adjustments & discards with tabs (Damage & missing, Discards, Corrections, Stock counts), count sheet and report, item-page
  request forms, Reverse link in history.

## 2. Tested

17 new tests (120 total) on PostgreSQL 16 — `docs/test-results-phase6.txt`:
- Discard from store: held units disappear from the catalogue; ASO cannot approve; FR approval reduces stock; item record kept.
- Issued units cannot be discarded; held units cannot be requested twice; cancel and reject release holds; who may request.
- Damaged-unit discard closes the damage record; held units cannot be marked usable meanwhile.
- Automatic discard for used-up shuttles, approved by FR Sports.
- Correction approved after an issue in between: applied as −2, giving 42 available and 5 issued (not overwritten to 47).
- Correction that would go negative refused with nothing changed; one pending per item; cancel rules; damaged corrections.
- Blueprint count: 50 accountable, 20 issued → 30 expected on the shelf; counting 30 creates no correction.
- Count with a difference creates a correction linked to the count report; closed counts cannot be edited.
- Reversal: FR only, once, original kept, issues not reversible.
- Simultaneous approvals of the same discard and of the same correction: applied exactly once.
- Books balance: ledger; damage records = Damaged; missing records = Missing; held store units = pending store discards.

## 3. Results

120 of 120 pass, three consecutive runs. Server code type-checks.

Note on the concurrency checks: double approval of discards and corrections is stopped by three independent guards (row lock,
"still pending" condition on the final write, and the held-unit counts). Removing any one of them still leaves the test passing,
so these tests confirm the combined behaviour rather than each guard on its own.

## 4. Not yet verified (environment limits)

Pages (51 files) syntax-checked only; not compiled or used in a browser.

## 5. Dependencies

Unchanged.

## 6. Next steps

Phase 7 — Dashboard and reports: dashboard counts and action list, the five registers (stock, issue & return, damage & missing,
verification, discard) with filters and Excel / PDF / print export, and management read-only access to them.
