"use client";

import Link from "next/link";
import { SiteHeader } from "@/app/components/site-header";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="cv-page">
      <div className="cv-container">
        <SiteHeader nav={<Link href="/">Civya home</Link>} />
        <main id="main" className="cv-staff-gate">
          <h1>That page did not finish loading.</h1>
          <p role="alert">
            This attempt did not confirm a new action. Try the page again, or return to the Civya home page.
          </p>
          <div className="cv-staff-gate-actions">
            <button className="cv-btn cv-btn-primary" type="button" onClick={reset}>Try again</button>
            <Link className="cv-btn cv-btn-ghost" href="/">Return home</Link>
          </div>
        </main>
      </div>
    </div>
  );
}
