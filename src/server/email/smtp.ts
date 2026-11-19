import nodemailer from "nodemailer";
import type { Config } from "../config";
import type { Mailer, OutgoingEmail } from "./mailer";

/**
 * Google Workspace over SMTP.
 * Preferred: SMTP relay service (smtp-relay.gmail.com:587, SMTP AUTH with the dedicated sending account).
 * Simpler: smtp.gmail.com:587 with that account's app password.
 */
export class SmtpMailer implements Mailer {
  private transport: nodemailer.Transporter;

  constructor(private config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      requireTLS: config.SMTP_PORT !== 465,
      auth: { user: config.SMTP_USER!, pass: config.SMTP_PASS! },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  /** Connects and signs in to the mail server without sending anything. Throws with the server's reason on failure. */
  async verify(): Promise<void> {
    await this.transport.verify();
  }

  async send(msg: OutgoingEmail) {
    const info = await this.transport.sendMail({
      from: this.config.MAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { messageId: String(info.messageId) };
  }
}
