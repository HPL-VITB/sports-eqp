# Deployment and operations runbook

Target: `https://sports-eqp-issue.hplvitbhopal.site` · Next.js on Vercel · PostgreSQL on Neon · email through the
university's Google Workspace. Written for the person setting up the portal (FR Sports or university IT). Steps are in
order; each ends with a check. Nothing here requires sharing passwords with anyone else.

---

## 0. Decide and gather

| Item | Who | Notes |
| --- | --- | --- |
| Hosting plan | FR Sports / IT | See §0.1. |
| GitHub account (organisation preferred) | IT | Holds the code, CI, the email-retry job and optional backups. Repository must be **private**. |
| Neon account | IT | Database. Free plan is enough to start (§0.2). |
| Sending mailbox, e.g. `sports-store@vitbhopal.ac.in` | University Google Workspace admin | A dedicated account, not a person's mailbox. |
| DNS access for `hplvitbhopal.site` | You | One CNAME record. |
| First FR Sports administrator's university email | FR Sports | Everyone else is added inside the portal. |

### 0.1 Vercel plan

Vercel's Hobby (free) plan is limited to personal, non-commercial use, and Vercel states that all commercial use
needs Pro or Enterprise. A university department's operational system is not a personal project, so **Pro
(US$20/month per deploying member, with usage credit included) is the safe choice**. If the university already
runs the Sports Facility Portal on its own hosting, this app can run there instead. It needs Node.js 20.9+ and outbound
access to Neon and Gmail SMTP. Steps 4 and 6 then change, and the rest stays the same.

The portal is built to work on either plan. The once-a-day reminder job fits Hobby's cron limit (Hobby runs it at
some point within the scheduled hour). The 15-minute email retry runs from GitHub Actions instead of Vercel.

### 0.2 Neon plan

The Free plan includes 100 compute-hours a month and 1 GB of storage per project. The database itself is small. Damage
photos are the largest item (compressed in the browser, at most 1.5 MB each, usually far less). Check *Storage* in the
Neon console every term. Move to the Launch plan (usage-billed) if storage passes about 800 MB, or if the portal
feels slow after idle periods (the free plan sleeps when idle; the first request after that takes a second or two).
Upgrading is a billing change only: no data migration, and the connection string stays the same.

---

## 1. Code on GitHub

1. Create a **private** repository, e.g. `vitbhopal-sports/sports-eqp-issue`.
2. Unzip the release and push it:
   ```bash
   git init && git add . && git commit -m "Sports Equipment Portal 1.0.0-rc.1"
   git branch -M main && git remote add origin git@github.com:<org>/sports-eqp-issue.git && git push -u origin main
   ```
3. Open **Actions → CI**. The first run installs packages, runs all tests, renders every page, builds the Next.js app
   and type-checks it.
4. After it passes, run `npm install` locally once, then commit `package-lock.json`. In `.github/workflows/ci.yml`,
   change `npm install` to `npm ci`.

✔ CI is green. **If the build step fails, stop and send the log to the maintainer.** This is the first time the pages
are compiled by Next.js itself.

## 2. Database (Neon)

1. Create project **sports-eqp-issue** with PostgreSQL 17, in the region nearest Bhopal that Neon offers (an
   Asia-Pacific region such as Singapore, or Mumbai if listed).
2. Copy two connection strings from *Connect*:
   - **Pooled** (host contains `-pooler`). This goes to Vercel as `DATABASE_URL`.
   - **Direct** (no `-pooler`). Use it on your laptop for migrations, and for backups.
3. Optional but recommended: in *Roles*, create `backup_reader` and give it read access (SQL editor):
   `GRANT pg_read_all_data TO backup_reader;`

## 3. Email (Google Workspace)

Ask the Workspace admin for a dedicated sending account, e.g. `sports-store@vitbhopal.ac.in`, then choose one option:

