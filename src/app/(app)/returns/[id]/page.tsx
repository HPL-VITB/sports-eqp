import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { requirePermissionPage } from "@/server/next-session";
import { getIssue } from "@/server/returns/returns";
import { getAppContext } from "@/server/runtime";
import { formatDate, formatDateTimeIST } from "@/server/time";
import { ReturnForm } from "./ReturnForm";

export const dynamic = "force-dynamic";

export default async function ReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermissionPage("return.record");
  const { id } = await params;
  let issue;
  try {
    issue = await getIssue(getAppContext(), user, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <p><Link href="/returns">← Returns</Link></p>
      <h1>Return {issue.ref}</h1>
      <div className="panel">
        <strong>{issue.recipient.name}</strong> <span className="muted">{issue.recipient.univId} · {issue.recipient.email}</span>
        {issue.groupName && <div>For: {issue.groupName}</div>}
        <div>
          Issued {formatDateTimeIST(issue.issuedAt)} by {issue.issuedBy} (approved by {issue.approvedBy}). Due{" "}
          <span className={issue.overdue ? "error" : undefined}>{formatDate(issue.dueDate)}{issue.overdue && `, ${issue.daysOverdue} day(s) late`}</span>.
        </div>
      </div>
      {issue.status === "RETURNED" ? (
        <>
          <p className="success">Returned {formatDateTimeIST(issue.returnedAt!)}, received by {issue.receivedBy}.</p>
          <table>
            <thead><tr><th>Equipment</th><th>Issued</th><th>Usable</th><th>Damaged</th><th>Missing</th><th>Used up</th><th>Note</th></tr></thead>
            <tbody>
              {issue.lines.map((l) => (
                <tr key={l.itemId}>
                  <td data-label="Equipment">{l.name} <span className="muted">{l.code}</span></td>
                  <td data-label="Issued">{l.qty}</td>
                  <td data-label="Usable">{l.returned?.usable}</td>
                  <td data-label="Damaged">{l.returned?.damaged}</td>
                  <td data-label="Missing">{l.returned?.missing}</td>
                  <td data-label="Used up">{l.returned?.consumed}</td>
                  <td data-label="Note">{l.returned?.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {issue.returnRemarks && <p>Remarks: {issue.returnRemarks}</p>}
          {issue.returnPhotoId && <p><a href={`/api/photos/${issue.returnPhotoId}`} target="_blank" rel="noreferrer">View photo</a></p>}
        </>
      ) : (
        <ReturnForm issue={issue} />
      )}
    </>
  );
}
