<!-- /autoplan restore point: /Users/brfdavis/.gstack/projects/brianrfdavis-Civya/main-autoplan-restore-20260717-121220.md -->
# Civya PSTN Shared Conversation Protocol Plan

**Status:** Public-inbound revision in review; external activation remains gated  
**Date:** 2026-07-17  
**Base branch:** `main`

## Outcome

Give any caller who knows the unpublished Twilio number a way to speak
with Civya through the same authoritative conversation protocol used by the
browser experience. The phone path should respond in the caller's language,
preserve Civya's safety and authority boundaries, and collect privacy-safe call
usage evidence. Audio recording remains disabled for this architecture. Public
inbound admission is bounded by destination validation, concurrency, duration,
per-participant rate limits, and provider spend caps rather than a caller-number
allowlist.

## Confirmed product premises

1. The phone experience should feel like Civya, not a fixed IVR menu.
2. The phone channel should use the existing approved-answer, policy, and
   handoff boundaries instead of creating a second decision engine.
3. Callers may speak in any language the configured Realtime and language
   providers can reliably support; Civya should answer in the detected language
   and offer human help when confidence is insufficient.
4. Caller ID and voice do not establish identity or County case entitlement.
   Anonymous callers may receive public information; private or case-specific
   work moves to a one-time secure link and the existing entitlement flow.
5. The first release uses an unpublished number but accepts calls from any valid
   PSTN caller ID. Caller ID is used only for privacy-safe abuse throttling and
   usage aggregation, never for identity or case entitlement.
6. Usage measurement is required. Store redacted call metadata and categorical
   outcomes only; do not store audio or caller transcripts.

## GStack review decisions

The public-inbound revision supersedes the prior named-tester admission rule.
It preserves the public-information-only authority boundary and replaces the
allowlist with layered wallet-abuse and denial-of-service controls: a valid
destination, a global concurrency cap, a configurable maximum call duration,
per-participant call-rate limits keyed by a secret digest, a provider spend cap,
and an immediate kill switch. Withheld or malformed caller identity fails
closed in the initial public release; every presented valid phone number is
eligible.

The CEO, engineering, and operator/DX reviews agreed on the shared public-answer
boundary, multilingual adaptation, named canary testers, and an unpublished
rollout. Their main challenge changed the recording scope:

1. **Recording stays off for the direct Elastic SIP canary.** Twilio Elastic SIP
   trunk recording begins at ringing or answer and does not provide a safe way
   to start only after mid-call consent on this architecture. A separately
   reviewed Programmable Voice or programmable SIP bridge is required before
   audio recording can be offered.
2. **Caller visibility uses categories and keyed digests, not raw numbers.**
   Public callers receive the alias `public-caller`; Civya persists only a
   tenant-scoped keyed participant digest. Caller ID supports abuse throttling
   and aggregate usage only; it never establishes resident identity or case
   entitlement.
3. **The phone turn endpoint gets a purpose-specific credential.** Requests are
   signed and timestamped with a phone-turn secret distinct from the secure-link
   issuer secret.
4. **Public phone turns get a durable idempotency ledger.** A replay of the same
   provider item returns the identical approved result; reuse with a different
   request digest conflicts.
5. **The first canary runs on one call-control replica.** Per-call speech and
   effect ordering remains process-local until distributed active-call ownership
   is designed.
6. **The dialed Twilio number is validated from the trusted SIP `Diversion`
   header, with `To` retained only as a compatibility fallback.**

## What already exists

- `resolveAnswer` already owns approved public answer selection and human-review
  escalation. The phone path will call it rather than create another knowledge
  engine.
- The browser conversation engine remains the authenticated case/intake path.
  The phone endpoint intentionally does not call `decideTurn`, because anonymous
  calls cannot collect or mutate case facts.
- OpenAI signed incoming-call verification, destination rejection, Realtime SIP
  accept/monitor/refer/hangup control, a 30-minute limit, and provider-event
  deduplication already exist in call control.
- Single-use secure-link SMS and the entitled browser continuation already exist.
- `call_sessions` and `call_events` already provide a redacted lifecycle model;
  they will be wired into the controller without adding transcripts or audio.

## Locked data flow

```text
PSTN caller
  -> Twilio canary number + Elastic SIP (recording: Do Not Record)
  -> OpenAI Realtime SIP transcription
  -> call control
       | verify signed webhook, Diversion destination, valid caller identity
       | enforce global concurrency, per-participant rate, duration, and spend gates
       | serialize by OpenAI item_id
       v
     signed internal /api/internal/phone/turn request
       -> durable phone_turn claim / replay
       -> public-phone policy (no case lookup or mutation)
       -> resolveAnswer approved public content
       -> bounded locale detection + translation of approved text only
       -> persist approved result, never caller transcript
       v
     Realtime speaks returned approved text
       -> deterministic secure-link / transfer controls
       -> redacted lifecycle outcome and duration
```

