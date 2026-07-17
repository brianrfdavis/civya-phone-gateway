"use client";

import Link from "next/link";
import { IconGauge, IconHome, IconList, IconShield, IconUsers } from "./icons";

/** Internal staff layout: quiet sidebar + operational main area. */
export function StaffShell({
  active,
  title,
  subtitle,
  actions,
  workspace,
  children,
}: {
  active: "dashboard" | "operations" | "review" | "results";
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  workspace?: { name?: string; fictional: boolean; environment?: string };
  children: React.ReactNode;
}) {
  const signOut = async () => {
    await fetch("/api/staff/auth/sign-out", { method: "POST" }).catch(() => undefined);
    window.location.assign("/staff/sign-in");
  };

  return (
    <div className="cv-staff">
      <aside className="cv-staff-side">
        <Link href="/staff" className="cv-staff-brand" aria-label="Civya staff home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/civya-logo.png" alt="Civya" />
          <span>Staff</span>
        </Link>
        <nav className="cv-staff-nav" aria-label="Staff">
          <Link href="/staff" data-active={active === "dashboard"}>
            <IconUsers size={16} /> Dashboard
          </Link>
          <Link href="/admin/review" data-active={active === "review"}>
            <IconList size={16} /> Review queue
          </Link>
          <Link href="/staff/operations" data-active={active === "operations"}>
            <IconShield size={16} /> Operations
          </Link>
          <Link href="/results" data-active={active === "results"}>
            <IconGauge size={16} /> Reports
          </Link>
          <Link href="/">
            <IconHome size={16} /> Resident view
          </Link>
        </nav>
        <p style={{ marginTop: "auto", fontSize: "0.74rem", color: "var(--cv-faint)" }}>
          {workspace?.fictional
            ? "Protected fictional sandbox — access is limited to invited reviewers and administrators."
            : `Protected county workspace${workspace?.name ? ` for ${workspace.name}` : ""} — access is limited to authorized staff.`}
        </p>
        <button className="cv-staff-signout" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </aside>
      <main className="cv-staff-main" id="main">
        <div className="cv-staff-title">
          <div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}