- **A. App password (simplest).** Turn on 2-Step Verification for the sending account, then create an app password
  (Google Account → Security → App passwords).
  Settings: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=sports-store@vitbhopal.ac.in`, `SMTP_PASS=<app password>`.
- **B. SMTP relay (admin-managed).** Admin console → Apps → Google Workspace → Gmail → Routing → SMTP relay service.
  Allowed senders: *only addresses in my domains*. Authentication: *require SMTP authentication*. Encryption:
  *require TLS*. Settings: `SMTP_HOST=smtp-relay.gmail.com`, port 587, same user, and that account's password or
  app password.

Set `MAIL_FROM="VIT Bhopal Sports Store <sports-store@vitbhopal.ac.in>"`. The portal stops sending at 1,500 emails a
day, well under Gmail's per-account daily limit. Codes and notices beyond that wait until the next day and show on
*Email delivery*.

## 4. Vercel project

1. Vercel → *Add New → Project* → import the GitHub repository. Framework is detected as Next.js. Leave the build
   settings at their defaults.
2. *Settings → Functions → Region*: choose the region nearest the Neon database (for example `sin1` Singapore if Neon
   is in Singapore, `bom1` Mumbai if Neon is in Mumbai).
3. *Settings → Environment Variables* (Production). Generate each secret separately, for example with
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon **pooled** connection string |
   | `APP_ORIGIN` | `https://sports-eqp-issue.hplvitbhopal.site` |
   | `OTP_HMAC_SECRET` | random, 48+ characters |
   | `CRON_SECRET` | random, 32+ characters (different from the one above) |
   | `ALLOWED_EMAIL_DOMAINS` | `vitbhopal.ac.in` |
   | `MAIL_TRANSPORT` | `smtp` |
   | `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | from step 3 |

   The app refuses to start in production if the email setting is `console`, if `APP_ORIGIN` is not https, if
   `CRON_SECRET` is missing or short, or if a secret still has its `.env.example` value.
4. Do **not** deploy yet. The database is still empty (step 5).

## 5. Prepare the database (from your laptop)

Requires Node.js 22 and the repository checked out with `npm install` done. Put the **production** values in a file
`.env.production.local` (gitignored), but with the **direct** Neon connection string as `DATABASE_URL`. Then:

```bash
set -a; . ./.env.production.local; set +a
npm run preflight -- --migrate --send-test your.name@vitbhopal.ac.in
npm run admin:create -- fr.sports@vitbhopal.ac.in "Full Name of FR Sports"
npm run preflight
```

✔ Expected: PASS for configuration, database, schema current, one FR Sports administrator, stock balances, mail
server sign-in, and test email accepted. **Check that the test email arrived and is not in spam.** The health check
shows WARN until the site is deployed.

Delete `.env.production.local` when finished, or keep it only in an encrypted place.

## 6. Deploy and connect the domain

1. Vercel → *Deployments* → deploy `main`.
2. *Settings → Domains* → add `sports-eqp-issue.hplvitbhopal.site`. Vercel shows the DNS record to create.
3. At the DNS provider for `hplvitbhopal.site`, add exactly the record Vercel shows (normally a **CNAME** for
   `sports-eqp-issue` pointing to the Vercel target). Remove any older record with the same name.
4. Wait until Vercel shows the domain as valid and the certificate as issued (minutes to a few hours).

✔ `https://sports-eqp-issue.hplvitbhopal.site/api/health` returns `{"status":"ok","database":"up","schema":"current"}`.
✔ `npm run preflight` now passes the health check and security headers too.

## 7. Scheduled jobs

- **Daily reminders and housekeeping:** Vercel reads `vercel.json` and runs `/api/cron/daily` at 03:30 UTC (09:00 IST).
  Check *Settings → Cron Jobs*.
- **Email retry every 15 minutes:** GitHub → repository *Settings → Secrets and variables → Actions* → add `APP_URL`
  (`https://sports-eqp-issue.hplvitbhopal.site`) and `CRON_SECRET` (same value as in Vercel). Then *Actions → Email
  retry → Run workflow* once.

