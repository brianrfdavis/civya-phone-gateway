# Threat Model: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Threat model ID | CIV-20260720-001-TM |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | Reviewed for source candidate; production approval blocked |
| Risk tier | R3 |
| Security/Privacy owner | Named approver TBD before release |
| System owner | Civya Engineering |
| Last updated | 2026-07-20 |

## Scope and objective

- Protect caller dignity, comprehension, agency, privacy, timely next steps, and accurate authority boundaries while changing voice and conversational behavior.
- In scope: phone prompt, built-in Realtime voice configuration, greeting, official lookup contract, deterministic call effects, candidate evidence, and rollback.
- Out of scope: new data stores, durable memory, tools, providers, permissions, identity, payment, eligibility, or production activation.
- Related: `FEATURE_BRIEF.md`, `IMPLEMENTATION_PLAN.md`, Harbor release manifest, existing voice standard, existing phone architecture.

## Assets and consequence

| Asset/outcome | Classification | Required property | Consequence if compromised | Owner |
|---|---|---|---|---|
| Caller dignity and agency | Resident trust | Integrity/accountability | Patronizing, manipulative, or deceptive interaction | Product/UX |
| Correct next-step guidance | Consequential guidance | Integrity/availability | Confusion or missed resident option | Product/Program |
| Live audio/transcript | Confidential when resident context is present | Confidentiality/minimization | Privacy harm | Security/Privacy |
| Official-answer boundary | Internal control | Integrity | Hallucinated date, status, balance, or eligibility | Engineering |
| Harbor rollback | Internal release control | Integrity/availability | Inability to restore approved behavior | Release |

## Actors

| Actor | Legitimate goal/access | Potential misuse or compromise |
|---|---|---|
| Resident | Talk naturally, get a next step, request a person or stop | Prompt injection, abusive use, accidental sensitive disclosure |
| Operator | Configure and roll back voice/profile | Drift, wrong environment value, unauthorized activation |
| OpenAI Realtime | Produce live speech and invoke allowlisted tool | Hallucination, instruction failure, provider outage |
| Civya tool/router | Verify facts and carry out bounded call controls | Incorrect match, tool failure, unsafe effect if guards regress |
| Researcher | Evaluate candidate audio | Stereotyping participants or retaining unnecessary demographic/personal detail |

## Architecture and data flow

```text
Caller audio → existing Twilio/OpenAI SIP boundary → Civya gateway/session
  → Realtime response (Bridge prompt + Cedar candidate)
  → official fact? existing get_official_answer only
  → person/link/end? existing deterministic router only

No new store, integration, permission, tool, demographic field, or retention path.
```

### Trust boundaries

| Boundary | Data/action crossing | Authentication | Authorization | Validation | Logging/redaction |
|---|---|---|---|---|---|
| Telephony → gateway | Call events/audio references | Existing provider verification | Existing access mode/rate controls | Existing schema/signature checks | Existing safe operational logs |
| Gateway → Realtime | Prompt and live audio | Server credential | Model/voice allowlists | Session schema | No secrets/raw social detail in new logs |
| Model → official tool | Zero-argument call bound to current turn | Existing server path | Single allowlisted tool | Approved-answer handler | Existing correlation/redaction |
| Model → call effect | Spoken request transcript | Existing session | Deterministic router only | Negation and intent guards | Existing effect logs |

## Data lifecycle

| Data | Collection purpose | Classification | Storage/processors | Sharing | Retention/deletion |
|---|---|---|---|---|---|
| Live caller audio/transcript | Existing phone response | Confidential if resident context | Existing approved path | Existing providers only | Unchanged |
| Prompt/profile | Runtime behavior | Internal | Source/runtime | Civya/OpenAI session | Versioned |
| Listening-test result | Candidate selection | Internal, de-identified | Approved research record | Product/UX | Define before research; omit unrelated detail |

## Abuse and failure cases

