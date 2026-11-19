import { formatDate, formatDateTimeIST } from "../time";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface IssueEmailData {
  ref: string;
  requestRef: string;
  recipientName: string;
  groupName: string | null;
  issuedAt: Date;
  dueDate: string;
  issuedByName: string;
  approvedByName: string;
  lines: { code: string; name: string; qty: number; unit: string }[];
  appOrigin: string;
}

function table(lines: IssueEmailData["lines"]) {
  const rows = lines
    .map((l) => `<tr><td style="padding:4px 8px">${esc(l.code)}</td><td style="padding:4px 8px">${esc(l.name)}</td><td style="padding:4px 8px;text-align:right">${l.qty} ${esc(l.unit)}${l.qty === 1 ? "" : "s"}</td></tr>`)
    .join("");
  return `<table style="border-collapse:collapse;border:1px solid #ddd"><tr style="background:#f4f4f2"><th style="padding:4px 8px;text-align:left">Code</th><th style="padding:4px 8px;text-align:left">Equipment</th><th style="padding:4px 8px;text-align:right">Quantity</th></tr>${rows}</table>`;
}

export function issueEmail(d: IssueEmailData, audience: "recipient" | "issuer") {
  const items = d.lines.map((l) => `  - ${l.name} (${l.code}): ${l.qty} ${l.unit}${l.qty === 1 ? "" : "s"}`).join("\n");
  const who = d.groupName ? `${d.recipientName} for ${d.groupName}` : d.recipientName;
  const intro =
    audience === "recipient"
      ? `The following sports equipment has been issued to you${d.groupName ? ` for ${d.groupName}` : ""}. Please return all of it by ${formatDate(d.dueDate)}.`
      : `You issued the following equipment to ${who}.`;
  const text =
    `${intro}\n\n${items}\n\n` +
    `Issue reference: ${d.ref} (request ${d.requestRef})\n` +
    `Issued on: ${formatDateTimeIST(d.issuedAt)}\n` +
    `Issued by: ${d.issuedByName}\nApproved by: ${d.approvedByName}\n` +
    `Due back: ${formatDate(d.dueDate)}\n\n` +
    (audience === "recipient" ? "Every item must be returned, or reported damaged or missing, at the sports store.\n" : "") +
    `${d.appOrigin}\n`;
  const html =
    `<p>${esc(intro)}</p>${table(d.lines)}` +
    `<p>Issue reference: <b>${esc(d.ref)}</b> (request ${esc(d.requestRef)})<br>Issued on: ${esc(formatDateTimeIST(d.issuedAt))}<br>` +
    `Issued by: ${esc(d.issuedByName)}<br>Approved by: ${esc(d.approvedByName)}<br>Due back: <b>${esc(formatDate(d.dueDate))}</b></p>` +
    (audience === "recipient" ? "<p>Every item must be returned, or reported damaged or missing, at the sports store.</p>" : "") +
    `<p><a href="${esc(d.appOrigin)}">${esc(d.appOrigin)}</a></p>`;
  const subject = audience === "recipient" ? `Equipment issued to you: ${d.ref}, due ${formatDate(d.dueDate)}` : `You issued ${d.ref} to ${who}`;
  return { subject, text, html };
}

export function rejectionEmail(d: { requestRef: string; reason: string; decidedByName: string; lines: { name: string; qty: number }[]; appOrigin: string }) {
  const items = d.lines.map((l) => `  - ${l.name}: ${l.qty}`).join("\n");
  const text =
    `Your equipment request ${d.requestRef} was not approved.\n\nReason: ${d.reason}\nDecided by: ${d.decidedByName}\n\n` +
    `Requested:\n${items}\n\nYou can send a new request at ${d.appOrigin}\n`;
  const html =
    `<p>Your equipment request <b>${esc(d.requestRef)}</b> was not approved.</p><p>Reason: ${esc(d.reason)}<br>Decided by: ${esc(d.decidedByName)}</p>` +
    `<ul>${d.lines.map((l) => `<li>${esc(l.name)}: ${l.qty}</li>`).join("")}</ul><p>You can send a new request at <a href="${esc(d.appOrigin)}">${esc(d.appOrigin)}</a></p>`;
  return { subject: `Equipment request ${d.requestRef} not approved`, text, html };
}

export interface ReturnEmailData {
  ref: string;
  recipientName: string;
  groupName: string | null;
  issuedAt: Date;
  returnedAt: Date;
  dueDate: string;
  issuedByName: string;
  receivedByName: string;
  lines: { code: string; name: string; unit: string; usable: number; damaged: number; missing: number; consumed: number }[];
  appOrigin: string;
}

function conditionText(l: ReturnEmailData["lines"][number]): string {
  const parts: string[] = [];
  if (l.usable) parts.push(`${l.usable} returned in good condition`);
  if (l.damaged) parts.push(`${l.damaged} returned damaged`);
  if (l.missing) parts.push(`${l.missing} missing`);
  if (l.consumed) parts.push(`${l.consumed} used up`);
  return parts.join(", ");
}