✔ The manual run succeeds and prints `{"sent":…}`. GitHub may delay scheduled runs by a few minutes, which is fine.

## 8. Backups

Neon keeps a short restore window. The optional nightly backup (`.github/workflows/backup.yml`) adds 30 days of
encrypted copies:

1. Add repository secrets `BACKUP_DATABASE_URL` (direct connection string, preferably the `backup_reader` role) and
   `BACKUP_PASSPHRASE` (long, random). Write the passphrase down and keep it offline with FR Sports or IT. Without it a
   backup cannot be opened.
2. *Actions → Database backup → Run workflow*. An artifact `sports-eqp-YYYYMMDD-HHMM.dump.gpg` appears.

The backup contains personal data. Keep the repository private, give access only to the people who maintain the portal,
and delete the secrets if backups are no longer wanted. If Neon is later moved to PostgreSQL 18, change
`postgresql-client-17` and the `pg_dump` path in the workflow to 18.

**Restore (rehearse once before go-live):**
```bash
gpg -d sports-eqp-YYYYMMDD-HHMM.dump.gpg > db.dump      # asks for the passphrase
pg_restore --no-owner --clean --if-exists -d "<DIRECT connection string of an EMPTY Neon branch>" db.dump
```
Restore into a new Neon branch first and check it. Point Vercel's `DATABASE_URL` at it only if the main branch is lost.

## 9. Acceptance test, then go-live

1. Work through `docs/UAT-CHECKLIST.md` with FR Sports, the ASO and a storekeeper, on a desktop and on a phone.
2. FR Sports adds staff under *Users & roles*, checks sports and locations under *Sports & locations*, and loads the
   opening stock via *Inventory → Import from Excel*. The template lists current sports, categories and locations.
3. Do a physical stock count of one sport (*Adjustments → Stock counts*) to confirm the imported figures.
4. Announce the URL to students and staff. Sign-in is with a university email and a code; there are no passwords.

---

## Operating the portal

**Monitoring.** Add `/api/health` to any free uptime monitor, checking every 5 minutes and alerting FR Sports or IT
by email. *Email delivery* (FR Sports) lists emails that failed six times; fix the cause, then *Resend*.
Vercel → *Logs*: the daily job writes `STOCK LEDGER MISMATCH` if balances and history ever disagree. That should never
happen. If it does, do not correct stock by hand; contact the maintainer.

**Updating.** Every push to `main` deploys automatically after CI passes. If a release adds a file under
`db/migrations/`, run `npm run preflight -- --migrate` with production settings **before** merging it. Migrations only
add to the schema, so the running version keeps working. `/api/health` shows `degraded` if the database is behind the
deployed code.

**Rolling back.** Vercel → *Deployments* → the previous deployment → *Promote / Instant Rollback*. Database migrations are
not rolled back. They are written to be compatible with the previous release.

**Rotating secrets.** `OTP_HMAC_SECRET`: change it in Vercel and redeploy. Codes that are in flight stop working,
and people request a new one. `CRON_SECRET`: change it in Vercel and in GitHub at the same time. `SMTP_PASS`: create a new app
password, update Vercel, redeploy, then revoke the old one. `DATABASE_URL`: reset the role password in Neon, then update
Vercel (and the backup secret).

**People leaving.** FR Sports deactivates the account under *Users & roles*. Sessions end immediately, and history and
names in past records are kept. Hand the FR Sports role to another person **before** the outgoing FR Sports is
deactivated. The portal will not allow the last active FR Sports to be removed.

**Data retention.** The daily job deletes expired sign-in codes and sessions, old rate-limit counters, and photos never
attached to a record. Issue, return, stock and audit records are kept permanently, as the department's register.

**Costs to expect.** Vercel Pro is US$20/month per deploying member (only the maintainer needs a seat; viewers are
free). Neon Free costs $0 until the limits in §0.2 are reached. GitHub private repositories and Actions minutes for
these jobs normally fit the free allowance. Google Workspace is already in place.
