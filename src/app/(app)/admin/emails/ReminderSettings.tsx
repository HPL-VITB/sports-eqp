"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

type S = { firstAfterDays: number; everyDays: number; max: number };

export function ReminderSettings({ initial }: { initial: S }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const field = (k: keyof S, label: string) => (
    <div>
      <label htmlFor={k}>{label}</label>
      <input id={k} inputMode="numeric" value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value.replace(/\D/g, "") || 0) })} />
    </div>
  );
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/api/settings/reminders", { method: "PUT", body: s });
          setMsg({ kind: "success", text: "Saved." });
        } catch (err) {
          setMsg({ kind: "error", text: (err as ApiError).message });
        }
      }}
    >
      <strong>Overdue reminder emails</strong>
      <p className="muted">
        Sent each morning at 09:00 IST. The last reminder is copied to the staff member who issued the equipment. Set the maximum to 0
        to stop reminders.
      </p>
      <div className="grid2">
        {field("firstAfterDays", "First reminder, days after due date")}
        {field("everyDays", "Then every … days")}
        {field("max", "Maximum reminders")}
      </div>
      {msg && <p className={msg.kind}>{msg.text}</p>}
      <button type="submit" className="secondary" style={{ marginTop: "0.75rem" }}>Save schedule</button>
    </form>
  );
}
