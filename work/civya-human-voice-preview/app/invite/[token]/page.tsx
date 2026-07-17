"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [error, setError] = useState("");
  const [sandbox, setSandbox] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const runtimeResponse = await fetch("/api/runtime", { cache: "no-store" });
        const runtime = await runtimeResponse.json().catch(() => ({})) as {
          environment?: string;
          syntheticMode?: boolean;
          error?: string;
        };
        if (!runtimeResponse.ok) throw new Error(runtime.error || "Civya could not check this link safely.");
        const fictional = runtime.syntheticMode === true && runtime.environment !== "production";
        if (!active) return;
        setSandbox(fictional);
        if (!fictional) {
          setError("Invitation links are not available for this controlled launch.");
          return;
        }
        const response = await fetch("/api/invitations/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(result.error || "This invitation could not be opened.");
        window.location.replace("/");
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "This invitation could not be opened.");
      }
    })();
    return () => { active = false; };
  }, [token]);

  return (
    <main id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <section className="conversation-shell" style={{ maxWidth: 620, textAlign: "center", padding: "2.5rem" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/civya-logo.png" alt="Civya" style={{ width: 150, height: "auto" }} />
        <h1 style={{ marginTop: "1.5rem" }}>
          {error
            ? "Invitation could not be opened"
            : sandbox === true
              ? "Opening the county demo…"
              : sandbox === false
                ? "Invitation unavailable"
                : "Checking this link…"}
        </h1>
        {error ? (
          <p role="alert">
            {error} {sandbox === true ? "Ask the demo coordinator for a fresh invitation." : "Return to Civya to sign in or ask for help."}
          </p>
        ) : sandbox === true ? (
          <p role="status">Your invitation is being exchanged securely. No separate demo login is needed.</p>
        ) : (
          <p role="status">Civya is checking whether this link is available here.</p>
        )}
        <p style={{ fontSize: ".9rem", opacity: .75 }}>
          {sandbox === true
            ? "Fictional sandbox only—do not enter real resident information."
            : "No County case has been opened or changed from this page."}
        </p>
        {error && (
          <p style={{ marginTop: "1.25rem" }}>
            <Link className="cv-btn cv-btn-primary" href={sandbox === true ? "/access" : "/"}>
              {sandbox === true ? "Return to access instructions" : "Return to Civya"}
            </Link>
          </p>
        )}
      </section>
    </main>
  );
}
