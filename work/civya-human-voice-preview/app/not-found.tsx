import Link from "next/link";
import { SiteHeader } from "@/app/components/site-header";

export default function NotFound() {
  return (
    <div className="cv-page">
      <div className="cv-container">
        <SiteHeader nav={<Link href="/services">Planned help paths</Link>} />
        <main id="main" className="cv-staff-gate">
          <h1>We could not find that page.</h1>
          <p>The link may be old or incomplete. No action was submitted from this page.</p>
          <div className="cv-staff-gate-actions">
            <Link className="cv-btn cv-btn-primary" href="/">Return home</Link>
            <Link className="cv-btn cv-btn-ghost" href="/services">See planned help paths</Link>
          </div>
        </main>
      </div>
    </div>
  );
}
