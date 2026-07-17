"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StaffShell } from "../components/staff-shell";
import { SiteHeader } from "../components/site-header";
import { IconAlert, IconArrowRight, IconShield } from "../components/icons";

interface StaffCase {
  id?: string;
  case_id?: string;
  resident_name?: string;
  property_address?: string;
  status?: string;
  urgency?: string;
  next_best_action?: string;
  updated_at?: string;
}

interface ReviewTask {
  id?: string;
  task_id?: string;
  priority?: string;
  reason?: string;
  status?: string;
  resident_name?: string;
}

interface StaffBootstrap {
  authorized?: boolean;
  staff?: { name?: string; email?: string; role?: "reviewer" | "admin" | string };
  tenant?: { name?: string; slug?: string; environment?: string; fictional?: boolean };
  cases?: StaffCase[];
  review_tasks?: ReviewTask[];
  reviews?: ReviewTask[];
  metrics?: {
    active_cases?: number;
    review_queue?: number;
    documents_needing_review?: number;
    verified_outcomes?: number;
  };
  workspace?: { environment?: string; fictional?: boolean };
  activation?: { county_source?: string; payment_handoff?: string; identity_proofing?: string };
  error?: string;
}

function prettify(value?: string): string {
  return (value ?? "unknown").replace(/_/g, " ");
}

export default function StaffPage() {
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [data, setData] = useState<StaffBootstrap | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/bootstrap", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json().catch(() => ({}))) as StaffBootstrap;
      if (response.status === 401 || response.status === 403 || payload.authorized === false) {
        setMessage(payload.error ?? "This staff view is available only to authorized staff for this county workspace.");
        setState("denied");
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "The staff dashboard could not be loaded.");
      setData(payload);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The staff dashboard could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state !== "ready" || !data) {
    return (
      <div className="cv-page">
        <div className="cv-container">
          <SiteHeader nav={<Link href="/">Resident view</Link>} />
          <main id="main" className="cv-staff-gate">
            <span className="cv-staff-gate-icon" aria-hidden="true"><IconShield size={26} /></span>
            {state === "loading" ? (
              <>
                <h1>Checking your staff access…</h1>
                <p role="status">One moment.</p>
              </>
            ) : (
              <>
                <h1>{state === "denied" ? "Staff authorization required" : "Staff view unavailable"}</h1>
                <p role="alert">{message}</p>
                <p>
                  Staff access is limited to authorized reviewers and administrators for this hostname.
                  Resident conversations remain available without staff access.
                </p>
                <div className="cv-staff-gate-actions">
                  {state === "denied" && (
                    <Link className="cv-btn cv-btn-primary" href="/staff/sign-in">Sign in with authorized email</Link>
                  )}
                  <Link className="cv-btn cv-btn-ghost" href="/">Return to resident view</Link>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    );
  }

  const cases = data.cases ?? [];
  const reviews = data.review_tasks ?? data.reviews ?? [];
  const metrics = data.metrics ?? {};
  const fictional = data.tenant?.fictional === true || data.workspace?.fictional === true;

  return (
    <StaffShell
      active="dashboard"
      title={data.tenant?.name ? `${data.tenant.name}${fictional ? " demo" : ""} workspace` : "County workspace"}
      subtitle={`Signed in as ${data.staff?.name ?? data.staff?.email ?? "authorized staff"} · ${prettify(data.staff?.role)}`}
      workspace={{
        name: data.tenant?.name,
        fictional,
        environment: data.tenant?.environment ?? data.workspace?.environment,
      }}
    >
      <p className="cv-disclaimer" role="note">
        {fictional
          ? "County sandbox only — every case, document, review, reminder, submission, and payment shown here is fictional and simulated."
          : "Operational county workspace. Access is tenant-bound; provider-backed actions remain unavailable until their contracted integrations are activated."}
      </p>
      <div className="cv-stats">
        <div className="cv-stat">
          <div className="label">Active cases</div>
          <div className="value">{metrics.active_cases ?? cases.length}</div>
          <div className="sub">{fictional ? "fictional demo cases" : "tenant-bound case records"}</div>
        </div>
        <div className="cv-stat">
          <div className="label">Review queue</div>
          <div className="value warn">{metrics.review_queue ?? reviews.length}</div>
          <div className="sub">waiting for a person</div>
        </div>
        <div className="cv-stat">
          <div className="label">Document review</div>
          <div className="value warn">{metrics.documents_needing_review ?? 0}</div>
          <div className="sub">uncertain extractions</div>
        </div>
        <div className="cv-stat">
          <div className="label">{fictional ? "Verified test outcomes" : "Verified outcomes"}</div>
          <div className="value good">{metrics.verified_outcomes ?? 0}</div>
          <div className="sub">{fictional ? "source-backed; fictional sandbox" : "authoritative evidence only"}</div>
        </div>
      </div>

      <div className="cv-staff-grid">
        <section aria-labelledby="staff-cases-title">
          <h2 id="staff-cases-title" className="cv-section-title">Recent cases</h2>
          <div className="cv-table-wrap">
            <table className="cv-table">
              <thead>
                <tr>
                  <th scope="col">Resident</th>
                  <th scope="col">Property</th>
                  <th scope="col">Status</th>
                  <th scope="col">Next step</th>
                  <th scope="col">Case</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((item) => {
                  const id = item.id ?? item.case_id;
                  return (
                    <tr key={id}>
                      <td>{item.resident_name ?? "Resident"}</td>
                      <td>{item.property_address ?? "Not collected"}</td>
                      <td>
                        <span className="cv-tag teal">{prettify(item.status)}</span>{" "}
                        {item.urgency === "urgent" && <span className="cv-tag red">urgent</span>}
                      </td>
                      <td className="clamp">{item.next_best_action ?? "Continue review"}</td>
                      <td>{id ? <Link href={`/case/${id}`}>open</Link> : "—"}</td>
                    </tr>
                  );
                })}
                {cases.length === 0 && (
                  <tr><td className="cv-empty" colSpan={5}>No {fictional ? "fictional " : ""}cases are active.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside>
          <div className="cv-card" aria-labelledby="staff-review-title">
            <h2 id="staff-review-title">Review queue</h2>
            {reviews.length === 0 ? (
              <p className="hint">Nothing is waiting for review.</p>
            ) : (
              <ul className="cv-alerts">
                {reviews.slice(0, 6).map((task) => (
                  <li key={task.id ?? task.task_id}>
                    <IconAlert />
                    <span>
                      <strong>{task.resident_name ?? "Resident"}</strong><br />
                      {task.reason ?? "Review requested"}
                    </span>
                    <span className={`cv-tag ${task.priority === "urgent" ? "red" : "amber"}`}>
                      {prettify(task.priority)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p>
              <Link href="/admin/review">Open review queue <IconArrowRight size={13} /></Link>
            </p>
          </div>
        </aside>
      </div>
    </StaffShell>
  );
}
