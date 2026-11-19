# Phase 4 report — Requests and issuance (16 Nov 2026)

## 1. Implemented

- Migration `0003_requests`: requests and lines, issues and issue lines, yearly reference counters (REQ-2026-000001,
  ISS-2026-000001), email outbox. Database rules: one issue per request, approver ≠ recipient, rejection needs a reason.
- **Recipients:** browse equipment that is available now, build a multi-item request (quantity, purpose, optional team / house /
  hostel / event, return date), see requests, equipment held with due dates and overdue days, history; cancel pending requests.
- **Staff:** request queue (Pending, Issued, Overdue, Closed) with search; request page showing live availability per line.
- **Approve & hand over** (FR Sports / ASO): one transaction that re-checks permissions and stock, lets the approver reduce or
  drop lines and set the due date, records approver and handing-over staff separately, moves Available → Issued, creates the issue
  and queues emails. All lines or none.
- **Reject** with a reason (emailed to the requester); **Ready for handover** flag for storekeepers.
- **Email outbox:** issue emails to recipient and issuing staff; queued in the same transaction; sent right after; retried after
  1, 5, 15, 60, 240 minutes; failures listed for FR Sports with "Send now"; 1,500/day ceiling; scheduled retry every 15 minutes via
  GitHub Actions.
- Overdue calculated live from the IST date.

## 2. Tested

22 new tests (85 total) on PostgreSQL 16 — `docs/test-results-phase4.txt`:
- Blueprint example: 60 available, issue 10 → 50 available, 10 issued; movement, approver and issuer recorded; both emails sent
  with reference, items, due date, issuer and approver.
- Two officers approving the same request at once (10 rounds): exactly one issue. Verified to fail when the request lock is removed.
- Two officers issuing the last 5 units to different people at once: one succeeds, the other is told nothing was issued; stock
  never negative.
- A line becoming unavailable while pending: nothing issued.
- Reduced and dropped lines; self-approval refused; storekeeper, procurement and recipient approvals refused (also over HTTP);
  repeat submission issues once.
- Request validation (availability, past/far dates, invalid dates, duplicates, 5-pending limit); cancel rules; ready flag;
  overdue appearing with no job running; due-date rules at handover.
- Email: failure after issuing leaves the issue intact and retries on schedule; 6 failures → Failed → resend works; 5 parallel
  dispatchers send 20 emails exactly once; duplicate queueing blocked; daily ceiling holds and resumes.
- Ledger consistent; total Issued stock equals the sum of open issue lines.

## 3. Results

85 of 85 pass, three consecutive runs. Server code type-checks.

## 4. Not yet verified (environment limits)

Pages (37 files) syntax-checked only, not compiled or used in a browser. Real sending through Google Workspace not tested.

## 5. Dependencies

As before, plus GitHub secrets `APP_URL` and `CRON_SECRET` for the 15-minute email retry.

## 6. Next steps

Phase 5 — Returns and damage: full-return screen (usable / damaged / missing / consumed per line, totals must match), incidents,
damage photos, mark-usable and recovered flows, return emails, overdue reminder emails.
