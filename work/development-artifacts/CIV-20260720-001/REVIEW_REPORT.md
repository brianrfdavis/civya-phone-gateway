# Independent Review Report: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Review ID | CIV-20260720-001-REVIEW |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | Changes required before production activation |
| Candidate/revision | `codex/civya-bridge-v2-cedar`; immutable commit recorded after QA |
| Brief/plan | `FEATURE_BRIEF.md`; `IMPLEMENTATION_PLAN.md` |
| Risk tier | R3 |
| Reviewer | Independent read-only engineering subagent; builder disposition review |
| Reviewed | 2026-07-20 |

## Independence statement

- Reviewer separate from implementation context: Yes. The reviewer received the approved scope and inspected the diff and surrounding runtime without editing files.
- Builder summary read only after brief/standards: Yes for the independent context.

## Review scope

- Behavior and acceptance criteria: voice selection, identity/disclosure, Join → Bridge → Next, stop/decline controls, prompt budget, official lookup, rollback, and release gates.
- Code/docs: phone profile, router, SIP lifecycle, focused tests, runtime configuration, release manifests, and governed packet.
- Evidence: focused phone tests, full `npm test`, TypeScript, foundation/security suites, production build, ref verification, and prompt length.
- Architecture: existing Realtime SIP, official-answer tool, deterministic effects, durable call lifecycle, privacy-safe metadata, and fallback boundaries.
- Not examined as successful evidence: real PSTN audio, representative listening, qualified Spanish, interrupted disclosure, live latency, non-AI fallback, or production configuration. These remain blockers.

## Outcome assessment

The implementation delivers the bounded source candidate without changing the model, official-fact authority, storage purpose, or live system. Cedar is explicit opt-in and Marin remains the safe source fallback. The prompt is 1,872 characters and makes the relationship bridge voluntary. Production activation is not approved because the current event evidence does not prove that the automated-service disclosure is replayed if a caller interrupts the opening.

## Dimension review

| Dimension | Assessment | Evidence/findings |
|---|---|---|
| Product and policy alignment | Pass for candidate / Concern for release | Spoken identity remains Civya; one disclosure; voluntary bridge; P1 interruption gap blocks release |
| Correctness and edge cases | Pass with blocker | Direct/polite/negated/explanatory stop cases covered; live interruption remains unproven |
| Architecture and maintainability | Pass | Existing Realtime/tool/effect boundaries retained; one profile-evidence helper prevents tuple drift |
| Authorization and security | Pass | No permission/tool/provider change; official and deterministic effect gates unchanged |
| Privacy and data lifecycle | Pass for code / approval pending | No new caller content; only non-sensitive model/voice/profile metadata added; research protocol pending |
| Accessibility and UX states | Concern | Voice copy is plain and short; real PSTN, accent, interruption, and qualified Spanish evidence pending |
| Tests and regression protection | Pass for static/automated / Concern for live | Full automated suite/build pass; real SIP event-machine and listening tests blocked |
| Reliability and operations | Pass with blocker | Durable profile attribution fixed; non-AI fallback and live latency not proven |
| Migration, rollout, rollback | Pass for source | No migration; Harbor refs/config documented; drain-before-rollback required |
| Documentation and records | Pass | Harbor aliases, candidate tuple, blind protocol, blockers, and rollback recorded |

## Findings

### [P1] Interrupted opening can lose the automation disclosure

- Affected behavior/user impact: a caller who barges in before hearing “automated service” may continue without the required first-interaction disclosure.
- Evidence: `welcomePhoneRoute()` contains the disclosure; the SIP runtime enqueues the welcome once and has no verified disclosure-heard/replay event test.
- Smallest complete correction: prove the event sequence on real SIP, add durable per-call disclosure state/replay if needed, and add a regression test for interrupted opening playback.
- Release blocker: Yes.
- Owner/status: Engineering + Product/Resident Operations; open before activation.

### [P2] Negated stop request could hang up

- Evidence: independent reproduction of “Do not stop the call.”
- Correction: `NEGATED_END` now includes stop; direct, polite, negated, and explanatory stop phrases are tested.
- Owner/status: Engineering; resolved.

### [P2] Profile version absent from durable call evidence

- Evidence: process health exposed the profile, but connected/terminal call metadata did not.
- Correction: model, voice, response mode, and profile version are captured once per call and attached to redacted lifecycle metadata.
- Owner/status: Engineering; resolved.

## Test gaps

| Codepath/branch | Risk | Existing coverage | Required coverage | Disposition |
|---|---|---|---|---|
| Interrupted opening disclosure | P1 deception/trust | Greeting text and attach contract | Real SIP barge-in plus event-machine regression | Release blocker |
| Cedar/Bridge audio | P1 dignity/equity | Config and prompt contracts | Representative blind PSTN comparison | Release blocker |
| Phone latency/completeness | P1 resident access | 500 ms VAD and unlimited response contract | Same-transport p50/p95 and complete-thought evidence | Release blocker |
| Spanish | P1 comprehension | Function-level approved copy | Qualified bilingual review and real audio | Release blocker |
| Provider failure | P1 availability | Existing code paths | Verified deterministic non-AI fallback | Release blocker |

## Re-review

| Finding | Correction revision | Verification | Result |
|---|---|---|---|
| Negated stop | Working candidate | Focused call-control tests | Resolved |
| Durable profile attribution | Working candidate | Profile tests, static lifecycle assertion, typecheck/build | Resolved |
| Interrupted disclosure | Not corrected without real event evidence | Release protocol inspection | Open P1 |

## Recommendation

- Disposition: Approve source candidate; changes required before any activation.
- Open P0/P1 count: 1.
- Open/accepted P2 count: 0; both P2 findings resolved.
- Required next gate: real SIP QA, representative research, bilingual/fallback/privacy evidence, then named R3 approval.
- Rationale: preserving the candidate is safe and reversible; exposing it to residents before the open evidence gates is not.
