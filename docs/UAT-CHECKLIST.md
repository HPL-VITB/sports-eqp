# User acceptance test — before go-live

Run on the **live URL** after deployment (DEPLOYMENT.md §6–7). Use real university accounts: FR Sports, the ASO, a storekeeper,
someone from Procurement, someone from management, and two students. Use one desktop browser **and** one phone for the
starred rows (★). Afterwards remove the test records: let the issues be returned, and discard the test item if you made one.

Tick ✓ or write what happened. Anything that fails goes to the maintainer with a screenshot and the time.

| # | Who | Do this | Expect | ✓ / note |
| --- | --- | --- | --- | --- |
| **Sign-in** | | | | |
| 1 ★ | Student | Open the URL, enter university email, request a code | Code email arrives within a minute, not in spam | |
| 2 | Student | Enter a wrong code 5 times | Locked out of that code; a new code works | |
| 3 | Anyone | Try a gmail.com address | Refused: university email only | |
| 4 ★ | Student | First sign-in: complete profile (name, registration no., category) | Lands on *My equipment* | |
| 5 | Student | Type `/dashboard` in the address bar | "Not available for your role" page | |
| **Request → handover** | | | | |
| 6 ★ | Student | *Browse & request*: pick 2 items, quantity, purpose, return date, submit | Request reference shown; appears under *My equipment* as pending | |
| 7 | Storekeeper | Open the request, *Mark ready for handover* | Badge "Ready"; stock unchanged | |
| 8 ★ | ASO | Open the request, *Approve & hand over*, handed over by the storekeeper | Issue reference; Available drops and Issued rises by the quantities | |
| 9 | Student + storekeeper | Check inboxes | Both receive the issue email with items and due date | |
| 10 | FR Sports | Try to approve a request for more than is available | Refused with the available quantity; nothing changes | |
| 11 | ASO | Reject another request with a reason | Student gets the rejection email with the reason | |
| **Return and damage** | | | | |
| 12 ★ | Storekeeper | *Returns*: open the issue, record 1 usable + 1 damaged, attach a phone photo | Return accepted; damaged count +1; email to student and issuing staff | |
| 13 | Storekeeper | Try to record fewer units than issued | Refused: every unit must be accounted for | |
| 14 | FR Sports | *Adjustments → Damage & missing*: mark the damaged unit repaired/usable | Damaged −1, Available +1 | |
| **Discards, counts, corrections** | | | | |
| 15 | Storekeeper | Request a discard of 1 unit with a reason | Unit shown as held; cannot be issued | |
| 16 | FR Sports | Approve the discard | Discarded +1; record kept | |
| 17 | ASO | Start a stock count for one sport, enter counts, submit | Differences become corrections waiting for FR Sports | |
| 18 | FR Sports | Approve one correction, reject another | Stock changes only for the approved one | |
| **Overdue** | | | | |
| 19 | FR Sports | Issue something with today's date as due date; check next morning after 09:00–10:00 IST | Shows on dashboard as overdue; reminder email to the recipient | |
| **Stock receipt** | | | | |
| 20 | Procurement | *Inventory* → an item → *Receive stock* with invoice reference | Available increases; shows in *Stock received* report | |
| 21 | Procurement | Try to open *Requests & Issues* | No access | |
| **Dashboard and reports** | | | | |
| 22 ★ | FR Sports | Dashboard | Figures match the inventory list; "Needs your action" lists the pending items | |
| 23 | Management | Dashboard, reports, an item page | Everything visible; no buttons to change anything | |
| 24 | FR Sports | *Reports → Issue and return register*: Download Excel and PDF, and Print | Files open (Excel, PDF reader); print shows the table only | |
| **Admin** | | | | |
| 25 | FR Sports | Add a staff user and give a role; deactivate another | New role applies on their next page load; deactivated person is signed out | |
| 26 | FR Sports | *Email delivery* | Today's emails listed as sent; none failed | |
| 27 | FR Sports | *Audit log* | Every action above is listed with person and time | |
| **Phone** | | | | |
| 28 ★ | Any | Use the menu, sign out | Menu scrolls sideways; *Sign out* is at the end | |

Signed off by: ____________________ (FR Sports)   Date: __________
