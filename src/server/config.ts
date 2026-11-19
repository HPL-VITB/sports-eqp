import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    APP_ORIGIN: z
      .string()
      .url()
      .transform((v) => v.replace(/\/+$/, "")),
    OTP_HMAC_SECRET: z.string().min(32, "OTP_HMAC_SECRET must be at least 32 characters"),
    ALLOWED_EMAIL_DOMAINS: z
      .string()
      .default("vitbhopal.ac.in")
      .transform((v) =>
        v
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      )
      .refine((list) => list.length > 0, "At least one allowed email domain is required"),
    // Department mailboxes that are always FR Sports (administrator). Signing in with one of these
    // (proven by the emailed code) promotes the account and opens the admin dashboard directly.
    ADMIN_EMAILS: z
      .string()
      .default("fr.sports@vitbhopal.ac.in")
      .transform((v) =>
        v
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    MAIL_TRANSPORT: z.enum(["smtp", "console"]).default("console"),
    MAIL_FROM: z.string().default("VIT Bhopal Sports Store <sports-store@vitbhopal.ac.in>"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    CRON_SECRET: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && c.MAIL_TRANSPORT === "console") {
      ctx.addIssue({ code: "custom", path: ["MAIL_TRANSPORT"], message: "console mail is not allowed in production" });
    }
    if (c.MAIL_TRANSPORT === "smtp" && (!c.SMTP_HOST || !c.SMTP_USER || !c.SMTP_PASS)) {
      ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "SMTP_HOST, SMTP_USER and SMTP_PASS are required" });
    }
    if (c.NODE_ENV === "production" && (!c.CRON_SECRET || c.CRON_SECRET.length < 24)) {
      ctx.addIssue({ code: "custom", path: ["CRON_SECRET"], message: "CRON_SECRET of at least 24 characters is required in production" });
    }
    for (const key of ["OTP_HMAC_SECRET", "CRON_SECRET"] as const) {
      if (c.NODE_ENV === "production" && /change-me/i.test(c[key] ?? "")) {
        ctx.addIssue({ code: "custom", path: [key], message: "still the example value from .env.example" });
      }
    }
    if (c.NODE_ENV === "production" && !c.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN must be https in production" });
    }
  });

export type Config = z.infer<typeof schema> & { secureCookies: boolean };

/** True for the configured department admin mailbox(es), e.g. fr.sports@vitbhopal.ac.in. */
export function isAdminEmail(config: Pick<Config, "ADMIN_EMAILS">, email: string): boolean {
  return config.ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return { ...parsed.data, secureCookies: parsed.data.APP_ORIGIN.startsWith("https://") };
}