| ID | Threat/abuse case | Preconditions | Impact | Existing control | Gap | Likelihood | Severity |
|---|---|---|---|---|---|---|---|
| T-01 | Voice or prompt performs a racial stereotype | Poor wording or subjective interpretation | Dignity/equity harm | Explicit no-stereotype rule | Requires representative audio review | M | P1 |
| T-02 | Separate persona or missing disclosure implies a human | Greeting/prompt drift | Deception and misplaced trust | Required automated-service opening/test | Harbor wording is not compliant with current standard | M | P1 |
| T-03 | Social conversation becomes pressure or dependency | Overly relational prompt | Manipulation, unnecessary disclosure, delayed action | Voluntary bridge, no false intimacy/memory | Must test multi-turn tangents | M | P1 |
| T-04 | Bridge is too fast and dismisses the caller | Model follows goal too aggressively | Patronizing experience, abandonment | Join-before-bridge contract | Audio eval required | M | P2 |
| T-05 | Bridge never occurs during a time-sensitive issue | Model remains social | Missed next step | Permissioned bridge after answering; official lookup | Scenario coverage required | M | P1 |
| T-06 | Current/official fact is spoken from memory | Prompt/tool regression | Consequential misinformation | Existing mandatory lookup tool and tests | Re-run full phone/official suites | L | P1 |
| T-07 | Prompt growth increases latency or caution | Added instructions | Slow, bureaucratic response | 2,000-char budget, low reasoning | Audio latency comparison required | M | P2 |
| T-08 | Research stores race/emotion or personal side conversation | Poor research process | Privacy/discrimination risk | No demographic inference/storage in product | Research protocol not part of code | M | P1 |
| T-09 | Candidate cannot be rolled back quickly | Tag/config drift | Prolonged resident impact | Immutable Harbor refs and config switch | Sandbox rollback test required | L | P1 |

## AI/model-specific analysis

- Approved use: realtime conversational guidance and bounded tool requests. Prohibited: official decisions, legal/tax advice, demographic inference, false human identity, emotional diagnosis, or relational pressure.
- Prompt/context minimization: no new fields; do not retain unrelated social detail.
- Retrieved/tool trust: existing official-answer path remains authoritative; model may not add facts after approved speech.
- Tool permissions: unchanged single official-answer tool plus deterministic server call effects.
- Output validation: prompt contract, static tests, transcript scenarios, real audio, representative listening, and human release approval.
- Bias/harm evaluation: accents, English opening and post-detection Spanish speech, off-topic conversation, consequential medical/legal/financial/safety topics, distress, stereotype, and equal respect across callers. This candidate adds no new crisis-decision path.
- Provider terms/region/retention: unchanged from existing approved integration; this change does not grant new approval.
- Failure fallback: Harbor rollback and existing human/secure path.
- Safe shutdown: keep Harbor live; do not activate candidate without named approval.

## Mitigation plan

| Threat | Mitigation | Type | Owner | Due | Verification | Residual risk |
|---|---|---|---|---|---|---|
| T-01/T-04 | Explicit dignity rule plus representative PSTN audio evaluation | Prevent/detect | Product/UX | Before activation | Research record | Subjective fit remains human judgment |
| T-02 | One automated-service opening in both supported languages; no separate spoken persona | Prevent | UX/Engineering | Candidate | Tests/audio | Caller may still anthropomorphize |
| T-03/T-05 | Join → permissioned Bridge → Next; voluntary return; no stored social detail; urgent safety first | Prevent/detect | Product/QA | Candidate | Multi-turn scenarios | Model variability |
| T-06 | Preserve official tool instruction and full regression suites | Prevent/detect | Engineering | Candidate | Tests | Provider/model variability |
| T-07 | 2,000-char budget and unchanged low-reasoning/VAD/model | Prevent | Engineering | Candidate | Profile test/latency comparison | Network variance |
| T-08 | Consent-based, de-identified research plan outside product telemetry | Prevent | Product/Privacy | Before research | Approved protocol | Not yet approved |
| T-09 | Immutable refs, release record, config rollback, sandbox exercise | Respond | Release | Before deployment | Rollback evidence | Operator/config error |

## Security test plan

- Re-run existing authorization, call-control, official-answer, rate, and redaction suites in the phone blast radius.
- Inspect the diff for secrets and for new storage/logging of caller content.
- Test prompt injection attempts to bypass official lookup or claim a human identity.
- Test silence, interruption, ambiguous effect commands, negated effect commands, provider/tool failure, and repeated calls.
- Verify model/voice allowlists fail closed and the profile/voice appear in readiness output.
- Verify Harbor Git refs and perform a sandbox rollback before production.

## Residual risk and acceptance

| Risk | Why not further reduced | Compensating control | Approver | Expiration/review |
|---|---|---|---|---|
| Voice cultural fit is subjective | No official demographic voice labels; phone compression changes perception | Representative listening and Harbor fallback | Product/UX + Security/Privacy | Before activation |
| Model behavior varies | Realtime generation is non-deterministic | Tight prompt, deterministic effects, official tool, QA, rollback | Engineering/Release | Every profile change |

P0/P1 residual risk cannot be accepted for release. Candidate implementation may proceed; production activation may not.

## Approval

| Role | Name | Decision | Date | Conditions |
|---|---|---|---|---|
| Security/Privacy | Named human approver TBD | Pending | — | Required before production activation |
| Engineering/Architecture | Independent reviewer | Conditional candidate acceptance | 2026-07-20 | Interrupted-disclosure P1 and live gates must close before activation |
| Product/program authority | Civya owner | Candidate direction approved | 2026-07-20 | No policy change; no deployment |
