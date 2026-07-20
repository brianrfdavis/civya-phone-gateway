<!-- /autoplan restore point: /Users/brfdavis/.gstack/projects/brianrfdavis-Civya/codex-civya-bridge-v2-cedar-autoplan-restore-20260720-002116.md -->
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
- In scope: phone prompt, explicit phone candidate configuration, opening copy, a narrow decline/stop control correction, tests, candidate release/rollback record, and governed evidence.
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

Keep the architecture and model path unchanged. Create a source-only candidate by requiring the existing `CIVYA_PHONE_REALTIME_VOICE=cedar` override for the audition, versioning the profile, replacing the prompt's undefined “advocate” behavior with a concise **Join → Bridge → Next** contract, and updating the first-call greeting to the required automated-service pattern. Keep missing configuration on the safe Harbor/Marin default. Correct the deterministic control conflict so “no thanks” can decline a bridge without hanging up while an explicit stop/end request still ends the call. Add tests that lock the prompt budget, disclosure, voluntary bridge, dignity, official lookup boundary, and rollback identifiers.

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
| `services/call-control/phone-fast.ts` | New profile version and concise relationship prompt; safe default stays `marin` | Explicit candidate config uses `cedar`; model/VAD/tool path and 2,000-char budget unchanged | Engineering |
| `services/call-control/phone-router.ts` | Automated-service opening; remove ambiguous `no thanks` hangup and accept explicit stop/end requests | Initial greeting is English; Spanish copy follows reliable language detection; other deterministic controls unchanged | Engineering/UX |
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
- Compatibility and rollback: New calls read the configured profile at session creation. A controlled rollback drains or explicitly ends active calls, restores Harbor source plus the recorded `marin` configuration, then verifies new calls. Realtime cannot switch a voice after audio begins, and a service restart can interrupt an active call.

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
- First use: one natural English automated-service disclosure on each new call; answer identity questions directly. Spanish approved speech follows reliable caller-language detection and requires qualified bilingual review.
- Ordinary turn: answer first, one to three short sentences, one question at most.
- Relationship: join the actual topic; after answering, ask permission to bridge or use an observable cue; offer one relevant next step and respect a decline without repeated redirection.
- Consequential off-topic topics: acknowledge briefly without acting as a medical, legal, financial, personal-safety, or crisis authority; offer an appropriate person or verified official resource and do not turn Civya into a general-purpose adviser. This candidate does not add a new crisis-decision path.
- Accessibility: familiar words, no jargon/idioms/stereotype, caller may interrupt, pause, change subject, request a person, or stop.
- Content sources: C-002, C-003, Digital.gov plain language/HCD, and the existing voice standard.
- Analytics: No new analytics or demographic inference.

## Failure modes and recovery

| Failure | Detection | User/system behavior | Recovery/reconciliation | Test |
|---|---|---|---|---|
| Prompt becomes long or cautious | Character budget/test and audio review | Candidate is blocked | Shorten instructions; Harbor unaffected | Profile test |
| Response redirects too quickly | Scenario/audio QA | Caller feels dismissed | Strengthen join-before-bridge; retest | Conversation scenarios |
| Response never returns to urgent work | Scenario/audio QA | Caller may miss useful next step | One permissioned bridge after addressing the immediate point; verified urgent fact once | Conversation scenarios |
| Voice feels stereotyped or unsuitable | Representative audio research | Candidate is rejected | Keep Harbor/Marin or test another supported voice | Human audition gate |
| Official fact hallucinated | Tool contract tests | Do not release | Existing lookup path; Harbor rollback | Official research + profile tests |
| Provider/model failure | Existing health and call failure handling | Candidate cannot claim a successful fallback until the carrier/human path is proven | Roll back or contain; no data migration | Release-blocking non-AI fallback exercise |

## Observability and operations

- Outcome signals: first-response latency, completed sentence, tool success, and qualitative comprehension and respect. Use only existing approved aggregate operational telemetry in this candidate; do not add demographic or unrelated-conversation analytics.
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

- Feature stages: source-only candidate → automated checks → staged blind prompt-only and voice-only comparisons → explicitly authorized limited phone audition → production decision.
- Candidate identity: `codex/civya-bridge-v2-cedar`; profile `civya-bridge-v2-2026-07-20`; immutable commit after validation.
- Health signals: ready endpoint model/voice/profile; latency and complete-sentence evidence; no P0/P1 review finding.
- Stop thresholds: any stereotype/deception finding; repeated disclosure; official-fact bypass; sentence truncation; material latency regression; failed human/stop control.
- Rollback: deploy `civya-maya-harbor-v1`/Harbor commit and set `CIVYA_PHONE_REALTIME_VOICE=marin`; confirm health and place a real test call.
- Non-reversible resident effects: Code/config are reversible; missed deadlines, interrupted calls, privacy exposure, stereotyping, or lost trust are not. This is why the candidate remains undeployed until release gates pass.

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

## Autoplan review dispositions

