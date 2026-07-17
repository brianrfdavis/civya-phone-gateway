import Link from "next/link";
import { getRuntimeConfig } from "@/lib/config/runtime";

export const dynamic = "force-dynamic";

export default function AccessPage() {
  const sandbox = getRuntimeConfig().syntheticMode;
  return (
    <main id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <section className="conversation-shell" style={{ maxWidth: 620, textAlign: "center", padding: "2.5rem" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/civya-logo.png" alt="Civya" style={{ width: 150, height: "auto" }} />
        <h1 style={{ marginTop: "1.5rem" }}>{sandbox ? "County demonstration" : "Open Civya"}</h1>
        {sandbox ? (
          <>
            <p>
              This fictional sandbox is available through an expiring county invitation.
              Open the invitation link you received to continue—there is no separate login wall.
            </p>
            <p style={{ fontSize: ".9rem", opacity: .75 }}>
              No real resident information or real county transactions should be entered here.
            </p>
          </>
        ) : (
          <p>
            Invitation links are not used for this controlled launch. Return to Civya to sign in or ask for help.
          </p>
        )}
        <Link href="/" className="secondary-button">{sandbox ? "Try again" : "Return to Civya"}</Link>
      </section>
    </main>
  );
}
