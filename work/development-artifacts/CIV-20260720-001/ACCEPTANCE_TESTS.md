# Acceptance Test Report: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Test report ID | CIV-20260720-001-TEST |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | Automated stage passed; production acceptance blocked |
| Candidate/build | `codex/civya-bridge-v2-cedar`; immutable commit recorded after QA |
| Risk tier | R3 |
| QA owner | Codex QA context; named release QA pending |
| Test window | 2026-07-20, America/Detroit |

## Scope and environment

- Included: phone profile, prompt, greeting, end-call controls, official-answer boundary, profile attribution, documentation, rollback refs, full repository regression, and production build.
- Excluded pending release gate: real PSTN audio/event order, representative listening, qualified Spanish, non-AI fallback, production/provider configuration, and named approvals.
- Environment: local Node 22-compatible repository runtime with synthetic/stubbed external dependencies; no production secrets read and no live state changed.
- Data: synthetic and non-sensitive configuration only.

## Coverage matrix

| Area | Result | Evidence |
|---|---|---|
| Acceptance criteria | Partial pass | AC-01/02/03 text/04 prompt/06/07 automated; live portions blocked |
| Alternate and boundary paths | Pass automated | Invalid voice fallback, renderer, direct/polite/negated/explanatory stop, no-thanks decline |
| Resume/retry/duplicate | Pass regression | Full repository call/event/provider suites |
| Roles/permissions/isolation | No change; pass regression | Full `npm test` and foundation/security suites |
| Accessibility/manual | Blocked | Real phone comprehension, accents, interruption, and Spanish require people/audio |
| Integration/provider failure | Blocked for release | Non-AI fallback and real SIP event evidence missing |
| Migration/rollback | Pass source / blocked exercise | No migration; Harbor refs/tuple verified; sandbox drain/rollback still required |
| Performance/capacity | Contract pass / measurement blocked | 1,872-char prompt, low reasoning, 500 ms VAD, `inf`; p50/p95 not measured |
| Observability/audit/redaction | Pass | Exact model/voice/mode/version attached to redacted call lifecycle |
| Regression suite | Pass | Full `npm test`, focused suites, typecheck, build |

## Test cases

| ID | Outcome | Priority | Result | Evidence |
|---|---|---:|---|---|
| AT-01 | Harbor tag/aliases restore `0d7c166…` | Critical | Pass | Git ref verification and Harbor manifest |
| AT-02 | Missing/invalid voice stays Marin; explicit candidate is Cedar | Critical | Pass | `phone-fast-profile-tests.ts` |
| AT-03 | Realtime tuple stays 2.1/low/500 ms/`inf`; prompt ≤2,000 | Critical | Pass | 1,872 chars; profile suite |
| AT-04 | Opening says automated service once and exposes person/stop | Critical | Pass for copy | Call-control contract |
| AT-05 | No thanks does not hang up; explicit stop does | Critical | Pass | Direct, polite, negated, and explanatory regression cases |
| AT-06 | Official lookup and private-data boundaries remain | Critical | Pass | Official research, phone turn, full regression |
| AT-07 | Durable calls identify model/voice/mode/version | High | Pass | Profile helper and lifecycle metadata assertions |
| AT-08 | Full application compiles and repository regressions pass | High | Pass | `npm test`; `next build` |
| AT-09 | Interrupted disclosure is replayed | Critical | Blocked | Real SIP/event-machine evidence absent |
| AT-10 | Cedar/Bridge improves resident experience without harm | Critical | Blocked | Representative blind PSTN research not run |
| AT-11 | Phone latency and complete-thought rate match Harbor | Critical | Blocked | Comparable p50/p95/audio sample absent |
| AT-12 | Qualified Spanish and non-AI fallback work | Critical | Blocked | Human/provider evidence absent |
| AT-13 | Named R3 approvals recorded | Critical | Blocked | Product/Ops, Privacy/Legal/Records, Security, Brand/GTM, QA/Release pending |

## Defects

| ID | Severity | Behavior/impact | Disposition |
|---|---|---|---|
| BRIDGE-001 | P1 | Interrupted opening may lose disclosure | Open release blocker |
| BRIDGE-002 | P2 | Negated stop could hang up | Fixed and verified |
| BRIDGE-003 | P2 | Call records lacked candidate tuple | Fixed and verified |

## Result summary

| Result | Count |
|---|---:|
| Passed | 8 |
| Failed | 0 |
| Blocked | 5 |
| Skipped | 0 |

- Regression result: Passed.
- Open P0/P1 findings: 1 P1, activation-prohibiting.
- Residual risk: live model/audio variability, cultural fit, comprehension, interruption, latency, Spanish, and fallback.
- QA recommendation: preserve and share the source candidate branch; do not release or activate.

## Sign-off

| Role | Name | Decision | Date | Conditions |
|---|---|---|---|---|
| Automated QA | Codex | Source checks pass | 2026-07-20 | No production activation |
| Product | Civya owner | Candidate direction accepted | 2026-07-20 | Harbor preserved |
| Named QA / Security / Privacy | TBD | Pending | — | Required before release |
