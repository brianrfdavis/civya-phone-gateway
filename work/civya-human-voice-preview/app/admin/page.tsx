"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { StaffShell } from "../components/staff-shell";
import { IconAlert, IconArrowRight } from "../components/icons";

interface CaseRow {
  case_id: string;
  resident_name: string;
  contact: string;
  property_address: string;
  status: string;
  urgency: string;
  pathway: string;
  intake: string;
  missing_count: number;
  uploaded_count: number;
  packet_ready: boolean;
  submission_status: string;
  payment_status: string;
  confirmation: string;
  review_required: boolean;
  next_best_action: string;
  last_activity: string;
}

interface ReviewRow {
  task_id: string;
  priority: string;
  status: string;
  resident_name: string;
  reason: string;
}

interface InvitationResponse {
  invite_path?: string;
  expires_at?: string;
  error?: string;
}

const SANDBOX_COMPLETED = new Set(["simulated_submitted", "simulated_payment_completed", "closed"]);

function prettify(v?: string): string {
  return (v ?? "").replace(/_/g, " ");
}

export default function AdminPage() {
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [tasks, setTasks] = useState<ReviewRow[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [staffRole, setStaffRole] = useState<"reviewer" | "admin" | null>(null);
  const [workspace, setWorkspace] = useState<{ name?: string; environment?: string; fictional: boolean } | null>(null);
  const [invitationLabel, setInvitationLabel] = useState("County resident demo");
  const [invitationMinutes, setInvitationMinutes] = useState(240);
  const [invitationMaxUses, setInvitationMaxUses] = useState(1);
  const [invitationLink, setInvitationLink] = useState("");
  const [invitationExpiresAt, setInvitationExpiresAt] = useState("");
  const [invitationStatus, setInvitationStatus] = useState("");
  const [invitationError, setInvitationError] = useState("");
  const [creatingInvitation, setCreatingInvitation] = useState(false);

  const load = () =>
    Promise.all([
      fetch("/api/admin/cases")
        .then((r) => r.json())
        .then((d) => setRows(d.cases ?? [])),
      fetch("/api/admin/review")
        .then((r) => r.json())
        .then((d) => setTasks(d.tasks ?? [])),
    ]).catch(() => {});

  useEffect(() => {
    void load();
    const t = setInterval(load, 7000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void fetch("/api/staff/bootstrap", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => {
        const role = payload?.staff?.role;
        setStaffRole(role === "admin" || role === "reviewer" ? role : null);
        setWorkspace(payload?.tenant ? {
          name: payload.tenant.name,
          environment: payload.tenant.environment,
          fictional: payload.tenant.fictional === true,
        } : null);
      })
      .catch(() => {
        setStaffRole(null);
        setWorkspace(null);
      });
  }, []);

  const seed = async () => {
    setSeeding(true);
    await fetch("/api/admin/seed", { method: "POST" });
    await load();
    setSeeding(false);
  };

  const createInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingInvitation(true);
    setInvitationError("");
    setInvitationStatus("");
    setInvitationLink("");
    setInvitationExpiresAt("");

    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          label: invitationLabel,
          expires_in_minutes: invitationMinutes,
          max_uses: invitationMaxUses,
          scopes: ["resident_demo"],
        }),
      });
      const payload = (await response.json()) as InvitationResponse;
      if (!response.ok || !payload.invite_path || !payload.expires_at) {
        throw new Error(payload.error || "The invitation could not be created.");
      }
      setInvitationLink(`${window.location.origin}${payload.invite_path}`);
      setInvitationExpiresAt(payload.expires_at);
      setInvitationStatus("Invitation created. Copy the private link now.");
    } catch (error) {
      setInvitationError(error instanceof Error ? error.message : "The invitation could not be created.");
    } finally {
      setCreatingInvitation(false);
    }
  };

  const copyInvitation = async () => {
    setInvitationError("");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is not available in this browser.");
      await navigator.clipboard.writeText(invitationLink);
      setInvitationStatus("Invitation link copied.");
    } catch (error) {
      setInvitationStatus("");
      setInvitationError(error instanceof Error ? error.message : "Copy failed. Select and copy the link manually.");
    }
  };

  const fictional = workspace?.fictional === true;
  const completedStatuses = fictional ? SANDBOX_COMPLETED : new Set(["closed"]);
  const total = rows.length;
  const completed = rows.filter((r) => completedStatuses.has(r.status)).length;
  const inReview = rows.filter((r) => r.review_required).length;
  const active = total - completed;
  const urgent = rows.filter((r) => r.urgency === "urgent").length;
  const missingDocs = rows.reduce((n, r) => n + r.missing_count, 0);
  const openTasks = tasks.filter((t) => t.status === "open" || t.status === "in_review");

  return (
    <StaffShell
      active="dashboard"
      title="Case dashboard"
      subtitle={fictional ? "All resident cases in this fictional demo environment." : "Tenant-bound resident cases for authorized County review."}
      workspace={workspace ?? { fictional: false }}
      actions={fictional && staffRole === "admin" ? (
        <button className="cv-btn cv-btn-primary cv-btn-sm" onClick={() => void seed()} disabled={seeding}>
          {seeding ? "Seeding…" : "Load demo scenarios"}
        </button>
      ) : undefined}
    >
      <div className="cv-stats">
        <div className="cv-stat">
          <div className="label">Total cases</div>
          <div className="value">{total}</div>
          <div className="sub">{fictional ? "all time (demo)" : "current tenant records"}</div>
        </div>
        <div className="cv-stat">
          <div className="label">Active cases</div>
          <div className="value">{active}</div>
          <div className="sub">in progress now</div>
        </div>
        <div className="cv-stat">
          <div className="label">Closed workflows</div>
          <div className="value good">{completed}</div>
          <div className="sub">submitted or administratively closed</div>
        </div>
        <div className="cv-stat">
          <div className="label">In review</div>
          <div className="value warn">{inReview}</div>
          <div className="sub">flagged for a human</div>
        </div>
      </div>

      <div className="cv-staff-grid">
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="cv-section-title">
            Recent cases
          </h2>
          <div className="cv-table-wrap">
            <table className="cv-table">
              <thead>
                <tr>
                  <th scope="col">Resident</th>
                  <th scope="col">Address</th>
                  <th scope="col">Status</th>
                  <th scope="col">Pathway</th>
                  <th scope="col">Intake</th>
                  <th scope="col">Docs</th>
                  <th scope="col">Next step</th>
                  <th scope="col">Review</th>
                  <th scope="col">Case</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.case_id}>
                    <td>
                      {r.resident_name}
                      <br />
                      <span className="mono" style={{ fontSize: "0.72rem", color: "var(--cv-muted)" }}>
                        {r.contact}
                      </span>
                    </td>
                    <td>{r.property_address}</td>
                    <td>
                      <span className={`cv-tag ${completedStatuses.has(r.status) ? "green" : "teal"}`}>
                        {prettify(r.status)}
                      </span>
                      {r.urgency === "urgent" && <span className="cv-tag red"> urgent</span>}
                    </td>
                    <td>{r.pathway}</td>
                    <td className="mono">{r.intake}</td>
                    <td className="mono">
                      {r.uploaded_count}↑ {r.missing_count} missing
                    </td>
                    <td className="clamp" style={{ maxWidth: "15rem", fontSize: "0.8rem" }}>{r.next_best_action}</td>
                    <td>{r.review_required ? <span className="cv-tag amber">flagged</span> : "—"}</td>
                    <td>
                      <Link href={`/case/${r.case_id}`}>open</Link>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="cv-empty">
                      {fictional
                        ? "No cases yet — load demo scenarios or have a conversation on the resident page."
                        : "No cases are currently available for this County workspace."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside>
          {staffRole === "admin" && fictional && (
            <div className="cv-card cv-invitation-card" aria-labelledby="invitation-h">
              <h2 id="invitation-h">Resident demo invitation</h2>
              <p className="hint">
                Create a short-lived link to this fictional sandbox. It does not authorize real county services.
              </p>
              <form className="cv-invitation-form" onSubmit={(event) => void createInvitation(event)}>
                <label htmlFor="invitation-label">Internal label</label>
                <input
                  id="invitation-label"
                  className="cv-input"
                  value={invitationLabel}
                  minLength={3}
                  maxLength={80}
                  required
                  onChange={(event) => setInvitationLabel(event.target.value)}
                />
                <div className="cv-invitation-options">
                  <label htmlFor="invitation-expiry">
                    Expires
                    <select
                      id="invitation-expiry"
                      className="cv-input"
                      value={invitationMinutes}
                      onChange={(event) => setInvitationMinutes(Number(event.target.value))}
                    >
                      <option value={60}>1 hour</option>
                      <option value={240}>4 hours</option>
                      <option value={480}>8 hours</option>
                    </select>
                  </label>
                  <label htmlFor="invitation-uses">
                    Uses
                    <select
                      id="invitation-uses"
                      className="cv-input"
                      value={invitationMaxUses}
                      onChange={(event) => setInvitationMaxUses(Number(event.target.value))}
                    >
                      <option value={1}>1 use</option>
                      <option value={5}>5 uses</option>
                      <option value={10}>10 uses</option>
                    </select>
                  </label>
                </div>
                <button className="cv-btn cv-btn-primary cv-btn-sm" type="submit" disabled={creatingInvitation}>
                  {creatingInvitation ? "Creating…" : "Create invitation"}
                </button>
              </form>

              {invitationLink && (
                <div className="cv-invitation-result">
                  <label htmlFor="invitation-link">Private invitation link</label>
                  <div className="cv-invitation-link-row">
                    <input
                      id="invitation-link"
                      className="cv-input"
                      value={invitationLink}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button className="cv-btn cv-btn-ghost cv-btn-sm" type="button" onClick={() => void copyInvitation()}>
                      Copy
                    </button>
                  </div>
                  <p className="hint">
                    Shown only for this creation. Expires {new Date(invitationExpiresAt).toLocaleString()}.
                  </p>
                </div>
              )}
              {invitationStatus && <p className="cv-invitation-status" role="status" aria-live="polite">{invitationStatus}</p>}
              {invitationError && <p className="cv-invitation-error" role="alert">{invitationError}</p>}
            </div>
          )}

          <div className="cv-card" aria-labelledby="rq-h">
            <h2 id="rq-h" style={{ fontSize: "0.95rem" }}>
              Review queue
            </h2>
            {openTasks.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                Nothing waiting for review.
              </p>
            ) : (
              <ul className="cv-alerts">
                {openTasks.slice(0, 4).map((t) => (
                  <li key={t.task_id}>
                    <span
                      className={`cv-tag ${t.priority === "urgent" ? "red" : t.priority === "high" ? "amber" : ""}`}
                    >
                      {t.priority}
                    </span>
                    <span style={{ fontSize: "0.84rem" }}>{t.resident_name}</span>
                  </li>
                ))}
              </ul>
            )}
            <p style={{ margin: "0.6rem 0 0" }}>
              <Link href="/admin/review" style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                View review queue <IconArrowRight size={13} />
              </Link>
            </p>
          </div>

          <div className="cv-card" style={{ marginTop: "1rem" }} aria-labelledby="alerts-h">
            <h2 id="alerts-h" style={{ fontSize: "0.95rem" }}>
              Alerts
            </h2>
            <ul className="cv-alerts">
              <li>
                <IconAlert /> {inReview} case{inReview === 1 ? " needs" : "s need"} human review
              </li>
              <li>
                <IconAlert /> {missingDocs} missing document{missingDocs === 1 ? "" : "s"} across cases
              </li>
              <li>
                <IconAlert /> {urgent} urgent case{urgent === 1 ? "" : "s"}
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </StaffShell>
  );
}
