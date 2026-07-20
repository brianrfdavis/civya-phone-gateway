# /autoplan Restore Point
Captured: 2026-07-20T00:21:16-04:00 | Branch: codex/civya-bridge-v2-cedar | Commit: bf58be5

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State
# Implementation Plan: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Plan ID | CIV-20260720-001-PLAN |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | In review |
| Brief | `FEATURE_BRIEF.md` |
| Risk tier | R3 |
| Technical owner | Civya Engineering |
| Last updated | 2026-07-20 |

## Outcome and boundaries

- Approved outcome: preserve the approved Harbor voice release and prepare a faster-than-human-menu, warm Bridge v2 phone candidate that can join a caller's broader conversation and gently return to the property-tax goal.
- In scope: phone prompt, phone voice default/config example, opening copy, tests, candidate release/rollback record, and governed evidence.
- Out of scope: deployment, new memory, new data/tool access, model replacement, browser persona redesign, and claims about a synthetic voice's race or gender.
- Invariants: official facts still require `get_official_answer`; deterministic call-control effects remain unchanged; the prompt stays at or below 2,000 characters; Harbor refs never move.
- Consequential assumptions: `cedar` is only an audition candidate. Human research, not code, determines cultural fit.

## Existing system and reuse

| Need | Existing component/pattern | Reuse/extend/replace | Evidence |
|---|---|---|---|
| Low-latency speech | `services/call-control/phone-fast.ts` | Extend constants and instructions only | `gpt-realtime-2.1`, low reasoning, 500 ms server VAD |
| Current facts | `OFFICIAL_ANSWER_TOOL` and server handler | Reuse unchanged | Existing official lookup tests |
| Safe phone actions | `phone-router.ts` + `openai-sip.ts` | Reuse effects; update opening copy only | Human/link/end commands remain deterministic |
| Rollback | Harbor tag, archive branches, release manifest | Add alias/name and candidate record | `civya-maya-harbor-v1` at frozen source |
| Regression checks | `phone-fast-profile-tests.ts`, `call-control-tests.ts`, voice-experience tests | Extend | Existing latency, voice allowlist, and greeting contracts |

## Proposed change

Keep the architecture and model path unchanged. Create a source-only candidate by setting the phone candidate default to `cedar`, versioning the profile, replacing the prompt's undefined “advocate” behavior with a concise **Join → Bridge → Next** contract, and updating the first-call greeting to the required automated-service pattern. Add tests that lock the prompt budget, disclosure, voluntary bridge, dignity, official lookup, and rollback identifiers.

```text
Caller
  │ live PSTN audio (existing Confidential path)
  ▼
Twilio / OpenAI SIP ── existing webhook + call controls ──► Render phone gateway
                                                        │
                                                        ├─ session config
                                                        │    gpt-realtime-2.1
                                                        │    reasoning: low
                                                        │    voice: cedar (candidate)
                                                        │    prompt: Bridge v2
                                                        │
                                                        ├─ current/official fact
                                                        │       ▼
                                                        │  get_official_answer (unchanged)
                                                        │
                                                        └─ person/link/end
                                                                ▼
                                                           deterministic control

Rollback: Harbor commit/profile + CIVYA_PHONE_REALTIME_VOICE=marin
No schema, memory, permission, or provider-boundary change.
```

### Change map

| Component/file | Change | Contract/invariant | Owner |
|---|---|---|---|
| `services/call-control/phone-fast.ts` | New profile version, `cedar` candidate default, concise relationship prompt | Model/VAD/tool path and 2,000-char budget unchanged | Engineering |
| `services/call-control/phone-router.ts` | One-time automated-service opening in English/Spanish | No repeated disclaimers; deterministic controls unchanged | Engineering/UX |
| `.env.example` | Candidate phone voice example | No credential values | Engineering |
| `scripts/phone-fast-profile-tests.ts` | Lock model, voice, prompt behavior, latency budget | Behavior assertions, not snapshot-only | Engineering |
| `scripts/call-control-tests.ts` | Lock required first-use disclosure and stop/person affordance | Both languages covered | Engineering |
| `docs/releases/civya-bridge-v2-candidate.md` | Candidate identity, evidence, rollout, rollback | Explicitly undeployed until approved | Release |
| `docs/releases/civya-harbor-v1.md` | Record internal Maya alias tag/archive refs | Frozen commit and original tag unchanged | Release |

