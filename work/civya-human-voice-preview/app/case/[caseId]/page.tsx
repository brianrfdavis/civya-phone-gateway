"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { uploadDocumentDirect } from "@/lib/documents/upload-client";
import { SiteHeader } from "../../components/site-header";
import {
  IconArrowRight,
  IconBell,
  IconCheck,
  IconDoc,
  IconHeadset,
  IconUpload,
} from "../../components/icons";

interface CaseView {
  case: {
    id: string;
    status: string;
    propertyAddress?: string;
    municipality?: string;
    urgencyLevel: string;
    nextBestAction: string;
    reviewRequired: boolean;
    missingDocuments: string[];
    likelyPathways: string[];
    intakeFacts: Record<string, string>;
    createdAt: string;
    packetSummary?: string;
    submission?: { status: string; confirmationNumber?: string; submittedAt?: string };
    payment?: { status: string; kind?: string; amountUsd?: number; frequency?: string; confirmationNumber?: string };
  };
  resident?: { id: string; firstName: string; lastName: string };
  pathwayLabel: string;
  requiresPayment?: boolean;
  intake?: { total: number; collected: number; missing: { key: string; label: string }[] };
  checklist: { id: string; label: string; description: string; status: string }[];
  checklistSummary: string;
  documents: { id: string; fileName: string; documentType: string; reviewRequired: boolean }[];
  authorityNotice?: string;
  sandbox?: { fictional: boolean; environment?: string; official_transaction: boolean };
  error?: string;
}

interface ReminderSummary {
  reminderId: string;
  deliveryId?: string | null;
  status: "scheduled" | "queued" | "accepted" | "delivered" | "failed" | "failed_unknown" | "cancelled" | "suppressed";
  scheduledFor: string;
  channel: "sms";
  acceptedAt?: string | null;
  deliveredAt?: string | null;
  canCancel: boolean;
}

/** Plain-language blurbs for known pathways (fallback: prettified id). */
const PATHWAY_INFO: Record<string, { label: string; desc: string }> = {
  detroit_hope_screening: {
    label: "HOPE Property Tax Exemption",
    desc: "You may qualify for a reduction or exemption on your property taxes.",
  },
  pays_followup: {
    label: "PAYS Program",
    desc: "You may be eligible for a reduction on prior-year taxes.",
  },
  irspa_payment_plan: {
    label: "Payment Plan (IRSPA)",
    desc: "Set up a payment plan to pay what you owe over time.",
  },
  payment_guidance: {
    label: "Payment Plan",
    desc: "Set up a payment plan to pay what you owe over time.",
  },
  pre_correction_guidance: {
    label: "PRE Correction",
    desc: "Fix a missing homestead exemption that may lower your bill.",
  },
  dtrf_referral: {
    label: "Detroit Tax Relief Fund",
    desc: "A fund that may help pay down remaining balances.",
  },
  probate_referral: {
    label: "Legal / Probate Support",
    desc: "Get connected with legal help for ownership questions.",
  },
};

const STEPS = ["Understand", "Options", "Documents", "Next step"];

function stageFor(status: string): number {
  if (status === "started" || status === "intake_in_progress") return 2;
  if (status === "documents_needed" || status === "human_review_required") return 3;
  return 4;
}

function prettify(v?: string): string {
  return (v ?? "").replace(/_/g, " ");
}

/** Case copy is written for the agent — strip stage directions for residents. */
function residentFacing(text?: string): string {
  return (text ?? "")
    .replace(/^Ask \(one at a time\):\s*/i, "")
    .replace(/^Invite an upload\s*—\s*/i, "");
}

