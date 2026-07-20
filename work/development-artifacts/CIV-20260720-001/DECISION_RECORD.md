# Decision Record: Preserve Maya — Harbor v1 and audition Cedar in Civya Bridge v2

| Field | Value |
|---|---|
| Decision ID | CIV-20260720-001-ADR |
| Template version | 1.0.0 |
| Artifact version | 1.0.0 |
| Status | Accepted for candidate implementation; release pending |
| Date | 2026-07-20 |
| Decision owner | Civya owner for product direction; Engineering for candidate structure |
| Affected risk tier | R3 |
| Supersedes/superseded by | None |

## Decision

Name the approved frozen baseline **Maya — Harbor v1** internally, preserve it at immutable Git refs, and build a separate **Civya Bridge v2** candidate on the existing `gpt-realtime-2.1` phone architecture using `cedar` for the contrast audition. Do not assign a race or human identity to the synthetic voice. Determine cultural fit through representative, consented listening research before any production activation.

## Context

The owner wants the current fast, warm voice preserved and wants a voice that may feel more familiar to Black callers, plus a relationship behavior that makes room for general conversation and gently returns to foreclosure help. OpenAI documents available voice identifiers and quality recommendations, but not race or gender. Civya's current resident standard also requires the spoken service to remain Civya, disclose that it is automated, and avoid a separate human-like persona.

## Drivers and constraints

- Preserve the owner's approved experience and a one-step rollback.
- Keep first-response latency and full-sentence behavior.
- Avoid stereotype, deception, demographic inference, and false intimacy.
- Retain official-fact, private-data, human-help, and deterministic call controls.
- Use one concise opening disclosure rather than recurring disclaimers.

## Options considered

### Option A — Keep Marin and change only the prompt

- Benefits: lowest audio risk; exactly matches Harbor voice.
- Costs/risks: does not give the owner a meaningful voice comparison.
- Reversibility: immediate.

### Option B — Cedar candidate on the existing architecture (selected)

- Benefits: one of OpenAI's two quality-recommended voices; clear contrast to current `marin`; no provider or model change.
- Costs/risks: demographic/cultural fit is unknown until heard over PSTN by representative people.
- Reversibility: source/config rollback with no data migration.

### Option C — Add every supported Realtime voice or a custom voice

- Benefits: broader audition pool.
- Costs/risks: larger QA/equity surface; most built-in options are not OpenAI's quality recommendation; a custom voice adds consent, provider, and governance questions.
- Reversibility: built-ins are reversible; custom voice work may create new commitments.

## Rationale

Option B creates a useful comparison while keeping the model, transport, tools, and rollback unchanged. It is the smallest auditable experiment. The choice is about documented quality and contrast, not a claim about racial identity.

## Consequences

### Positive

- Harbor remains recoverable and unchanged.
- The team gains a specific phone candidate to evaluate.
- Relationship behavior has a clear, testable Join → Bridge → Next contract.

### Negative and accepted tradeoffs

- The code cannot prove that Cedar meets the owner's cultural-fit goal.
- One candidate may be rejected after real audio testing.
- The required automated-service opening differs from the exact Harbor wording.

### New obligations

- Representative audio research, including voluntary participation by Black residents.
- R3 architecture, security/privacy, code review, QA, rollback, and named release approval.
- No storage of inferred race, emotion, intimacy, or unrelated personal conversation.

## Guardrails

- This decision does not authorize deployment, a racial claim, a human persona, new memory, or new model authority.
- Revisit if Cedar is not clearly acceptable, PSTN audio creates stereotype or comprehension concerns, or latency/accuracy regresses.
- Rollback: Harbor source/profile plus `marin`.

## Evidence and validation

- Evidence now: Harbor release fingerprints; OpenAI Realtime docs listing voices and recommending Marin/Cedar; Digital.gov plain-language/HCD guidance; Civya canonical standards.
- Assumption: Cedar provides a meaningful audible contrast over the phone.
- Validation: automated regression now; real audio and representative listening before activation.

## Approval

| Role | Name | Decision | Date | Conditions |
|---|---|---|---|---|
| Accountable owner | Civya owner, task direction | Accept candidate direction | 2026-07-20 | No production change in this task |
| Product | Civya owner | Concur | 2026-07-20 | Harbor preserved |
| Engineering/Architecture | Independent reviewer | Pending | — | R3 review required |
| Security/Privacy | Named human approver TBD | Pending | — | Required before release |
