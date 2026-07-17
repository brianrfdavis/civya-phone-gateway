"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { IconShield } from "../../components/icons";
import { SiteHeader } from "../../components/site-header";

type Step = "email" | "sending" | "code" | "verifying";

interface ApiResponse {
  ok?: boolean;
  challenge_id?: string;
  message?: string;
  redirect_to?: string;
  error?: string;
}

interface WorkspaceContext {
  name?: string;
  slug?: string;
  environment?: string;
  fictional?: boolean;
}

export default function StaffSignInPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);

  useEffect(() => {
    void fetch("/api/staff/context", { cache: "no-store", headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("workspace unavailable")))
      .then((payload) => setWorkspace(payload.workspace ?? null))
      .catch(() => setWorkspace(null));
  }, []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStep("sending");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/staff/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok || !payload.challenge_id) {
        throw new Error(payload.error || "A code could not be requested right now.");
      }
      setChallengeId(payload.challenge_id);
      setNotice(payload.message || "If this is an authorized staff email, a six-digit code is on its way.");
      setStep("code");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "A code could not be requested right now.");
      setStep("email");
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.length !== 6) return;
    setStep("verifying");
    setError("");
    try {
      const response = await fetch("/api/staff/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, code, challenge_id: challengeId }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "The code could not be verified.");
      }
      window.location.assign(payload.redirect_to || "/staff");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The code could not be verified.");
      setStep("code");
    }
  }

  const enteringCode = step === "code" || step === "verifying";

  return (
    <div className="cv-page">
      {workspace?.fictional && (
        <div className="cv-banner" role="note">
          Demonstration only — fictional data. Not an official government service.
        </div>
      )}
      <div className="cv-container">
        <SiteHeader nav={<Link href="/">Resident view</Link>} />
        <main id="main" className="cv-staff-gate cv-staff-sign-in">
          <span className="cv-staff-gate-icon" aria-hidden="true"><IconShield size={26} /></span>
          <h1>{workspace?.fictional ? "County-demo staff sign in" : "County staff sign in"}</h1>
          <p>
            Use the email address tied to your authorized reviewer or administrator account
            {workspace?.name ? ` for ${workspace.name}` : ""}.
            Civya will send a six-digit code; it will not create a new account.
          </p>
          {workspace?.fictional ? (
            <p className="cv-staff-sign-in-note">
              This protected workspace contains fictional cases and simulated county activity only.
            </p>
          ) : (
            <p className="cv-staff-sign-in-note">
              Access is tenant-bound, audited, and limited to confirmed staff accounts for this hostname.
            </p>
          )}

          {!enteringCode ? (
            <form className="cv-auth-form" onSubmit={start}>
              <label htmlFor="staff-email">Authorized staff email</label>
              <div className="cv-auth-field-row">
                <input
                  id="staff-email"
                  className="cv-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="reviewer@example.gov"
                  required
                />
                <button className="cv-btn cv-btn-primary" type="submit" disabled={step === "sending"}>
                  {step === "sending" ? "Sending…" : "Send code"}
                </button>
              </div>
            </form>
          ) : (
            <form className="cv-auth-form" onSubmit={verify}>
              <div className="cv-auth-code-heading">
                <label htmlFor="staff-code">Six-digit code</label>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setChallengeId("");
                    setNotice("");
                    setError("");
                  }}
                >
                  Change email
                </button>
              </div>
              <p className="cv-auth-sent">Code requested for {email}</p>
              <div className="cv-auth-field-row">
                <input
                  id="staff-code"
                  className="cv-input cv-code-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  aria-describedby="staff-code-help"
                  autoFocus
                  required
                />
                <button
                  className="cv-btn cv-btn-primary"
                  type="submit"
                  disabled={step === "verifying" || code.length !== 6}
                >
                  {step === "verifying" ? "Checking…" : "Open staff view"}
                </button>
              </div>
              <span id="staff-code-help" className="visually-hidden">Enter the six digits sent to your email.</span>
            </form>
          )}

          {notice && <p className="cv-auth-sent cv-staff-auth-status" role="status" aria-live="polite">{notice}</p>}
          {error && <p className="cv-auth-error" role="alert">{error}</p>}

          <div className="cv-staff-gate-actions">
            <Link className="cv-btn cv-btn-ghost" href="/">Return to resident view</Link>
          </div>
        </main>
      </div>
    </div>
  );
}