export function returnEmail(d: ReturnEmailData, audience: "recipient" | "issuer") {
  const total = (l: ReturnEmailData["lines"][number]) => l.usable + l.damaged + l.missing + l.consumed;
  const items = d.lines.map((l) => `  - ${l.name} (${l.code}), ${total(l)} ${l.unit}${total(l) === 1 ? "" : "s"}: ${conditionText(l)}`).join("\n");
  const problems = d.lines.some((l) => l.damaged || l.missing || l.consumed);
  const who = d.groupName ? `${d.recipientName} for ${d.groupName}` : d.recipientName;
  const intro =
    audience === "recipient"
      ? `Your return of issue ${d.ref} has been recorded and the issue is closed.`
      : `${who} has returned issue ${d.ref}, which you issued.`;
  const late = d.returnedAt.getTime() > Date.parse(`${d.dueDate}T23:59:59+05:30`);
  const text =
    `${intro}\n\n${items}\n\n` +
    `Issue reference: ${d.ref}\nIssued on: ${formatDateTimeIST(d.issuedAt)} by ${d.issuedByName}\n` +
    `Returned on: ${formatDateTimeIST(d.returnedAt)}${late ? ` (due ${formatDate(d.dueDate)})` : ""}\nReceived by: ${d.receivedByName}\n\n` +
    (problems && audience === "recipient" ? "Items recorded as damaged, missing or used up are reviewed by the Sports Department.\n" : "") +
    `${d.appOrigin}\n`;
  const rows = d.lines
    .map((l) => `<tr><td style="padding:4px 8px">${esc(l.code)}</td><td style="padding:4px 8px">${esc(l.name)}</td><td style="padding:4px 8px">${esc(conditionText(l))}</td></tr>`)
    .join("");
  const html =
    `<p>${esc(intro)}</p><table style="border-collapse:collapse;border:1px solid #ddd"><tr style="background:#f4f4f2"><th style="padding:4px 8px;text-align:left">Code</th><th style="padding:4px 8px;text-align:left">Equipment</th><th style="padding:4px 8px;text-align:left">Condition</th></tr>${rows}</table>` +
    `<p>Issue reference: <b>${esc(d.ref)}</b><br>Issued on: ${esc(formatDateTimeIST(d.issuedAt))} by ${esc(d.issuedByName)}<br>` +
    `Returned on: ${esc(formatDateTimeIST(d.returnedAt))}${late ? ` (due ${esc(formatDate(d.dueDate))})` : ""}<br>Received by: ${esc(d.receivedByName)}</p>` +
    (problems && audience === "recipient" ? "<p>Items recorded as damaged, missing or used up are reviewed by the Sports Department.</p>" : "") +
    `<p><a href="${esc(d.appOrigin)}">${esc(d.appOrigin)}</a></p>`;
  const subject =
    audience === "recipient" ? `Return recorded: ${d.ref}${problems ? " (with damaged or missing items)" : ""}` : `${d.ref} returned by ${who}${problems ? " — check condition" : ""}`;
  return { subject, text, html };
}

export function overdueEmail(
  d: { ref: string; recipientName: string; dueDate: string; daysOverdue: number; issuedByName: string; reminderNo: number; final: boolean; lines: { code: string; name: string; qty: number; unit: string }[]; appOrigin: string },
  audience: "recipient" | "issuer",
) {
  const items = d.lines.map((l) => `  - ${l.name} (${l.code}): ${l.qty} ${l.unit}${l.qty === 1 ? "" : "s"}`).join("\n");
  const days = `${d.daysOverdue} day${d.daysOverdue === 1 ? "" : "s"}`;
  const intro =
    audience === "recipient"
      ? `This sports equipment was due back on ${formatDate(d.dueDate)} and is now ${days} overdue. Please return it to the sports store.`
      : `Issue ${d.ref} to ${d.recipientName} is ${days} overdue (due ${formatDate(d.dueDate)}). This was the final automatic reminder to the recipient.`;
  const text = `${intro}\n\n${items}\n\nIssue reference: ${d.ref}\nIssued by: ${d.issuedByName}\n\n${d.appOrigin}\n`;
  const html =
    `<p>${esc(intro)}</p><ul>${d.lines.map((l) => `<li>${esc(l.name)} (${esc(l.code)}): ${l.qty} ${esc(l.unit)}${l.qty === 1 ? "" : "s"}</li>`).join("")}</ul>` +
    `<p>Issue reference: <b>${esc(d.ref)}</b><br>Issued by: ${esc(d.issuedByName)}</p><p><a href="${esc(d.appOrigin)}">${esc(d.appOrigin)}</a></p>`;
  const subject =
    audience === "recipient"
      ? `${d.final ? "Final reminder" : "Reminder"}: sports equipment ${d.ref} is ${days} overdue`
      : `Overdue: ${d.ref} (${d.recipientName}), ${days}`;
  return { subject, text, html };
}
