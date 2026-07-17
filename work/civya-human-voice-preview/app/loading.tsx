import { SiteHeader } from "@/app/components/site-header";

export default function Loading() {
  return (
    <div className="cv-page">
      <div className="cv-container">
        <SiteHeader />
        <main id="main" className="cv-staff-gate" aria-busy="true">
          <h1>Loading Civya…</h1>
          <p role="status">Your page is on its way. No action is complete until Civya confirms it.</p>
        </main>
      </div>
    </div>
  );
}
