export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Resolves when the mail server has accepted the message; rejects otherwise. */
  send(msg: OutgoingEmail): Promise<{ messageId: string }>;
}

/** Development only: prints the email to the server log. Refused in production by config. */
export class ConsoleMailer implements Mailer {
  async send(msg: OutgoingEmail) {
    console.info(`\n--- email to ${msg.to} ---\nSubject: ${msg.subject}\n\n${msg.text}\n--- end email ---\n`);
    return { messageId: `console-${Date.now()}` };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function otpEmail(to: string, code: string, minutes: number): OutgoingEmail {
  const text =
    `Your sign-in code for the VIT Bhopal Sports Equipment Portal is ${code}.\n\n` +
    `It expires in ${minutes} minutes. If you did not try to sign in, ignore this email; nobody can sign in without the code.\n`;
  const html =
    `<p>Your sign-in code for the VIT Bhopal Sports Equipment Portal is</p>` +
    `<p style="font-size:24px;font-weight:600;letter-spacing:4px">${escapeHtml(code)}</p>` +
    `<p>It expires in ${minutes} minutes. If you did not try to sign in, ignore this email; nobody can sign in without the code.</p>`;
  return { to, subject: `${code} is your Sports Portal sign-in code`, text, html };
}
