# Feature Brief: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Brief ID | CIV-20260720-001 |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | Approved for candidate implementation; production release not approved |
| Product owner | Civya owner; direction recorded in the 2026-07-20 task |
| Risk tier | R3 |
| Target release | Civya Bridge v2 candidate |
| Last updated | 2026-07-20 |

## Executive outcome

**For** Wayne County residents who may be stressed, skeptical of institutions, or carrying concerns beyond a property-tax notice, **Civya will** respond with warmth to the person in front of it and then gently connect the conversation to the resident's stated property-tax goal, **so that** callers feel respected without losing the next useful step. **We will know it worked when** representative callers understand the response and next step, conversations remain fast and complete, and no group experiences a meaningfully worse comprehension, trust, or completion result.

## Problem and evidence

### Current journey

Maya — Harbor v1 is the owner's approved fast baseline: `gpt-realtime-2.1`, `marin`, low reasoning, short turns, and verified lookups for current facts. It is useful and direct, but its prompt does not define what to do when a caller wants ordinary conversation before returning to a foreclosure concern. The owner also wants to audition a voice that may feel more culturally familiar to Black callers without sounding bureaucratic, patronizing, or stereotyped.

The OpenAI Realtime API does not publish racial identities for synthetic voices. Its current documentation lists the available voices and recommends `marin` or `cedar` for best quality. Therefore this change treats cultural fit as a research outcome to be evaluated by people, not as a race assigned in code.

### Why now

The live phone experience has just reached a fast, complete-sentence baseline. This is the safe point to freeze that release and explore one bounded voice/personality fork without changing model architecture or official-fact controls.

### Premise challenge

- Cost of doing nothing: callers who need a moment of human-scale conversation may experience Civya as transactional, while the team has no disciplined way to audition a different voice.
- Non-software alternative considered: train human navigators only. Human support remains necessary, but it does not improve the automated first response or 24-hour availability.
- Smallest complete response: one versioned prompt-and-voice candidate using the existing Realtime path, with the original release preserved and an explicit audio/user-test gate.

## People and contexts

| Group | Goal | Context/constraint | Potential harm if wrong |
|---|---|---|---|
| Wayne County resident | Feel heard and identify a workable next step | Phone audio, stress, varied accents and language, limited time | Patronizing tone, confusion, missed urgent step, or false trust |
| Black residents and other residents underserved by public systems | Hear a voice and manner that feel respectful and culturally credible | No synthetic voice has an authoritative racial label | Stereotype, caricature, exclusion, or a claim unsupported by evidence |
| Resident operations | Preserve a fast, consistent, supportable service | Human handoff capacity may be limited | Automation implies unavailable help or prolongs a critical call |

## Policy and source of truth

| Rule/content | Approved source | Accountable owner | Version/effective date | Interpretation needed? |
|---|---|---|---|---|
| Resident relationship, automation disclosure, consent, human help | `canonical/active/C-002_RESIDENT_RELATIONSHIP_AND_SAFETY_STANDARD.md` | Product / Resident Operations | 1.0.0, in review, 2026-07-18 | No for candidate; owner approval still required for activation |
| Calm, clear, non-patronizing voice and brand identity | `canonical/active/C-003_BRAND_VOICE_AND_MESSAGING.md` | Brand / GTM | 1.0.0, in review, 2026-07-18 | No for candidate |
| Risk, review, evidence, and release gates | C-009 and `canonical/development-harness/` | Product / Engineering | 1.1.0, 2026-07-19 | No |
| Plain language and human-centered design | Digital.gov plain-language and HCD guidance | U.S. General Services Administration | Retrieved 2026-07-20 | No; alignment is not federal certification |
| Model and supported voice choices | OpenAI Realtime documentation | OpenAI | Retrieved 2026-07-20 | No; demographic fit is not documented |

## Scope

### In scope

- Preserve the exact approved phone behavior as the internal release **Maya — Harbor v1** with immutable rollback refs.
- Create a separate **Civya Bridge v2** candidate using the existing `gpt-realtime-2.1` phone path and `cedar` as the contrast voice.
- Add concise relationship behavior: join the caller's topic, bridge to the goal when appropriate, and offer one next step without forcing the transition.
- Use one natural automated-service disclosure in the opening, with no routine repeated disclaimers.
- Add prompt, configuration, regression, safety, rollback, and release-candidate evidence.

### Explicitly out of scope

- Production deployment or Twilio/Render configuration change — requires an explicit go-live request and R3 approvals.
- New durable memory, caller profiling, emotion inference, or demographic inference.
- New model tools, data sources, external integrations, or authority to make official decisions.
- A claim that `cedar` is Black, male, female, or ethnically specific.
- Browser voice/UI behavior beyond direct shared contract regressions.

