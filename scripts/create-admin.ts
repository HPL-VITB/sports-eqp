/**
 * Creates (or promotes) an FR Sports administrator. The only way to create the first admin;
 * after that, FR Sports grants roles inside the portal.
 *
 * Usage: DATABASE_URL=... npm run admin:create -- name@vitbhopal.ac.in "Full Name"
 */
import { ensureAdmin } from "../src/server/auth/accounts";
import { createPgDb } from "../src/server/db/pg";
import { ConsoleMailer } from "../src/server/email/mailer";
import { loadConfig } from "../src/server/config";

const [email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();
if (!email || !name) {
  console.error('Usage: npm run admin:create -- name@vitbhopal.ac.in "Full Name"');
  process.exit(1);
}
const config = loadConfig({ ...process.env, MAIL_TRANSPORT: "console", NODE_ENV: "development" });
const domain = email.trim().toLowerCase().split("@")[1] ?? "";
if (!config.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
  console.error(`Email must be on: ${config.ALLOWED_EMAIL_DOMAINS.join(", ")}`);
  process.exit(1);
}
const db = createPgDb(config.DATABASE_URL, 1);
try {
  const user = await ensureAdmin({ db, config, mailer: new ConsoleMailer(), now: () => new Date() }, email, name);
  console.log(`FR Sports administrator ready: ${user.email} (id ${user.id}). They sign in with an emailed code.`);
} finally {
  await db.end();
}