| Finding | Disposition | Candidate impact |
|---|---|---|
| Cultural fit cannot be established from a provider voice name | Accepted | Cedar remains an audition only; consented representative PSTN research is mandatory before activation |
| Broad conversation can trigger slow official lookup on unrelated words | Deferred from this candidate | A naïve narrowing can bypass contextual follow-up facts. Preserve the conservative heuristic and design a separate stateful classifier with paired positive/negative tests |
| Cedar default could activate accidentally or leak into renderer mode | Accepted | Keep `marin` as the source default and require explicit, versioned `CIVYA_PHONE_REALTIME_VOICE=cedar` candidate configuration |
| Prompt text alone cannot prove relationship behavior | Accepted | Add deterministic prompt contracts plus a multi-turn transcript/audio evaluation protocol; behavior remains best-effort until human evidence exists |
| Existing Realtime failure path lacks a verified non-AI fallback | Release blocker, outside candidate code scope | Keep candidate undeployed; verify deterministic human/official-phone/secure fallback before activation |
| Existing confidential-audio controls need release evidence | Release blocker, no new data path | Record provider purpose/agreement, retention, region, access, redaction, and authorization evidence before activation |
| Spanish initial copy is unreachable before caller language is known | Accepted | Specify an English new-call opening and reviewed Spanish speech after reliable detection; bilingual and interrupted-disclosure evidence remain release gates |
| “No thanks” currently hangs up, conflicting with a declined bridge | Accepted | Remove ambiguous `no thanks` from end-call detection; add explicit `stop`/`end the call` coverage and quoted/negated control tests |

## NOT in scope

- Production, Twilio, Render, or live environment changes — this task prepares and preserves source candidates only.
- Durable relationship memory — it requires separate consent, correction, retention, and privacy design.
- New non-AI outage routing — verify the existing deterministic fallback before release; architecture changes require a separate governed change.
- Demographic inference or a claim that a built-in voice has a race or gender — cultural fit is evaluated by people.
- Browser/UI redesign — no screen, route, layout, or visual component changes.

## Implementation tasks from review

- [x] Preserve the conservative official-lookup boundary; record the unrelated-conversation latency issue as a separate stateful-classification follow-up.
- [x] Version Bridge v2, keep the safe `marin` source default, and require explicit `cedar` configuration for the audition.
- [x] Install the concise, permissioned Join → Bridge → Next prompt with consequential-topic and dignity boundaries.
- [x] Add the required automated-service opening, correct decline/stop controls, and lock English/Spanish/identity contracts honestly.
- [x] Add the candidate release tuple, blind PSTN evaluation protocol, rollback record, immutable Harbor aliases, and durable call-profile attribution.
- [ ] Complete automated review/QA record; leave PSTN, interrupted-disclosure, bilingual, representative-research, non-AI-fallback, privacy, and named R3 approvals blocked before activation.

## Plan approval

| Role | Decision | Date | Conditions |
|---|---|---|---|
| Product | Approved for candidate implementation | 2026-07-20 | Preserve Harbor; no production activation |
| UX | Pending independent review | — | Real audio and representative research required |
| Architecture | Pending R3 review | — | No architecture expansion expected |
| Security/Privacy | Pending named approval | — | Required before release |
| QA | Pending | — | Automated and audio scenarios required |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` via `/autoplan` | Scope and resident value | 2 | CLEAR FOR IMPLEMENTATION | Candidate kept source-only; staged tests now separate prompt and voice effects; production research remains mandatory |
| Codex Review | `/autoplan` outside voices | Independent second opinions | 5 | CLEAR WITH RELEASE BLOCKERS | Product, engineering, safety, and two CLI voices challenged accidental activation, disclosure claims, measurement, controls, and fallback |
| Eng Review | `/plan-eng-review` via `/autoplan` | Architecture, tests, latency | 2 | CLEAR FOR BOUNDED IMPLEMENTATION | Cedar made explicit opt-in; decline/stop conflict fixed; lookup change deferred; live event-machine, latency, fallback, and audio evidence remain release blockers |
| Design Review | `/plan-design-review` | Visual UI gaps | 0 | NOT APPLICABLE | No screen, route, component, layout, or visual change |
| DX Review | `/plan-devex-review` | Developer-facing product gaps | 0 | NOT APPLICABLE | Implementation terms are internal; Civya Bridge is a resident phone experience, not an API/CLI/SDK product |

**CROSS-MODEL:** All independent voices supported preserving Harbor, treating Cedar as an audition rather than a racial identity, preventing accidental activation, and keeping production blocked pending representative audio, fallback, privacy, and named approvals. The CEO voices disagreed on whether source implementation should precede research; the user's explicit candidate request and immutable rollback make bounded implementation reasonable, while activation remains prohibited.

**VERDICT:** CEO + ENG CLEARED FOR CANDIDATE IMPLEMENTATION; release remains blocked by the named human and live-audio gates in this plan.

NO UNRESOLVED DECISIONS
