"use client";

import { useEffect, useState } from "react";
import { StaffShell } from "../../components/staff-shell";

interface ReviewRow {
  task_id: string;
  case_id: string;
  reason: string;
  priority: string;
  status: string;
  assigned_to: string;
  notes: string[];
  resident_name: string;
  property_address: string;
  pathway: string;
  documents: { id: string; fileName: string; documentType: string }[];
  checklist_summary: string;
  next_best_action: string;
  created_at: string;
}

function prettify(v?: string): string {
  return (v ?? "").replace(/_/g, " ");
}

export default function ReviewQueuePage() {
  const [tasks, setTasks] = useState<ReviewRow[]>([]);
  const [workspace, setWorkspace] = useState<{ name?: string; environment?: string; fictional: boolean } | null>(null);

  const load = () =>
    fetch("/api/admin/review")
      .then((r) => r.json())
      .then((d) => setTasks(d.tasks ?? []))
      .catch(() => {});

  useEffect(() => {
    load();
    void fetch("/api/staff/bootstrap", { cache: "no-store", headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => setWorkspace(payload?.tenant ? {
        name: payload.tenant.name,
        environment: payload.tenant.environment,
        fictional: payload.tenant.fictional === true,
      } : null))
      .catch(() => setWorkspace(null));
    const t = setInterval(load, 7000);
    return () => clearInterval(t);
  }, []);

  const setStatus = async (taskId: string, status: string) => {
    await fetch("/api/admin/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: taskId,
        status,
        note: `Status set to ${status} from review queue`,
      }),
    });
    await load();
  };

  return (
    <StaffShell
      active="review"
      title="Review queue"
      subtitle="Cases needing a human eye — legal, ownership, probate, urgent, or sensitive-document signals."
      workspace={workspace ?? { fictional: false }}
    >
      {tasks.length === 0 && (
        <div className="cv-card cv-empty">
          {workspace?.fictional
            ? "Nothing in the queue. Load demo scenarios from the case dashboard, or ask Civya about an owner who passed away."
            : "Nothing is waiting for human review in this County workspace."}
        </div>
      )}
      <div className="cv-review-grid">
        {tasks.map((t) => (
          <article key={t.task_id} className={`cv-review-card${t.priority !== "normal" ? " hot" : ""}`}>
            <header>
              <span className={`cv-tag ${t.priority === "urgent" ? "red" : t.priority === "high" ? "amber" : ""}`}>
                {t.priority}
              </span>
              <span className="cv-tag teal">{prettify(t.status)}</span>
            </header>
            <h3>{t.resident_name}</h3>
            <p className="addr">{t.property_address}</p>
            <p className="field">
              <b>Why flagged:</b> {t.reason}
            </p>
            <p className="field">
              <b>Pathway:</b> {t.pathway}
            </p>
            <p className="field">
              <b>Documents:</b>{" "}
              {t.documents.length
                ? t.documents
                    .map((d) => `${d.fileName} (${prettify(d.documentType)})`)
                    .join(", ")
                : "none uploaded"}
            </p>
            <p className="field">
              <b>Checklist:</b> {t.checklist_summary || "—"}
            </p>
            <p className="field">
              <b>Recommended next step:</b> {t.next_best_action}
            </p>
            {t.notes.length > 0 && (
              <details>
                <summary>Notes ({t.notes.length})</summary>
                <ul>
                  {t.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="cv-card-row">
              {t.status === "open" && (
                <button className="cv-btn cv-btn-primary cv-btn-sm" onClick={() => void setStatus(t.task_id, "in_review")}>
                  Start review
                </button>
              )}
              {(t.status === "open" || t.status === "in_review") && (
                <button className="cv-btn cv-btn-ghost cv-btn-sm" onClick={() => void setStatus(t.task_id, "resolved")}>
                  Mark resolved
                </button>
              )}
              {t.status === "resolved" && (
                <button className="cv-btn cv-btn-danger cv-btn-sm" onClick={() => void setStatus(t.task_id, "closed")}>
                  Close
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </StaffShell>
  );
}