function money(v?: string): string | null {
  const n = parseFloat((v ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function reminderStatusCopy(reminder: ReminderSummary, simulated: boolean): string {
  if (simulated) {
    if (reminder.status === "cancelled") return "Simulated reminder cancelled. No text was sent.";
    return "Simulated reminder saved. No text will be sent from this sandbox.";
  }
  if (reminder.status === "scheduled") return "Scheduled. Civya has not sent the text yet.";
  if (reminder.status === "queued") return "Queued for secure delivery. Delivery is not confirmed yet.";
  if (reminder.status === "accepted") return "Twilio accepted the text. Delivery is not confirmed yet.";
  if (reminder.status === "delivered") return "Twilio reports that the reminder was delivered.";
  if (reminder.status === "failed_unknown") return "The delivery outcome needs review. Civya will not send this reminder again automatically.";
  if (reminder.status === "failed") return "The provider reported that this reminder was not delivered.";
  if (reminder.status === "suppressed") return "This reminder was not sent because consent, contact, or delivery permission is no longer active.";
  return "This reminder was cancelled before provider acceptance.";
}

export default function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  const [view, setView] = useState<CaseView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reminders, setReminders] = useState<ReminderSummary[]>([]);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [helpRequested, setHelpRequested] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const reminderRequestKey = useRef(`resident-reminder:${caseId}:${crypto.randomUUID()}`);

  const runTool = useCallback(
    async (tool: string, args: Record<string, unknown> = {}) => {
      const res = await fetch("/api/tools/case-mgmt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args: { case_id: caseId, ...args } }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "The saved action could not be completed.");
      return data;
    },
    [caseId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/case/${caseId}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Partial<CaseView> & { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Your case could not be loaded.");
      }
      if (!data.case || !Array.isArray(data.checklist) || !Array.isArray(data.documents)) {
        throw new Error("Civya received an incomplete case response. Please try again.");
      }
      setView(data as CaseView);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "Your case could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadReminders = useCallback(async () => {
    const response = await fetch(`/api/reminders?case_id=${encodeURIComponent(caseId)}`, {
      cache: "no-store",
    });
    const result = (await response.json().catch(() => ({}))) as {
      reminders?: ReminderSummary[];
      error?: string;
    };
    if (!response.ok) throw new Error(result.error || "Reminder status is unavailable.");
    setReminders(Array.isArray(result.reminders) ? result.reminders : []);
  }, [caseId]);

  useEffect(() => {
    void loadReminders().catch(() => {
      // The case remains usable when reminder status is temporarily unavailable.
    });
  }, [loadReminders]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setActionError(null);
      try {
        await uploadDocumentDirect(file, caseId);
        await load();
      } catch (uploadError) {
        setActionError(uploadError instanceof Error ? uploadError.message : "The document could not be uploaded.");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [caseId, load],
  );

  const optIn = useCallback(async () => {
    if (!view) return;
    const latest = reminders[0];
    if (latest && ["delivered", "failed", "failed_unknown", "cancelled", "suppressed"].includes(latest.status)) {
      reminderRequestKey.current = `resident-reminder:${caseId}:${crypto.randomUUID()}`;
    }
    setActionError(null);
    setReminderBusy(true);
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": reminderRequestKey.current,
        },
        body: JSON.stringify({
          case_id: caseId,
          timezone: "America/Detroit",
          idempotency_key: reminderRequestKey.current,
          consent_policy_version: "civya-reminder-consent-v1",
          confirm_sms: true,
          confirm_reminder: true,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "The reminder could not be scheduled.");
      await loadReminders();
    } catch (actionError) {
      setActionError(actionError instanceof Error ? actionError.message : "The reminder could not be saved.");
    } finally {
      setReminderBusy(false);
    }
  }, [caseId, loadReminders, reminders, view]);

  const cancelReminder = useCallback(async (reminderId: string) => {
    setActionError(null);
    setReminderBusy(true);
    try {
      const response = await fetch(
        `/api/reminders/${encodeURIComponent(reminderId)}?case_id=${encodeURIComponent(caseId)}`,
        { method: "DELETE" },
      );
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "The reminder could not be cancelled.");
      await loadReminders();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The reminder could not be cancelled.");
    } finally {
      setReminderBusy(false);
    }
  }, [caseId, loadReminders]);

  const askHuman = useCallback(async () => {
    setActionError(null);
    try {
      await runTool("create_human_review_task", {
        reason: "Resident asked for help from the case page",
        priority: "high",
      });
      setHelpRequested(true);
      await load();
    } catch (actionError) {
      setActionError(actionError instanceof Error ? actionError.message : "The review request could not be saved.");
    }
  }, [load, runTool]);

  if (!view && loadError) {
    return (
      <div className="cv-page">
        <div className="cv-banner" role="note">
          Civya could not confirm the latest case authority details. No saved case data was changed.
        </div>
        <div className="cv-container">
          <SiteHeader nav={<Link href="/">Ask Civya</Link>} />
          <main id="main" style={{ padding: "2rem 0" }}>
            <h1 style={{ fontSize: "1.4rem" }}>Case access problem</h1>
            <p role="alert">{loadError}</p>
            <p>Your case has not been changed by this failed load.</p>
            <div className="cv-card-row">
              <button className="cv-btn cv-btn-primary" type="button" onClick={() => void load()} disabled={loading}>
                {loading ? "Trying again…" : "Try again"}
              </button>
              <Link className="cv-btn cv-btn-ghost" href="/">Back to Civya</Link>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="cv-page">
        <div className="cv-container">
          <main id="main" style={{ padding: "2rem 0" }}>
            <p role="status" aria-live="polite">Loading your case…</p>
          </main>
        </div>
      </div>
    );
  }

  const kase = view.case;
  const fictional = view.sandbox?.fictional === true;
  const stage = stageFor(kase.status);
  const owed = money(kase.intakeFacts?.estimated_balance);
  const pathways = (kase.likelyPathways ?? []).slice(0, 3);
  const canSubmit = !["started", "intake_in_progress", "documents_needed"].includes(kase.status);
  const latestReminder = reminders[0];

  return (
    <div className="cv-page">
      <div className="cv-banner" role="note">
        {view.authorityNotice || (!fictional
          ? "Controlled launch — confirm official status and completed actions in the County system."
          : "Demonstration only — fictional data. Not an official government service.")}
      </div>
      <div className="cv-container">
        <SiteHeader
          nav={<Link href="/">← Back to Ask Civya</Link>}
          right={
            <span className="cv-tag teal" style={{ fontSize: "0.8rem" }}>
              Case #{kase.id.slice(0, 12)}
            </span>
          }
        />

        <main id="main">
          {loadError && (
            <section className="cv-case-recovery" role="alert" aria-labelledby="case-refresh-error-title">
              <div>
                <h2 id="case-refresh-error-title">Latest details could not be refreshed</h2>
                <p>{loadError} The saved case shown below remains available and may be out of date.</p>
              </div>
              <button className="cv-btn cv-btn-ghost" type="button" onClick={() => void load()} disabled={loading}>
                {loading ? "Refreshing…" : "Try again"}
              </button>
            </section>
          )}
          {actionError && (
            <section className="cv-case-recovery" role="alert" aria-labelledby="case-action-error-title">
              <div>
                <h2 id="case-action-error-title">That action did not complete</h2>
                <p>{actionError} Your case information is still available below.</p>
              </div>
              <button className="cv-btn cv-btn-ghost" type="button" onClick={() => setActionError(null)}>Dismiss</button>
            </section>
          )}
          {loading && !loadError && <p className="cv-case-refreshing" role="status">Refreshing saved case details…</p>}
          <section style={{ padding: "0.6rem 0 0.4rem" }}>
            <h1 style={{ fontSize: "1.55rem", letterSpacing: "-0.02em", margin: "0 0 0.2rem" }}>
              {view.resident?.firstName
                ? `${view.resident.firstName}, here's where things stand`
                : "Here's where things stand"}
            </h1>
            <p style={{ margin: 0, color: "var(--cv-muted)", fontSize: "0.95rem" }}>
              {kase.propertyAddress ?? "Property not identified yet"}
              {" · "}
              <span className="cv-tag teal">{prettify(kase.status)}</span>{" "}
              {kase.reviewRequired && <span className="cv-tag amber">human review</span>}
            </p>
            <div className="cv-journeybar" aria-label="Case progress">
              {STEPS.map((s, i) => (
                <span
                  key={s}
                  className="step"
                  data-state={i + 1 < stage ? "done" : i + 1 === stage ? "active" : "todo"}
                >
                  {s}
                </span>
              ))}
            </div>
          </section>

          <div className="cv-case-grid">
            <div>
              {/* Next best action */}
              <section className="cv-card" aria-labelledby="next-h">
                <h2 id="next-h">Next recommended step</h2>
                <p style={{ margin: 0, color: "var(--cv-body)" }}>{residentFacing(kase.nextBestAction)}</p>
                <div className="cv-card-row">
                  <Link href="/" className="cv-btn cv-btn-primary cv-btn-sm">
                    Continue with Civya <IconArrowRight size={14} />
                  </Link>
                  <button className="cv-btn cv-btn-ghost cv-btn-sm" onClick={() => fileRef.current?.click()}>
                    <IconUpload /> Upload a document
                  </button>
                </div>
              </section>

              {/* Recommended programs */}
              {pathways.length > 0 && (
                <section className="cv-card" aria-labelledby="rec-h">
                  <h2 id="rec-h">Recommended for you</h2>
                  <div className="cv-programs">
                    {pathways.map((p) => {
                      const info = PATHWAY_INFO[p] ?? {
                        label: prettify(p).replace(/\b\w/g, (c) => c.toUpperCase()),
                        desc: "Civya can walk you through this option.",
                      };
                      return (
                        <div key={p} className="cv-program-card">
                          <strong>{info.label}</strong>
                          <p>{info.desc}</p>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* What you may owe */}
              {owed && (
                <section className="cv-card" aria-labelledby="owe-h">
                  <h2 id="owe-h">What you may owe</h2>
                  <div className="cv-owe">
                    <div>
                      <span className="label">
                        {fictional ? "Estimated balance (fictional)" : "Resident-provided estimate"}
                      </span>
                      <span className="value">{owed}</span>
                    </div>
                    <div>
                      <span className="label">Primary path</span>
                      <span style={{ fontWeight: 600 }}>{view.pathwayLabel}</span>
                    </div>
                  </div>
                  <p className="hint" style={{ margin: "0.6rem 0 0" }}>
                    Estimate from your conversation — the Treasurer's records are
                    the official amount.
                  </p>
                </section>
              )}

              {/* Document checklist */}
              <section className="cv-card" aria-labelledby="checklist-h">
                <h2 id="checklist-h">Document checklist — {view.pathwayLabel}</h2>
                <ul className="cv-checklist">
                  {view.checklist.map((item) => (
                    <li key={item.id} data-status={item.status}>
                      <span className="cv-check-dot" aria-hidden="true">
                        {(item.status === "uploaded" || item.status === "verified") && <IconCheck />}
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <span className="desc">{item.description}</span>
                      </span>
                      <span
                        className={`cv-tag ${
                          item.status === "uploaded" || item.status === "verified"
                            ? "green"
                            : item.status === "needs_review"
                              ? "amber"
                              : ""
                        }`}
                      >
                        {prettify(item.status)}
                      </span>
                    </li>
                  ))}
                  {view.checklist.length === 0 && (
                    <li>No documents needed for this pathway.</li>
                  )}
                </ul>
                <p className="hint" style={{ marginBottom: 0 }}>{view.checklistSummary}</p>
              </section>

              {/* Uploaded documents */}
              <section className="cv-card" aria-labelledby="docs-h">
                <h2 id="docs-h">Uploaded documents</h2>
                {view.documents.length === 0 ? (
                  <p className="hint" style={{ margin: 0 }}>Nothing uploaded yet.</p>
                ) : (
                  <ul className="cv-checklist">
                    {view.documents.map((d) => (
                      <li key={d.id} data-status="uploaded">
                        <span className={"cv-tile mist"} style={{ width: "2rem", height: "2rem" }}>
                          <IconDoc size={15} />
                        </span>
                        <span>
                          <strong>{d.fileName}</strong>
                          <span className="desc">{prettify(d.documentType)}</span>
                        </span>
                        {d.reviewRequired && <span className="cv-tag amber">review</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="cv-upload">
                  <p>
                    A tax notice, a letter, an ID, a bill — you don't need to know
                    what it is. Civya stores it privately and queues it for review;
                    uncertain files are never guessed from their name.
                  </p>
                  <button
                    className="cv-btn cv-btn-primary cv-btn-sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    <IconUpload /> {uploading ? "Uploading…" : "Upload a document"}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".txt,.pdf,.png,.jpg,.jpeg,.webp"
                    className="visually-hidden"
                    aria-label="Upload a document"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                    }}
                  />
                </div>
              </section>

              {/* Intake progress */}
              {view.intake && view.intake.total > 0 && (
                <section className="cv-card" aria-labelledby="intake-h">
                  <h2 id="intake-h">Intake progress</h2>
                  <div className="cv-progressbar" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.round((view.intake.collected / view.intake.total) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="hint" style={{ margin: "0.55rem 0 0" }}>
                    {view.intake.collected} of {view.intake.total} intake questions answered
                    {view.intake.missing.length > 0 && (
                      <> — still needed: {view.intake.missing.map((m) => m.label).join(", ")}</>
                    )}
                  </p>
                </section>
              )}

              {/* Packet preparation; transaction simulation exists only in the fictional tenant. */}
              {fictional ? (
                <section className="cv-card" aria-labelledby="packet-h">
                <h2 id="packet-h">Application packet (demo)</h2>
                {kase.packetSummary ? (
                  <pre className="cv-packet">{kase.packetSummary}</pre>
                ) : (
                  <p className="hint" style={{ margin: 0 }}>
                    The packet summary appears here once intake and documents are complete.
                  </p>
                )}
                <div className="cv-card-row">
                  <button
                    className="cv-btn cv-btn-ghost cv-btn-sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      setActionError(null);
                      setBusy("packet");
                      try {
                        await runTool("generate_packet_summary");
                        await load();
                      } catch (actionError) {
                        setActionError(actionError instanceof Error ? actionError.message : "The packet could not be prepared.");
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === "packet" ? "Preparing…" : "Refresh packet summary"}
                  </button>
                  {kase.submission?.status !== "submitted" && (
                    <button
                      className="cv-btn cv-btn-primary cv-btn-sm"
                      disabled={busy !== null || !canSubmit}
                      onClick={async () => {
                        setActionError(null);
                        setBusy("submit");
                        try {
                          await runTool("submit_demo_packet");
                          await load();
                        } catch (actionError) {
                          setActionError(actionError instanceof Error ? actionError.message : "The simulation could not be completed.");
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === "submit" ? "Submitting…" : "Run simulated submission"}
                    </button>
                  )}
                </div>
                {kase.submission?.status === "submitted" && (
                  <p role="status" style={{ fontSize: "0.9rem" }}>
                    <span className="cv-tag green">submitted</span> Simulated
                    submission complete — confirmation{" "}
                    <code>{kase.submission.confirmationNumber}</code>. In production
                    this would go to the county's approved application system.
                  </p>
                )}
                </section>
              ) : (
                <section className="cv-card" aria-labelledby="packet-h">
                  <h2 id="packet-h">Application preparation</h2>
                  <p className="hint" style={{ margin: 0 }}>
                    Civya keeps the saved intake and documents together for authorized review. No application is submitted from this page, and only an approved County workflow may confirm submission.
                  </p>
                </section>
              )}

              {/* Payment plan */}
              {fictional && view.requiresPayment && kase.submission?.status === "submitted" && (
                <section className="cv-card" aria-labelledby="pay-h">
                  <h2 id="pay-h">Payment plan (simulated)</h2>
                  {kase.payment?.status === "completed" ? (
                    <p role="status" style={{ fontSize: "0.92rem", margin: 0 }}>
                      <span className="cv-tag green">active</span> Demo payment plan —
                      ${kase.payment.amountUsd} {kase.payment.frequency}, confirmation{" "}
                      <code>{kase.payment.confirmationNumber}</code>. No real money moved.
                    </p>
                  ) : (
                    <>
                      <p className="hint" style={{ marginTop: 0 }}>
                        Demo only — uses a sample payment method, never real card or
                        bank information.
                      </p>
                      <div className="cv-card-row" style={{ marginTop: 0 }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="cv-input"
                          placeholder="Monthly amount, e.g. 150"
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                          aria-label="Demo monthly payment amount in dollars"
                        />
                        <button
                          className="cv-btn cv-btn-primary cv-btn-sm"
                          disabled={busy !== null || !payAmount}
                          onClick={async () => {
                            setActionError(null);
                            setBusy("pay");
                            try {
                              await runTool("create_demo_payment_plan", { monthly_amount_usd: payAmount });
                              await runTool("submit_demo_payment");
                              await load();
                            } catch (actionError) {
                              setActionError(actionError instanceof Error ? actionError.message : "The simulated plan could not be completed.");
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {busy === "pay" ? "Setting up…" : "Set up demo payment plan"}
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}

              {/* Reminders */}
              <section className="cv-card" aria-labelledby="remind-h">
                <h2 id="remind-h">
                  <IconBell size={15} /> Reminders
                </h2>
                {latestReminder ? (
                  <div role="status" aria-live="polite" style={{ fontSize: "0.9rem" }}>
                    <p style={{ marginTop: 0 }}>
                      {reminderStatusCopy(latestReminder, view.sandbox?.fictional === true)}
                    </p>
                    <p className="hint">
                      Scheduled for {new Date(latestReminder.scheduledFor).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/Detroit",
                        timeZoneName: "short",
                      })}.
                    </p>
                    {latestReminder.canCancel && (
                      <button
                        className="cv-btn cv-btn-ghost cv-btn-sm"
                        type="button"
                        disabled={reminderBusy}
                        onClick={() => void cancelReminder(latestReminder.reminderId)}
                      >
                        {reminderBusy ? "Updating…" : "Cancel reminder"}
                      </button>
                    )}
                    {!latestReminder.canCancel && ["delivered", "failed", "failed_unknown", "cancelled", "suppressed"].includes(latestReminder.status) && (
                      <button
                        className="cv-btn cv-btn-ghost cv-btn-sm"
                        type="button"
                        disabled={reminderBusy}
                        onClick={() => void optIn()}
                      >
                        {reminderBusy ? "Scheduling…" : "Schedule another reminder"}
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <p className="hint" style={{ marginTop: 0 }}>
                      Get one generic text tomorrow with a secure Civya sign-in link. It will not include case details or claim that the County received or approved anything.
                    </p>
                    <p className="hint">
                      By selecting this button, you consent to this SMS reminder and its delivery channel.
                      {view.sandbox?.fictional === true
                        ? " This sandbox records simulated consent and sends no text."
                        : " Message and data rates may apply. Reply STOP to opt out."}
                    </p>
                    <button
                      className="cv-btn cv-btn-ghost cv-btn-sm"
                      type="button"
                      disabled={reminderBusy}
                      onClick={() => void optIn()}
                    >
                      {reminderBusy ? "Scheduling…" : "Agree and schedule text"}
                    </button>
                  </>
                )}
              </section>
            </div>

            {/* ── Sidebar: case summary ── */}
            <aside>
              <div className="cv-card" aria-label="Case summary">
                <h2>Case summary</h2>
                <dl className="cv-defs">
                  <div>
                    <dt>Property</dt>
                    <dd>{kase.propertyAddress ?? "Not identified yet"}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <span className="cv-tag teal">{prettify(kase.status)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Case opened</dt>
                    <dd>
                      {new Date(kase.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>Primary path</dt>
                    <dd>{view.pathwayLabel}</dd>
                  </div>
                  <div>
                    <dt>Next step</dt>
                    <dd style={{ fontSize: "0.86rem" }}>{residentFacing(kase.nextBestAction)}</dd>
                  </div>
                </dl>
              </div>

              <div className="cv-card" style={{ marginTop: "1.1rem" }} aria-label="Need help">
                <h2>Need help?</h2>
                {!fictional ? (
                  <>
                    <p className="hint" style={{ marginTop: 0 }}>
                      A person can confirm County status and available options. Civya does not create a staff follow-up request unless that County workflow is active.
                    </p>
                    <a
                      className="cv-btn cv-btn-primary cv-btn-sm"
                      href="https://www.waynecounty.com/elected/treasurer/home.aspx"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <IconHeadset /> Contact Wayne County
                    </a>
                  </>
                ) : helpRequested ? (
                  <p role="status" style={{ margin: 0, fontSize: "0.88rem" }}>
                    A real team member will follow up on your case. (Demo — the
                    request is in the staff review queue.)
                  </p>
                ) : (
                  <>
                    <p className="hint" style={{ marginTop: 0 }}>
                      Get help from a real team member when you need it.
                    </p>
                    <button className="cv-btn cv-btn-primary cv-btn-sm" onClick={() => void askHuman()}>
                      <IconHeadset /> Talk to a person
                    </button>
                  </>
                )}
              </div>
            </aside>
          </div>
        </main>

        <footer className="cv-footer">
          <p>
            Civya explains public program information in plain language. It does
            not give legal or tax advice. {fictional
              ? "This demonstration uses fictional data only."
              : "County and approved-provider records remain authoritative."}
          </p>
        </footer>
      </div>
    </div>
  );
}
