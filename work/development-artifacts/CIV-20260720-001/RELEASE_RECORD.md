# Release Record: Civya Bridge v2 Cedar candidate

| Field | Value |
|---|---|
| Release ID | CIV-20260720-001-REL |
| Template version | 1.0.0 |
| Product version | `civya-bridge-v2-2026-07-20` candidate |
| Status | Paused before production release |
| Risk tier | R3 |
| Candidate/build | `codex/civya-bridge-v2-cedar` at `107728d` |
| Source revision | `107728d` |
| Release Manager | Named owner pending |
| Window | No production window authorized |

## Release outcome

The source candidate is prepared for controlled evaluation. No resident, Twilio,
Render, Vercel, Supabase, or other production state changes in this release
record. Maya — Harbor v1 remains live and independently recoverable.

## Included changes

| Change/brief | Risk | User impact if later activated | Config/flag | Owner |
|---|---:|---|---|---|
| Bridge relationship prompt | R3 | Warmer natural conversation and voluntary return to tax help | `phone_fast` profile version | Product/Engineering |
| Cedar audition | R3 | Different voice timbre for blind evaluation | Explicit `CIVYA_PHONE_REALTIME_VOICE=cedar` | Product/UX |
| Stop/decline correction | R3 | “No thanks” stays in call; explicit stop ends safely | Deterministic router | Engineering |
| Durable profile attribution | R3 | Trustworthy Harbor/Bridge comparison | Redacted lifecycle metadata | Engineering |

## Excluded or deferred

- Production activation, number publication, live config changes, and resident outreach.
- New memory, analytics, tools, providers, recording, demographic inference, or crisis-decision path.
- Stateful official-lookup latency redesign.

## Candidate provenance

- Build/test: full `npm test` after the final code changes, focused phone/foundation/security suites, TypeScript, production `next build`, and local browser smoke passed.
- Configuration: `phone_fast`, `gpt-realtime-2.1`, explicit `cedar`, low reasoning, 500 ms VAD, `inf`, `gpt-4o-transcribe`.
- Candidate tested equals candidate released: No release occurred.

## Gate checklist

| Gate | Required? | Evidence | Decision |
|---|---:|---|---|
| Product candidate direction | Yes | Feature brief/owner request | Accepted for source only |
| Architecture/engineering | Yes | Independent review | Candidate acceptable; P1 release blocker open |
| Automated QA/build | Yes | Acceptance report | Passed |
| Representative audio/equity | Yes | Not yet available | Blocked |
| Accessibility/Spanish | Yes | Not yet available | Blocked |
| Security/privacy/research | Yes | Threat model; named approval absent | Blocked |
| Operational/fallback/latency | Yes | Live evidence absent | Blocked |
| Rollback exercise | Yes | Refs/plan exist; exercise absent | Blocked |
| Named R3 release approval | Yes | Not recorded | Blocked |

Unresolved P0/P1 findings prohibit release. No risk in this record is accepted
for production.

## Rollout plan

| Stage | Population/environment | Start condition | Advance/stop owner |
|---|---|---|---|
| 0 | Source-only | Automated checks and immutable commit | Engineering |
| 1 | Controlled non-public audition | All P1 technical/fallback/privacy gates closed | Release + Product/Ops |
| 2 | Representative limited pilot | Blind research and named approvals | Named R3 authority |
| 3 | Production | Separate explicit deployment authorization | Named R3 authority |

## Health and stop thresholds

| Signal | Target | Stop threshold |
|---|---|---|
| Official-fact accuracy | No regression / no bypass | Any bypass or unsupported fact |
| Disclosure | Understood once per new call | Any interrupted call proceeds undisclosed |
| Latency/completeness | No material Harbor regression | Material p50/p95 or sentence-completion regression |
| Dignity/equity | Improvement on ≥1 dimension, no harm | Stereotype, patronizing result, or subgroup harm |
| Call controls/fallback | All critical scenarios pass | Failed stop/person/fallback path |

## Migration, rollback, and containment

- Database migration: none.
- Containment: do not activate; if an audition is authorized, stop new admissions before rollback.
- Rollback: drain active calls where possible, restore source `0d7c166…`, `phone_fast`, `gpt-realtime-2.1`, `marin`, profile `phone-fast-v2-2026-07-17`, and rate 20; then place a canary call.
- Non-reversible effects: an interrupted call, missed deadline, privacy exposure, stereotype, or lost trust cannot be undone; this is why rollout is paused.

## Execution and final decision

- Production execution log: none.
- Outcome: Paused; source candidate only.
- Decision authority: named release authority pending.
- Version history updated: candidate/Harbor manifests only; no canonical product release registered.