## Data and lifecycle

- Source of truth: versioned phone profile and release records.
- Schema/state changes: None.
- Classification/minimization: Existing live audio/transcript handling only; no demographic labels, emotional profiles, or unrelated social detail stored.
- Retention/deletion/correction/audit: Unchanged.
- Migration/backfill/reconciliation: None.
- Compatibility and rollback: New calls read the configured profile at session creation. Restore Harbor source and `marin`; existing sessions finish with their original voice because Realtime cannot switch a voice after audio begins.

## Trust and authorization

- Actors: anonymous caller, existing phone gateway, OpenAI Realtime, deterministic Civya tools, approved operator.
- Authentication boundary: Existing webhook/call controls; unchanged.
- Authorization: Existing tenant, tool, and secure-link enforcement; unchanged.
- Validation: Existing model and voice allowlists remain fail-closed.
- Secrets: No secret changes and no secrets in prompts, fixtures, logs, or candidate records.
- Threat model: `THREAT_MODEL.md`.

## Contracts and integrations

| Boundary | Schema/version | Timeout/retry | Idempotency/concurrency | Error/fallback | Observability |
|---|---|---|---|---|---|
| Gateway → Realtime | Existing GA realtime session | Existing behavior | One voice per session | Harbor rollback / human path | Health profile version and existing safe logs |
| Model → official answer | Existing zero-argument tool | Existing server timeout | Existing call correlation | Do not invent; offer source/person | Existing tool metrics/redaction |
| Caller → deterministic effect | Existing transcript router | Existing bounds | Existing negation guards | No effect on ambiguous text | Existing tests/logs |

## Experience implementation

- No new route or screen.
- First use: one natural automated-service disclosure.
- Ordinary turn: answer first, one to three short sentences, one question at most.
- Relationship: join the actual topic; bridge voluntarily after one or two off-topic turns or when the caller is ready; offer one relevant next step.
- Accessibility: familiar words, no jargon/idioms/stereotype, caller may interrupt, pause, change subject, request a person, or stop.
- Content sources: C-002, C-003, Digital.gov plain language/HCD, and the existing voice standard.
- Analytics: No new analytics or demographic inference.

## Failure modes and recovery

| Failure | Detection | User/system behavior | Recovery/reconciliation | Test |
|---|---|---|---|---|
| Prompt becomes long or cautious | Character budget/test and audio review | Candidate is blocked | Shorten instructions; Harbor unaffected | Profile test |
| Response redirects too quickly | Scenario/audio QA | Caller feels dismissed | Strengthen join-before-bridge; retest | Conversation scenarios |
| Response never returns to urgent work | Scenario/audio QA | Caller may miss useful next step | One calm bridge after 1–2 turns; verified urgent fact once | Conversation scenarios |
| Voice feels stereotyped or unsuitable | Representative audio research | Candidate is rejected | Keep Harbor/Marin or test another supported voice | Human audition gate |
| Official fact hallucinated | Tool contract tests | Do not release | Existing lookup path; Harbor rollback | Official research + profile tests |
| Provider/model failure | Existing health and call failure handling | Existing safe path/human option | Roll back or contain; no data migration | Existing phone suites |

## Observability and operations

