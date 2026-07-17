"use client";

import Link from "next/link";
import { IconMapPin } from "./icons";

/**
 * Quiet resident-facing header: brand, jurisdiction context, calm nav.
 * `nav` lets pages swap the center links (e.g. the case page shows
 * "Back to Civya").
 */
export function SiteHeader({
  nav,
  right,
}: {
  nav?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header className="cv-header">
      <Link href="/" className="cv-logo" aria-label="Civya home">
        <svg className="cv-logo-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M27.5 7.3A14.7 14.7 0 1 0 29 32" stroke="currentColor" strokeWidth="4.3" strokeLinecap="round" />
          <path d="M18 11.1a10.5 10.5 0 0 0 0 17.8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity=".34" />
          <circle cx="29.4" cy="8" r="3.2" fill="#F5A623" />
          <path d="m27 29.2 3.4 3.2 4.8-6.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="cv-wordmark">Civya</span>
      </Link>
      <div className="cv-header-center">
        <span className="cv-county">
          <IconMapPin /> Wayne County, MI
        </span>
        <nav className="cv-nav" aria-label="Site">
          {nav ?? (
            <>
              <a href="#about">About Civya</a>
              <a href="#help">Help</a>
            </>
          )}
        </nav>
      </div>
      <div className="cv-header-right">{right}</div>
    </header>
  );
}