## State and authority boundaries

```text
Provider event:  received -> accepted -> attached -> ended
Phone turn:      claimed -> approved -> spoken | safe_fallback
Call speech:     idle -> resolving -> queued -> speaking -> idle
Recording:       disabled (only valid state for this canary)

Model may: detect language, translate already-approved speech, classify an
approved public-information intent.

Model may not: identify a resident, select a case, state a private balance or
deadline, decide eligibility, send an SMS, transfer a call, record audio, or
claim an official action completed.
```

## Implementation state

- The purpose-specific signed phone-turn route, durable transcript-free replay
  ledger, public-information policy, bounded language adapter, caller registry,
  redacted call lifecycle, turn ordering, and readiness/preflight checks are
  implemented and covered by repository contracts.
- Ordinary phone questions now use the shared approved-answer resolver. Local
  deterministic controls retain sole authority for secure-link consent, human
  transfer, ending a call, outage rescue, and emergency wording.
- PSTN remains disabled in local and Render configuration. No Twilio, OpenAI,
  or hosting credentials are available in this workspace, so a number/trunk
  cannot be configured or dial-tested here yet.

## Architecture decision

Add a narrow internal phone-turn API owned by the web application. The
always-on call controller sends each final transcript with a stable call/turn
idempotency key and a service credential. The API:

1. verifies the service credential and tenant binding;
2. rejects sensitive/case-specific disclosure and requests a secure handoff;
3. resolves public questions through the same approved-answer resolver and
   Civya policy used by browser turns;
4. returns an approved canonical response plus effect directives;
5. adapts only that approved response into the caller's language through a
   bounded language-only model step; and
6. records only redacted lifecycle and outcome metadata.

The Realtime model remains the speech/transcription transport. It must not
invent facts, decide eligibility, alter case state, or independently choose
effects.

## Work plan

### 1. Shared phone-turn contract

- Define the internal request/result contract, locale-confidence metadata,
  allowed effects, payload limits, and stable idempotency rules.
- Add a service-authenticated internal route with exact tenant binding and
  rate limiting.
- Reuse the approved-answer resolver and policy boundaries for anonymous public
  information.
- Route sensitive, identity, case, payment, urgent legal, and unsupported
  language requests to safe secure-link or human-handoff responses.

### 2. Multilingual approved speech

- Detect the caller's language without treating language classification as an
  authority decision.
- Translate only server-approved speech, preserving numbers, dates,
  limitations, URLs, program names, and uncertainty markers.
- Validate output shape and fall back to approved English or a human-language
  assistance response if the language step fails or confidence is low.
- Carry the resolved BCP 47 locale through the call session and speech events.

### 3. Call controller integration

- Replace the keyword router as the ordinary turn path with the internal
  phone-turn client.
- Keep deterministic local handling for secure-link consent,
  human transfer, ending, outage rescue, and emergency disclaimers.
- Preserve ordered response delivery, interruption handling, a maximum call
  duration, signed-webhook verification, destination validation, public-caller
  admission controls, and durable provider-event deduplication.

### 4. Privacy-safe usage and recording control

- Persist call start/end, duration, locale category, outcome, transfer/link
  result, and error category without raw phone numbers, raw transcripts, or
  audio.
- Accept any valid presented PSTN caller identity and persist only a public
  caller category plus tenant-scoped keyed participant digest.
- Enforce a configurable per-participant call-rate limit using the digest, a
  global concurrent-call cap, a maximum duration, and a provider spend cap.
- Set the only supported recording state to `disabled` for this direct Elastic
  SIP path. Readiness fails if any other application recording mode is
  configured.
- Treat consented audio recording as a separate architecture and approval
  project. Do not imply that the direct SIP canary can activate it later by
  configuration alone.

### 5. Deployment and canary activation

- Add required phone-turn and explicit recording-disabled configuration to
  the environment schema, readiness probe, example environment, and runbook.
- Deploy the always-on call controller and web route with PSTN still disabled.
- In Twilio, attach one unpublished number to a dedicated Elastic SIP trunk
  pointed at the OpenAI project SIP endpoint.
- Configure the signed OpenAI incoming-call webhook and secret stores.
- Run end-to-end calls from multiple unrelated numbers in several languages,
  plus recording-disabled verification, rate/capacity rejection, secure link,
  human transfer, outage, wrong destination, duplicate webhook, spend cap, and
  kill switch tests before enabling public inbound access.

## Test plan

- Contract tests for service authentication, tenant mismatch, payload limits,
  idempotency, and replay.
- Public-answer parity tests between browser/public resolution and phone turns.
- Multilingual tests that preserve approved facts and limitations across at
  least English, Spanish, Arabic, Bengali, and French, plus unsupported/low
  confidence fallback.
