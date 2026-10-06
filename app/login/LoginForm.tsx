"use client";

import { useState } from "react";

export default function LoginForm({ next }: { next: string }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: object) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await post("/api/auth/request", { email });
      setDevCode(data.devCode ?? "");
      setCode("");
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/api/auth/verify", { email, code });
      // Full navigation so the server-rendered header picks up the new session.
      window.location.assign(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="home-grid" style={{ maxWidth: 400 }}>
      <section className="hero" style={{ paddingBottom: 0 }}>
        <h1>Sign in to SplitApp</h1>
        <p>{step === "email" ? "We'll email you a 6-digit code. No password needed." : `Enter the code we sent to ${email}.`}</p>
      </section>

      {step === "email" ? (
        <form className="card stack" onSubmit={requestCode}>
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" autoFocus required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form className="card stack" onSubmit={verify}>
          <div>
            <label htmlFor="code">Sign-in code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="123456"
              style={{ fontSize: "1.4rem", letterSpacing: "0.3em", textAlign: "center" }}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {devCode && (
            <p className="banner" style={{ margin: 0 }}>
              Dev mode, email isn&apos;t configured. Your code is <b>{devCode}</b>
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <div className="row between small">
            <button type="button" className="btn ghost sm" onClick={() => { setStep("email"); setError(""); }}>
              ← Different email
            </button>
            <button type="button" className="btn ghost sm" onClick={() => requestCode()} disabled={busy}>
              Resend code
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