- Outcome signals: first-response latency, completed sentence, tool success, turn count to next step, human/stop requests, qualitative comprehension and respect.
- Logs: existing redacted operational telemetry only; no new raw social-conversation or demographic logging.
- Diagnostics: profile version and configured voice in readiness health.
- Alert/owner: existing phone gateway operation; product/UX owns candidate research findings.
- Performance: prompt stays within current budget; model, reasoning, transport, VAD, and tools unchanged.
- Runbook: candidate release record plus existing phone activation and rollback runbooks.

## Acceptance-to-verification map

| Criterion | Implementation path | Automated test | Manual/QA evidence | Owner |
|---|---|---|---|---|
| AC-01 | Git refs + Harbor manifest | Ref verification | Restore instructions inspected | Release |
| AC-02 | `phone-fast.ts` | Profile and call-control suites | Latency/audio comparison | Engineering/QA |
| AC-03 | `phone-router.ts` + prompt | Call-control/profile tests | First-call audio in English/Spanish | UX/QA |
| AC-04 | Bridge prompt | Prompt-contract scenarios | Off-topic and voluntary-return audio | UX/QA |
| AC-05 | Dignity rules | Static prompt assertions | Representative resident audition | Product/UX |
| AC-06 | Existing official and secure paths | Official research and phone suites | Current-fact and private-detail call | QA |
| AC-07 | Tag/config rollback | Git/ref/config checks | Sandbox rollback before production | Release |

## Implementation sequence

- [ ] **1. Freeze the baseline** — create immutable Maya alias refs and update the Harbor record; verify exact commit.
- [ ] **2. Implement the candidate** — update profile, prompt, opening, and example config; run targeted tests after each unit.
- [ ] **3. Add candidate evidence** — add release/rollback record, threat model, decision record, and acceptance scenarios.
- [ ] **4. Independent review and QA** — GStack architecture/code/security review, automated suites, build, and voice-focused QA.
- [ ] **5. Handoff without deployment** — identify immutable candidate commit and list remaining human audio/release approvals.

## Rollout and rollback

- Feature stages: source-only candidate → local/sandbox → explicitly authorized limited phone audition → production decision.
- Candidate identity: `codex/civya-bridge-v2-cedar`; profile `civya-bridge-v2-2026-07-20`; immutable commit after validation.
- Health signals: ready endpoint model/voice/profile; latency and complete-sentence evidence; no P0/P1 review finding.
- Stop thresholds: any stereotype/deception finding; repeated disclosure; official-fact bypass; sentence truncation; material latency regression; failed human/stop control.
- Rollback: deploy `civya-maya-harbor-v1`/Harbor commit and set `CIVYA_PHONE_REALTIME_VOICE=marin`; confirm health and place a real test call.
- Non-reversible effect: None.

## Required verification

```text
Static/type checks: npm run typecheck
Targeted suites: npm run test:phone-fast-profile; npm run test:call-control;
  npm run test:official-research; npm run test:voice-experience
Regression: npm test
Build: npm run build
Security/privacy: secret diff, no new data/tool boundary, prompt abuse scenarios
Audio: first use, off-topic join/bridge, current fact, interruption, silence,
  accent clarification, person/stop, complete sentence, Cedar vs Harbor/Marin
Rollback: verify refs/config and perform sandbox restore before production
```

## Decisions and unknowns

| Item | Type | Owner | Due | Effect if unresolved |
|---|---|---|---|---|
| Cedar's cultural credibility over PSTN | Human research unknown | Product/UX | Before activation | Harbor remains live |
| Named Security/Privacy and release approvers | Approval unknown | Civya owner | Before deployment | Do not deploy |

## Plan approval

| Role | Decision | Date | Conditions |
|---|---|---|---|
| Product | Approved for candidate implementation | 2026-07-20 | Preserve Harbor; no production activation |
| UX | Pending independent review | — | Real audio and representative research required |
| Architecture | Pending R3 review | — | No architecture expansion expected |
| Security/Privacy | Pending named approval | — | Required before release |
| QA | Pending | — | Automated and audio scenarios required |

