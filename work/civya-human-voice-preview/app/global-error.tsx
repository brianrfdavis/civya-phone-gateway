"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main id="main" className="cv-staff-gate">
          <h1>Civya could not open.</h1>
          <p role="alert">
            No new action has been confirmed. Try loading Civya again, or return to the Civya home page.
          </p>
          <div className="cv-staff-gate-actions">
            <button className="cv-btn cv-btn-primary" type="button" onClick={reset}>Try again</button>
            <a className="cv-btn cv-btn-ghost" href="/">Return home</a>
          </div>
        </main>
      </body>
    </html>
  );
}
