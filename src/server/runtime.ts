import "server-only";
import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { createPgDb } from "./db/pg";
import { ConsoleMailer } from "./email/mailer";
import { SmtpMailer } from "./email/smtp";

/** One context per server instance, created on first use. */
let ctx: AppContext | undefined;

export function getAppContext(): AppContext {
  if (!ctx) {
    const config = loadConfig();
    ctx = {
      config,
      db: createPgDb(config.DATABASE_URL),
      mailer: config.MAIL_TRANSPORT === "smtp" ? new SmtpMailer(config) : new ConsoleMailer(),
      now: () => new Date(),
    };
  }
  return ctx;
}
