"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StaffShell } from "@/app/components/staff-shell";
import { listWorkflowDefinitions } from "@/lib/workflows/definitions";

interface ReviewTask {
  task_id: string;
  case_id: string;
  reason: string;
  priority: string;
  status: string;
  resident_name: string;
  next_best_action: string;
  created_at: string;
}

interface WorkspaceState {
  tenant?: { name?: string; environment?: string; fictional?: boolean };
  workspace?: { environment?: string; fictional?: boolean };
  activation?: { county_source?: string; payment_handoff?: string; identity_proofing?: string };
}

function prettifyMode(mode?: string): string {
  if (mode === "live") return "Live";
  if (mode === "synthetic") return "Sandbox";
  return "Disabled";
}

export default function StaffOperationsPage() {
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [message, setMessage] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const workflows = useMemo(() => listWorkflowDefinitions(), []);

  const load = useCallback(async () => {
    try {
      const access = await fetch("/api/staff/bootstrap", { cache: "no-store" });
      if (access.status === 401 || access.status === 403) {
        setState("denied");
        return;
      }
      if (!access.ok) throw new Error("Staff access could not be verified.");
      const accessBody = await access.json() as WorkspaceState;
      setWorkspace(accessBody);
      const response = await fetch("/api/admin/review", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Operations could not be loaded.");
      setTasks(body.tasks ?? []);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operations could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") {
    return <main id="main" className="cv-staff-gate"><h1>Loading operations…</h1><p role="status">Checking queues and controls.</p></main>;
  }
  if (state === "denied") {
    return (
      <main id="main" className="cv-staff-gate">
        <h1>Staff sign-in required</h1>
        <p>This operations view never opens through resident account access.</p>
        <Link className="cv-btn cv-btn-primary" href="/staff/sign-in">Sign in as invited staff</Link>
      </main>
    );
  }
  if (state === "error") {
    return <main id="main" className="cv-staff-gate"><h1>Operations unavailable</h1><p role="alert">{message}</p><button className="cv-btn cv-btn-primary" onClick={() => void load()}>Try again</button></main>;
  }

  const open = tasks.filter((task) => task.status === "open" || task.status === "in_review");
  const urgent = open.filter((task) => task.priority === "urgent");
  const fictional = workspace?.tenant?.fictional === true || workspace?.workspace?.fictional === true;
  const activation = workspace?.activation ?? {};

  return (
    <StaffShell
      active="operations"
      title={fictional ? "Launch operations preview" : "County operations"}
      subtitle={fictional
        ? "Synthetic workflow definitions and fictional exception records — not live County operations."
        : "Tenant-bound exception queues and governed workflow status."}
      workspace={{
        name: workspace?.tenant?.name,
        fictional,
        environment: workspace?.tenant?.environment ?? workspace?.workspace?.environment,
      }}
    >
      <div className="cv-banner cv-operations-preview-note" role="note">
        {fictional
          ? "Fictional operations preview. Counts come from sandbox records; workflow definitions are read-only design targets, and no control or status on this page activates a County service."
          : "Operational workspace. Workflow state is tenant-bound. County source, payment, and identity controls remain unavailable whenever their contracted providers are disabled."}
      </div>
      <div className="cv-stats">
        <div className="cv-stat"><div className="label">Open {fictional ? "demo " : ""}exceptions</div><div className="value warn">{open.length}</div><div className="sub">{fictional ? "fictional queue records" : "tenant-bound queue records"}</div></div>
        <div className="cv-stat"><div className="label">{fictional ? "Demo urgent" : "Urgent"}</div><div className="value warn">{urgent.length}</div><div className="sub">{fictional ? "not a live service level" : "requires staff attention"}</div></div>
        <div className="cv-stat"><div className="label">Workflow definitions</div><div className="value">{workflows.length}</div><div className="sub">modeled, not activated</div></div>
        <div className="cv-stat"><div className="label">County source</div><div className="value">{prettifyMode(activation.county_source)}</div><div className="sub">contracted authority connection</div></div>
        <div className="cv-stat"><div className="label">Payment handoff</div><div className="value">{prettifyMode(activation.payment_handoff)}</div><div className="sub">hosted provider handoff</div></div>
        <div className="cv-stat"><div className="label">Identity proofing</div><div className="value">{prettifyMode(activation.identity_proofing)}</div><div className="sub">CLEAR or approved provider</div></div>
      </div>

      <section aria-labelledby="workflow-control-title">
        <h2 id="workflow-control-title" className="cv-section-title">Workflow definitions</h2>
        <p>This read-only table describes governed boundaries. It does not by itself activate, pause, or prove completion of a workflow.</p>
        <div className="cv-table-wrap">
          <table className="cv-table">
            <thead><tr><th scope="col">Workflow</th><th scope="col">Version</th><th scope="col">Initial action</th><th scope="col">Completion authority</th></tr></thead>
            <tbody>
              {workflows.map((workflow) => (
                <tr key={workflow.key}>
                  <td><strong>{workflow.displayName}</strong></td>
                  <td className="mono">{workflow.version}</td>
                  <td>{workflow.nextActions[workflow.initialState]}</td>
                  <td>{workflow.completionAuthority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="exception-title" style={{ marginTop: "2rem" }}>
        <h2 id="exception-title" className="cv-section-title">{fictional ? "Fictional exception queue" : "Exception queue"}</h2>
        <div className="cv-table-wrap">
          <table className="cv-table">
            <thead><tr><th scope="col">Resident</th><th scope="col">Reason</th><th scope="col">Priority</th><th scope="col">State</th><th scope="col">Next recovery</th><th scope="col">Case</th></tr></thead>
            <tbody>
              {open.map((task) => (
                <tr key={task.task_id}>
                  <td>{task.resident_name}</td><td>{task.reason}</td>
                  <td><span className={`cv-tag ${task.priority === "urgent" ? "red" : "amber"}`}>{task.priority}</span></td>
                  <td>{task.status.replace(/_/g, " ")}</td><td>{task.next_best_action}</td>
                  <td><Link href={`/case/${task.case_id}`}>open</Link></td>
                </tr>
              ))}
              {open.length === 0 && <tr><td colSpan={6} className="cv-empty">No {fictional ? "fictional " : ""}exceptions are waiting.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </StaffShell>
  );
}