### Prohibited behavior

- Imitating a racial, regional, or cultural stereotype; changing dialect to perform a protected identity; or telling callers that the voice has a race.
- Pretending to be human, a friend, a county employee, a lawyer, a tax professional, or an official decision-maker.
- Using social conversation to pressure disclosure, prolong engagement, or delay a time-sensitive verified next step.
- Saving unrelated personal conversation or inferred emotional/intimacy signals.
- Repeating identity or limitation language on ordinary turns after the opening.

## Target journey

1. Civya opens once as an automated service, says it can help with the next safe step, and makes human help and stopping visible.
2. Civya answers or acknowledges what the caller actually said in short, familiar language.
3. After answering the immediate point, Civya uses **Join → Bridge → Next** only with an observable cue or a permissioned offer such as “If you want, we can get back to the tax notice.” It does not infer emotion or redirect on a rigid turn count.
4. If the caller declines the bridge, Civya respects the choice and does not keep redirecting. It may calmly surface a verified time-sensitive risk once when that affects the caller's options. Urgent safety needs take priority over a foreclosure bridge.
5. Current or official facts still require the approved lookup tool. Private case detail still moves to the secure path. Human and stop requests still use deterministic call control.

### Required states

| State | Applies? | Intended behavior/content | Evidence owner |
|---|---:|---|---|
| First use | Yes | One brief automated-service opening; no false persona | QA |
| Loading/tool lookup | Yes | Short natural bridge such as “Let me check that.” | QA |
| Empty/silence | Yes | Remain quiet; do not fill the caller's thought | QA |
| Partial/interrupted speech | Yes | Stop, listen, and continue without repeating unplayed content | QA |
| Unclear speech | Yes | Ask one short clarification without blaming accent or caller | QA |
| System/provider error | Yes | Preserve call control and offer the safe human/secure path | QA |
| Success/confirmation | Yes | State the next step plainly and pause | QA |
| Resume/correction/support | Yes | Caller may correct, change subject, request a person, or stop | QA |

## Data, privacy, and security

| Data element | Purpose | Classification | Source | Recipient | Retention/deletion |
|---|---|---|---|---|---|
| Live caller audio/transcript | Realtime response and existing phone workflow | Confidential when it contains resident context | Caller | Existing OpenAI/Twilio/Civya path | Unchanged; governed by existing controls |
| Prompt/profile version | Runtime behavior and rollback | Internal | Source control | Civya runtime/operations | Version history |
| Candidate audio evaluation notes | Compare comprehension, trust, and fit | Confidential until approved de-identification; self-identified demographics are always optional | Approved research session | Product/UX | Approved purpose, access, and bounded retention; no unrelated personal detail |

- New trust boundaries or integrations: None.
- Authentication/authorization changes: None.
- Consent/notice/records implications: No new retention or memory; automated-service notice remains mandatory.
- AI/model role: fallible conversational guidance only. Official facts remain tool-verified; deterministic controls retain call effects.
- Threat model required: Yes, because this is material AI behavior in a consequential resident journey.

## Risk classification

- Tier and rationale: **R3**. The implementation is reversible and adds no tool/data authority, but it materially changes AI behavior in a foreclosure journey.
- Highest risk dimensions: resident consequence High; equity/access High; novelty Medium; detectability Medium; reversibility Low; data and authorization unchanged.
- Required roles and gates: Product, UX/content, Architecture, Security/Privacy, independent code review, voice/audio QA, rollback, and named release approval.
- Named approvers: Civya owner for product direction; Security/Privacy and release approvers remain **TBD before any production activation**.
- Conditions that raise the tier: any change to eligibility, official status, payment, identity, legal advice, stored memory, or autonomous tool authority.

## Acceptance criteria

1. **AC-01 — Frozen rollback baseline**  
   Given the approved live behavior, when a future operator needs to restore it, then immutable `civya-maya-harbor-v1` tag and archive branches resolve to the frozen Harbor source and the rollback instructions identify the required `marin` configuration.

2. **AC-02 — Fast contrast candidate**  
   Given Bridge v2 in `phone_fast` mode with the explicit candidate configuration, when the Realtime session is built, then it uses `gpt-realtime-2.1`, low reasoning, `cedar`, the existing 500 ms VAD, unlimited per-turn audio allowance, and a prompt within the 2,000-character latency budget. Missing candidate configuration remains on the safe Harbor/Marin default.

