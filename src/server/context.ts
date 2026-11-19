import type { Config } from "./config";
import type { Db } from "./db/types";
import type { Mailer } from "./email/mailer";

/** Everything server code needs, passed explicitly so it can be tested without Next.js. */
export interface AppContext {
  db: Db;
  config: Config;
  mailer: Mailer;
  /** Injectable clock (tests move time forward). */
  now: () => Date;
}
