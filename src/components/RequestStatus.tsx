const LABEL: Record<string, string> = {
  PENDING: "Pending",
  ISSUED: "Approved and issued",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
};
const COLOR: Record<string, string> = {
  PENDING: "var(--accent)",
  ISSUED: "var(--ok)",
  REJECTED: "var(--danger)",
  CANCELLED: "var(--muted)",
  RETURNED: "var(--muted)",
};

export function RequestStatus({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) {
    return <span className="badge" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Overdue</span>;
  }
  return <span className="badge" style={{ color: COLOR[status], borderColor: COLOR[status] }}>{LABEL[status] ?? status}</span>;
}
