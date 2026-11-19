/** Manual run of the daily housekeeping job (normally triggered by Vercel Cron at /api/cron/purge). */
import { purgeExpired } from "../src/server/auth/otp";
import { loadConfig } from "../src/server/config";
import { createPgDb } from "../src/server/db/pg";
import { ConsoleMailer } from "../src/server/email/mailer";

const config = loadConfig({ ...process.env, MAIL_TRANSPORT: "console", NODE_ENV: "development" });
const db = createPgDb(config.DATABASE_URL, 1);
try {
  console.log(await purgeExpired({ db, config, mailer: new ConsoleMailer(), now: () => new Date() }));
} finally {
  await db.end();
}
