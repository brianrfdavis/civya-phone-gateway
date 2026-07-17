"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SiteHeader } from "@/app/components/site-header";
import styles from "../../launch.module.css";

type State = "ready" | "working" | "complete" | "unavailable";

export default function PhoneResumePage() {
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>("ready");
  const [message, setMessage] = useState("Select continue to use this one-time link.");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const value = fragment.get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) setToken(value);
    else {
      setState("unavailable");
      setMessage("This secure link is incomplete. Request a new link or ask for a person.");
    }
  }, []);

  async function continueSecurely() {
    if (!token || state !== "ready") return;
    setState("working");
    setMessage("Checking your one-time link…");
    try {
      const response = await fetch("/api/secure-links/phone-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = await response.json() as { consumed?: boolean; message?: string };
      setToken("");
      setState(result.consumed ? "complete" : "unavailable");
      setMessage(result.message || "This link is no longer available.");
    } catch {
      setState("unavailable");
      setMessage("Civya couldn't check the link safely. Request a new link or ask for a person.");
    }
  }

  return (
    <div className={styles.page}>
      <div className="cv-container">
        <SiteHeader right={<span className="cv-tag teal">Secure continuation</span>} />
        <main id="main" className={styles.main}>
          <section className={styles.hero}>
            <p className={styles.eyebrow}>One-time Civya link</p>
            <h1>Continue safely from your call.</h1>
            <p className={styles.lede}>{message}</p>
            <p className={styles.notice} role="note">
              This link does not verify your identity or open a County case. Civya will never ask for a card number,
              bank login, password, or security code by text message.
            </p>
            <div className={styles.actions}>
              {state === "ready" || state === "working" ? (
                <button className="cv-btn cv-btn-primary" type="button" onClick={continueSecurely} disabled={!token || state === "working"}>
                  {state === "working" ? "Checking…" : "Continue securely"}
                </button>
              ) : (
                <Link className="cv-btn cv-btn-primary" href="/?help=human">Continue to Civya</Link>
              )}
              <Link className="cv-btn cv-btn-ghost" href="/trust">How Civya protects you</Link>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
