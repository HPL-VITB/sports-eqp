"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CommitResult, PlanRow, PlanSummary } from "@/server/inventory/import";

type Preview = { batchId: string; filename: string; plan: PlanRow[]; summary: PlanSummary; unknownHeaders: string[]; canCommit: boolean };

const ACTION_LABEL: Record<string, string> = {
  NEW_ITEM: "New equipment",
  ADD_STOCK: "Add stock",
  MERGED: "Combined",
  ERROR: "Error",
};

export function ImportWizard() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setDone(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/preview", { method: "POST", body: form, credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.error?.code ?? "ERROR", data.error?.message ?? "Upload failed.");
      setPreview(data as Preview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    const s = preview.summary;
    if (!window.confirm(`Import ${s.newItems} new item(s) and ${s.stockAdditions} stock addition(s), ${s.totalQty} units in total?`)) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await api<CommitResult>(`/api/import/${preview.batchId}/commit`, { method: "POST" }));
      setPreview(null);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="panel">
        <p className="success"><strong>Imported.</strong> {done.createdItems.length} new item(s), {done.stockAdded.length} stock addition(s), {done.totalQty} units.</p>
        {done.createdCategories.length > 0 && <p>New categories: {done.createdCategories.join(", ")}</p>}
        {done.createdItems.length > 0 && (
          <p>New codes: {done.createdItems.map((c) => `${c.code} (${c.name})`).join(", ")}</p>
        )}
        <div className="row">
          <Link className="button" href="/inventory">Go to inventory</Link>
          <button type="button" className="secondary" onClick={() => { setDone(null); setFile(null); }}>Import another file</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <form onSubmit={upload} className="panel row">
        <input
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
          style={{ maxWidth: 360 }}
          aria-label="Spreadsheet file"
        />
        <button type="submit" disabled={!file || busy}>{busy && !preview ? "Checking…" : "Upload and preview"}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}

      {preview && (
        <>
          <div className="panel">
            <strong>{preview.filename}</strong>: {preview.summary.rows} row(s) — {preview.summary.newItems} new item(s), {preview.summary.stockAdditions} stock
            addition(s), {preview.summary.merged} combined, {preview.summary.totalQty} units.
            {preview.summary.newCategories.length > 0 && <> New categories: {preview.summary.newCategories.join(", ")}.</>}
            {preview.unknownHeaders.length > 0 && <p className="muted">Ignored columns: {preview.unknownHeaders.join(", ")}</p>}
            {preview.summary.errors > 0 ? (
              <p className="error"><strong>{preview.summary.errors} row(s) have errors.</strong> Fix them in the file and upload it again. Nothing has been imported.</p>
            ) : (
              <p className="row" style={{ marginTop: "0.5rem" }}>
                <button type="button" onClick={confirm} disabled={busy}>{busy ? "Importing…" : "Confirm import"}</button>
                <span className="muted">Nothing has changed yet.</span>
              </p>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Action</th>
                <th>Equipment</th>
                <th>Sport / category</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {preview.plan.map((r) => (
                <tr key={r.row} className={r.action === "ERROR" ? "err" : r.action === "MERGED" ? "merged" : undefined}>
                  <td data-label="Row">{r.row}</td>
                  <td data-label="Action">{ACTION_LABEL[r.action]}</td>
                  <td data-label="Equipment">{r.itemCode ? `${r.itemCode} · ` : ""}{r.name}{r.brand ? ` (${r.brand})` : ""}</td>
                  <td data-label="Sport">{r.sport ? `${r.sport} › ${r.category ?? ""}` : ""}</td>
                  <td data-label="Qty" style={{ textAlign: "right" }}>{r.action === "MERGED" ? "—" : r.qty}</td>
                  <td data-label="Notes">{[...r.errors, ...r.notes].join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
