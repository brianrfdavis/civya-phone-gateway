"use client";

import { useEffect, useState } from "react";
import type { Summary, TurnRow } from "@/lib/logging/metrics";
import { StaffShell } from "../components/staff-shell";

function ms(n: number | null | undefined): string {
  return typeof n === "number" ? `${n} ms` : "—";
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function layerTag(layer?: string): { cls: string; label: string } {
  if (!layer) return { cls: "", label: "—" };
  if (layer === "L5_human_review") return { cls: "amber", label: layer };
  if (layer === "L4_model") return { cls: "teal", label: layer };
  return { cls: "green", label: layer };
}

export default function ResultsPage() {
  const [data, setData] = useState<{ rows: TurnRow[]; summary: Summary } | null>(null);
  const [workspace, setWorkspace] = useState<{ name?: string; environment?: string; fictional: boolean } | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/tools/log")
        .then((r) => r.json())
        .then(setData)
        .catch(() => {});
    load();
    void fetch("/api/staff/bootstrap", { cache: "no-store", headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => setWorkspace(payload?.tenant ? {
        name: payload.tenant.name,
        environment: payload.tenant.environment,
        fictional: payload.tenant.fictional === true,
      } : null))
      .catch(() => setWorkspace(null));
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const s = data?.summary;

  return (
    <StaffShell
      active="results"
      title="Performance and guided action"
      subtitle="Internal QA metrics — these live here, not on the resident homepage. Auto-refreshes every 5 seconds."
      workspace={workspace ?? { fictional: false }}
    >
      <section aria-labelledby="latency-h">
        <h2 id="latency-h" className="cv-section-title">
          Latency
        </h2>
        <div className="cv-stats">
          <div className="cv-stat">
            <div className="label">Avg speech → first audio</div>
            <div className="value">{ms(s?.avg_first_audio_ms)}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Avg (cache hit)</div>
            <div className="value good">{ms(s?.avg_cache_hit_ms)}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Avg (model)</div>
            <div className="value">{ms(s?.avg_model_ms)}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Profile lookup</div>
            <div className="value">{ms(s?.avg_profile_lookup_ms)}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Slowest response</div>
            <div className="value warn">{ms(s?.slowest_first_audio_ms)}</div>
          </div>
        </div>
      </section>

      <section aria-labelledby="quality-h">
        <h2 id="quality-h" className="cv-section-title">
          Cache &amp; reliability
        </h2>
        <div className="cv-stats">
          <div className="cv-stat">
            <div className="label">Turns</div>
            <div className="value">{s?.total_turns ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Cache hit rate</div>
            <div className="value good">{s ? pct(s.cache_hit_rate) : "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Errors</div>
            <div className="value">{s?.error_count ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Error rate</div>
            <div className="value">{s ? pct(s.error_rate) : "—"}</div>
          </div>
        </div>
      </section>

      <section aria-labelledby="guided-action-h">
        <h2 id="guided-action-h" className="cv-section-title">
          Resident guided-action activity
        </h2>
        <div className="cv-stats">
          <div className="cv-stat">
            <div className="label">Sessions</div>
            <div className="value">{s?.sessions ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Reached a next step</div>
            <div className="value good">{s?.sessions_with_next_step ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Doc checklist given</div>
            <div className="value">{s?.sessions_with_doc_checklist ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Human follow-ups</div>
            <div className="value">{s?.sessions_with_human_followup ?? "—"}</div>
          </div>
          <div className="cv-stat">
            <div className="label">Guided-action rate</div>
            <div className="value good">{s ? pct(s.guided_action_rate) : "—"}</div>
          </div>
        </div>
        <p className="cv-section-title" style={{ fontWeight: 400, fontSize: "0.82rem", color: "var(--cv-muted)" }}>
          Guided action = session reached a recommended next step, received a
          document checklist, or created a human follow-up. It is not an official outcome.
        </p>
      </section>

      <section aria-labelledby="turns-h">
        <h2 id="turns-h" className="cv-section-title">
          Turn log
        </h2>
        <div className="cv-table-wrap">
          <table className="cv-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Resident said</th>
                <th scope="col">Intent</th>
                <th scope="col">Source</th>
                <th scope="col">Match</th>
                <th scope="col">First audio</th>
                <th scope="col">Resolve</th>
                <th scope="col">Total</th>
                <th scope="col">Tools</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => {
                const tag = layerTag(r.layer);
                return (
                  <tr key={r.turn_id}>
                    <td className="mono">{new Date(r.ts).toLocaleTimeString()}</td>
                    <td>{r.user_text ?? "(voice turn)"}</td>
                    <td>{r.intent ?? "—"}</td>
                    <td>
                      <span className={`cv-tag ${tag.cls}`}>{tag.label}</span>
                      {r.escalated && <span className="cv-tag amber"> escalated</span>}
                    </td>
                    <td>{r.match_method ?? "—"}</td>
                    <td className="mono">{ms(r.speech_to_first_audio_ms)}</td>
                    <td className="mono">{ms(r.resolve_ms)}</td>
                    <td className="mono">{ms(r.total_ms)}</td>
                    <td>{r.tools_called?.join(", ") || "—"}</td>
                  </tr>
                );
              })}
              {(data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={9} className="cv-empty">
                    No turns logged yet — have a conversation first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: "0.78rem", color: "var(--cv-muted)" }}>
          Metrics are redacted and stored in the protected {workspace?.fictional ? "fictional sandbox" : "County tenant"}.
        </p>
      </section>
    </StaffShell>
  );
}
