# Phase 5 report — Returns and damage (17 Nov 2026)

## 1. Implemented

- Migration `0004_returns`: return lines, incidents (returned damaged, damaged in store, missing, used up) with resolutions,
  photos, overdue reminder log, reminder settings.
- **Return screen:** search open issues (earliest due first); per item enter usable / damaged / missing / used up (consumables
  only) with notes; optional remarks and damage photo. One transaction: totals must equal what was issued, stock moves out of
  Issued, incidents open against the issue and accountable recipient, issue and request close, two return emails queued.
- **Damaged:** unavailable until FR Sports or ASO marks units usable. **Missing:** store staff record units found (usable or
  damaged). **Used up:** awaits FR Sports discard (Phase 6). **Damage found in the store** from the item page.
- **Photos:** browser compression, server-side type check by file signature, staff-only viewing, daily clean-up of unattached ones.
- **Overdue reminders:** daily job, schedule set by FR Sports (default day 1, then every 3 days, 4 at most), final reminder copied
  to the issuing staff member, no duplicates, missed days caught up once.
- **One daily job** for reminders, housekeeping, photo clean-up and the ledger check; each part runs even if another fails.
- Pages: Returns list, return form / returned summary, Damage, missing & discards, store-damage form, reminder schedule.

## 2. Tested

18 new tests (103 total) on PostgreSQL 16 — `docs/test-results-phase5.txt`:
- Blueprint normal return (50 + 10 issued → 60 available) and damaged return (8 usable + 2 damaged → 58 available, 2 damaged);
  damaged units not requestable; return emails to recipient and issuer with the condition of every item.
- Missing items with required note; consumables used up; refusal of short, over, partial, extra-item and non-consumable "used up"
  returns with no change to stock; recipient, procurement and management refused.
- Five staff confirming the same return at once: exactly one recorded. Verified to fail when the issue lock is removed.
- Mark usable (permissions, partial, over-quantity, closing), recovered usable / damaged, store damage limits.
- Photos: type check, size limit, permissions, link to damage, clean-up of unattached only.
- Email failure after a return; repeat submission over HTTP records once.
- Reminders: schedule arithmetic, 15 simulated days (4 reminders, final copied to issuer, no repeats), catch-up, none after return,
  settings permissions and "0 = off".
- Books balance: ledger matches; open damage incidents = Damaged stock; open missing + used-up incidents = Missing stock;
  Issued stock = open issue lines.

## 3. Results

103 of 103 pass, three consecutive runs. Server code type-checks.

## 4. Not yet verified (environment limits)

Pages (42 files) syntax-checked only. Photo capture and compression on a real phone, and reminder emails through Google Workspace,
are untested.

## 5. Dependencies

Unchanged. Vercel Cron now calls `/api/cron/daily` at 09:00 IST (needs `CRON_SECRET` in Vercel).

## 6. Next steps

Phase 6 — Corrections and discards: discard requests with reserved quantities and FR Sports approval (including the used-up
consumables from this phase), physical stock counts excluding issued units, correction requests applied as differences, and
FR Sports reversal of erroneous movements.