- Privacy tests proving logs, events, metrics, and errors contain no raw phone
  number, transcript, audio URL, case identifier, or secret.
- Recording-guard tests proving runtime readiness fails unless recording mode is
  explicitly `disabled`, plus a provider-console check that the trunk is set to
  **Do Not Record**.
- Call-control tests for ordering, interruption, retry, duplicate webhook,
  transfer/link effects, maximum duration, per-participant throttling, public
  caller admission, withheld/malformed identity rejection, and safe failure.
- Typecheck, full automated verification, GStack review, and browser/phone QA.

## Explicitly not in this change

- Treating caller ID or voice biometrics as identity.
- Reading or mutating an entitled County case entirely by phone.
- Collecting payment credentials or other high-risk private information by
  voice.
- Advertising, publishing, or porting an official County number. The purchased
  test number remains unpublished even though inbound admission is open.
- Enabling undisclosed recording.
- Deploying to production without the canary gates and provider/account access.

## External dependencies

- Access to the existing Twilio account, an unused or new test number, and an
  Elastic SIP trunk.
- Access to the approved OpenAI API project and webhook settings.
- Hosted Render, Vercel, and Supabase secret/configuration access.
- Legal/privacy confirmation of the no-audio, no-transcript canary metadata
  treatment. Any future recording project needs its own architecture and review.
- A staffed human-transfer destination and an approved secure SMS sender.

## Failure modes and safe behavior

- Missing or invalid Twilio/OpenAI/phone-turn configuration keeps PSTN
  unready and returns a service-unavailable result; credentials alone cannot
  open the gate.
- A missing or malformed caller identity, wrong dialed number, invalid
  signature, malformed body, exhausted rate/capacity/spend gate, or excessive
  request is rejected before an automated call is accepted.
- Any recording mode other than explicit `disabled` prevents readiness. The
  Twilio trunk must independently show **Do Not Record**.
- A duplicate provider event or phone turn replays durable state rather than
  repeating call acceptance or answer generation.
- Sensitive or identifier-like speech never reaches public answer resolution;
  Civya offers a secure link or human route without echoing the input.
- Low-confidence or structurally unsafe translation falls back to the approved
  English text. No translation may introduce an effect or case authority.
- Effects run only after OpenAI reports the approved announcement completed.
  Interrupted or incomplete speech cannot send a link, transfer, or end a call.
- The first canary is limited to one call-control replica. A restart closes
  active calls safely; multi-replica active-call ownership is deferred.

## Verification evidence

- `npm test`: all project suites passed, including all 28 database migrations,
  provider contracts, call control, phone-turn boundaries, secure links,
  worker startup, privacy, and production security tests.
- `npm run build`: Next.js production build completed successfully and emitted
  the internal phone-turn route.
- Focused phone contracts passed for signed requests, durable replay readiness,
  named tester admission, keyed digests, multilingual approved speech,
  sensitive-input blocking, and recording fail-closed behavior.
- Public caller admission and rate/spend gate coverage are part of this revision
  and are not yet implemented or verified.
- Live Twilio/OpenAI/Render configuration and a real dial test remain
  external-state checks. This workspace and the connected browser are signed
  out of all three services; the connected Vercel account has no Civya project.

## Activation handoff

1. Sign in to Twilio, the OpenAI API Platform, and Render in the available
   browser or provide an approved account connection.
2. Confirm the public-inbound gate values: maximum simultaneous calls, maximum
   duration, calls per participant per hour, and provider spend cap.
3. Choose an unused Twilio number or approve purchasing one, and provide the
   staffed transfer destination if transfer testing is required.
4. Configure the unpublished number/trunk/webhook/secrets with recording set to
   **Do Not Record**, run `npm run phone:preflight`, and keep PSTN disabled until
   the preflight is clean.
5. Place calls from multiple unrelated numbers, inspect redacted call records
   and rate-limit behavior, then enable the unpublished public-inbound number.

## GSTACK REVIEW REPORT

- CEO review: clean after narrowing the first release to named testers,
  privacy-safe usage records, and no recording.
- Engineering review: clean after adding the durable phone-turn ledger,
  purpose-specific signing, HMAC references, ordered effects, explicit
  recording-disabled readiness, public-only authority, and one-replica scope.
- Developer-experience review: clean after correcting the direct Elastic SIP
  callback assumptions, documenting `Diversion`, adding a preflight command,
  exact configuration names, and a treasurer test card.
- Pre-landing review: no unresolved code findings after fixing sensitive-input
  redaction, explicit recording configuration, response/effect ordering, and
  configuration-name drift.
- Automated QA: full tests and production build pass. Browser/phone QA is
  externally blocked because the provider accounts are signed out and there is
  no live canary number.
- Unresolved: authenticate Twilio, OpenAI, and Render; provide the named tester calling numbers, select the canary number, and complete one real dial test.
