"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api<{ resendAfterSec: number }>("/api/auth/request-otp", { method: "POST", body: { email } });
      setStep("code");
      setResendIn(r.resendAfterSec);
      setInfo(`We emailed a 6-digit code to ${email.trim().toLowerCase()}. It expires in 10 minutes.`);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.message);
      if (typeof e2.data.retryAfterSec === "number") setResendIn(e2.data.retryAfterSec);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ home?: string }>("/api/auth/verify-otp", { method: "POST", body: { email, code } });
      // Go straight to the role's home (FR Sports -> admin dashboard). Only same-site paths are accepted.
      const home = typeof r.home === "string" && /^\/[a-z/]*$/.test(r.home) ? r.home : "/";
      router.replace(home);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form onSubmit={sendCode} noValidate>
        <label htmlFor="email">University email</label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="name@vitbhopal.ac.in"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !email.includes("@")}>
          {busy ? "Sending…" : "Send sign-in code"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} noValidate>
      {info && <p className="muted">{info}</p>}
      <label htmlFor="code">6-digit code</label>
      <input
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        autoFocus
      />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || code.length !== 6}>
        {busy ? "Checking…" : "Sign in"}
      </button>
      <div className="row" style={{ justifyContent: "space-between", marginTop: "0.75rem" }}>
        <button type="button" className="link" onClick={() => { setStep("email"); setCode(""); setError(null); }}>
          Use a different email
        </button>
        <button type="button" className="link" disabled={busy || resendIn > 0} onClick={() => sendCode()}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
        </button>
      </div>
    </form>
  );
}