3. **AC-03 — Honest opening without disclaimer repetition**  
   Given a new call, when Civya greets the caller, then the initial English opening identifies it as an automated service and exposes human help and stopping. After a caller asks for Spanish or Spanish is reliably detected, subsequent approved speech uses the reviewed Spanish copy. Civya answers identity questions directly without routine repetition.

4. **AC-04 — Relationship behavior**  
   Given a caller raises an ordinary off-topic concern, when Civya responds, then it first addresses or acknowledges that concern and later offers a voluntary bridge to the caller's property-tax goal using one useful question or next step.

5. **AC-05 — Dignity and equity**  
   Given any accent or cultural background, when Civya speaks or clarifies, then it avoids stereotypes, does not assign a race to the voice, does not diagnose emotion, and does not blame the caller. Production activation is blocked until consented, representative PSTN audio evaluation is completed.

6. **AC-06 — Authority and privacy unchanged**  
   Given a request for a current/official fact or private case detail, when Civya responds, then it uses the existing approved lookup or secure/human path and never invents an official fact or asks for prohibited credentials.

7. **AC-07 — Safe rollback**  
   Given a failed audition or regression, when operations restores the Harbor release and `marin`, then no data migration or backfill is required and new calls return to the prior behavior.

## Success and guardrails

| Measure | Baseline | Target | Window | Data owner | Guardrail/segment check |
|---|---:|---:|---|---|---|
| First-response latency | Harbor v1 observed baseline; exact percentile TBD | No material regression versus Harbor | Candidate calls | Engineering | Compare p50/p95 on same transport |
| Complete spoken thought | Harbor v1 accepted | 100% in scripted sample | Candidate QA | QA | No numeric output-token cap |
| Next-step comprehension | Harbor blind-comparison baseline | Bridge is not worse than Harbor by more than 0.25 on a five-point comprehension scale | Resident research | Product/UX | Same PSTN scripts and randomized order; review overall and voluntary participant segments |
| Respect/cultural credibility | Harbor blind-comparison baseline | Bridge improves at least one primary experience dimension by 0.25 or more, is not worse than Harbor by more than 0.25 on warmth, respect, trust, naturalness, or “not talked down to,” and has no substantiated stereotype/caricature concern | Resident research | Product/UX | Recruit Black residents and other Wayne County callers through affirmative, optional consent; results are directional, not a racial label |
| Disclosure recall | Required | Caller understands service is automated without repeated disclaimers | Candidate QA | Product/UX | One natural opening only |

## Dependencies and constraints

- Existing OpenAI Realtime, Twilio/OpenAI SIP, Render gateway, and official-answer tool.
- Phone audio compresses voice characteristics; web demos are not a substitute for a real PSTN audition.
- Supported candidate voices remain `marin` and `cedar` because OpenAI recommends them for quality.
- Voice quality and demographic resonance require human evaluation; code inspection cannot establish them.

## Rollout and support intent

- Intended rollout: source candidate → automated checks → blind staged comparison (Harbor voice/prompt, Bridge prompt on Marin, Harbor prompt on Cedar, then Bridge prompt on Cedar) → explicitly authorized limited phone audition → owner decision. This separates voice and behavior effects before considering the combined candidate.
- Feature control/containment: immutable source tag plus `CIVYA_PHONE_REALTIME_VOICE`; restore Harbor commit/profile and `marin` to roll back.
- Resident communication: one accurate automated-service opening. No public announcement in this task.
- Support: existing deterministic human request and secure-link paths.
- Measurement review: before production activation and after a limited audition if authorized.

## Open decisions

| Decision | Owner | Due | Default if unresolved | Status |
|---|---|---|---|---|
| Does `cedar` meet the intended cultural-fit goal over PSTN audio? | Civya owner + representative resident research | Before production activation | Keep Maya — Harbor v1 / `marin` | Open; requires audio audition |
| Who grants Security/Privacy and R3 release approval? | Civya owner | Before deployment | Do not deploy | Open |

## Approval

| Role | Name | Decision | Date | Conditions |
|---|---|---|---|---|
| Product | Civya owner, recorded task direction | Approve candidate implementation | 2026-07-20 | Preserve Harbor; no production change without explicit authority |
| Program/policy | Not required for candidate | N/A | 2026-07-20 | No policy or eligibility change |
| UX/content | Independent review required | Pending | — | Evaluate prompt and real audio |
| Engineering/Architecture | Independent review required | Pending | — | Confirm no architecture/trust-boundary change |
| Security/Privacy | Named human approver TBD | Pending | — | Required before any R3 release |
