# Civya Bridge v2 independent review outcome

- Branch: `codex/civya-bridge-v2-cedar`
- Change: `CIV-20260720-001`
- Risk: R3
- Reviewed: 2026-07-20
- Context: independent read-only subagent plus builder re-review
- Status: source candidate accepted with production release blocked

## Scope check

Clean. The diff preserves Maya — Harbor v1, creates a separate explicit-Cedar
candidate, changes the phone relationship prompt/opening, corrects end-call
controls, adds durable profile attribution, and updates candidate/rollback
records. It does not deploy, add memory, change the model/tool boundary, or add
a new crisis-decision path.

## Findings and dispositions

1. **P1 open release blocker — interrupted opening disclosure.** The service
   enqueues the automated-service disclosure once, but the current SIP event
   machine does not prove that it is replayed after caller barge-in. The
   candidate remains undeployed; real SIP interruption evidence and any needed
   state-machine correction are required before activation.
2. **P2 resolved — negated stop requests.** “Do not stop the call” could have
   ended the call. Negation now includes `stop`; direct, polite, negated, and
   explanatory phrases have regression coverage.
3. **P2 resolved — candidate attribution.** The profile version was visible in
   process health but absent from durable call evidence. Model, voice, response
   mode, and profile version are now captured once per call and attached to
   connected and terminal redacted lifecycle metadata.

## Verified

- Phone prompt length: 1,872 characters (budget: 2,000).
- Missing/invalid voice configuration: Marin; explicit candidate: Cedar.
- Model: `gpt-realtime-2.1`; reasoning: low; VAD silence: 500 ms.
- Official-answer tool and conservative lookup triggers unchanged.
- Focused phone tests, full repository tests, TypeScript checks, foundation and
  security suites, and production build passed.

## Release blockers

Representative blind PSTN listening, p50/p95 latency, complete-thought and
interruption evidence, interrupted disclosure, qualified Spanish, non-AI
fallback, privacy/research approval, and named R3 approvals remain mandatory.
