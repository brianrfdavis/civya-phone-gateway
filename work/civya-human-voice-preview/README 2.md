# Civya — fictional county voice sandbox

Civya is a voice-first, county-facing demonstration for explaining Wayne
County property-tax topics and guiding a fictional resident through a saved
case. The browser experience is intentionally simple; case ownership,
workflow transitions, transcripts, documents, and staff access are enforced
by Supabase Postgres/Auth/Storage and server-side application policy.

> **Fictional sandbox only.** No real county transaction, payment, submission,
> callback, eligibility decision, or outreach occurs. Program content remains
> draft until it receives county content, legal, privacy, accessibility,
> retention, escalation, and operational approval.

## What is implemented

- Anonymous Supabase identity after the first meaningful interaction.
- Voice-led, inline six-digit email verification before sensitive intake.
- Existing-email case handoff without silently merging cases.
- Authenticated bootstrap that restores the active case, compact summary,
  confirmed facts, current question, and six recent redacted turns.
- Authoritative, idempotent turn processing: save transcript → run the
  deterministic engine → atomically commit facts/workflow → speak only the
  approved result.
- Private document Storage with type/signature/size checks, quarantine, human
  review, and short-lived download links. Raw audio is never retained.
- Protected reviewer/admin pages with invited-account email-code sign-in,
  scoped to the fictional county tenant.
- Admin-created, expiring invitation links; an HttpOnly invitation cookie is
  also bound to the Supabase identity in Postgres and expires with the link.
- CAPTCHA-protected anonymous Auth, local and durable rate limits, redacted
  audit metrics, health probes, and scheduled 30-day cleanup.
- Exact county-demo voice configuration: `gpt-realtime-2.1`, low reasoning,
  `marin` (or `cedar`), `gpt-4o-transcribe`, and 500 ms server VAD with
  automatic model responses disabled.

The former JSON and `/tmp` case runtime has been removed. Supabase is the only
case, conversation, document-metadata, and audit source of truth.

## Pages

- `/` — resident voice/text conversation
- `/case/<case-id>` — authenticated resident case view
- `/staff` — invited county-demo reviewer overview
- `/staff/sign-in` — email-code sign-in for pre-invited reviewer/admin accounts
- `/admin` and `/admin/review` — protected admin/review views
- `/results` — protected redacted operational metrics
- `/access` and `/invite/<token>` — expiring demo invitation flow

URLs do not carry case bearer tokens. The authenticated session owns access.

## Local setup

Requirements: Node 20+, a Supabase project, and an OpenAI API key with
Realtime access.

```bash
npm install
cp .env.example .env.local
```

Apply the SQL files in `supabase/migrations/` in filename order, then apply
`supabase/seed/20260716_fictional_county_demo_v1.sql`. Configure anonymous
Auth, email OTP, and Turnstile in Supabase as described in
`supabase/README.md`.

```bash
npm run dev
```

The hosted sandbox fails closed when Supabase, invitation security, CAPTCHA,
or the qualified voice configuration is incomplete. It offers text mode when
OpenAI voice is unavailable; it never silently downgrades to a mini/preview
model.

## Runtime flow

```text
Resident speech
  → OpenAI Realtime transcription + 500 ms VAD (no automatic response)
  → POST /api/conversations/turn with a stable idempotency key
  → Supabase saves a redacted turn
  → deterministic policy/engine decides the approved result
  → one transaction commits facts, workflow, summary, and assistant turn
  → Realtime speaks that approved text with tool_choice: none
```

Voice reconnect, refresh, and voice/text switching all bootstrap from the
same resident-owned active case. Structured facts are authoritative;
conversation summaries and redacted turns provide conversational continuity.

## Verification

```bash
npm run typecheck
npm run test:persistence
npm run test:voice-experience
npm run test:county-readiness
npm run build
```

`test:persistence` runs in memory with PGlite and applies every migration plus
the fictional seed. It covers 20 voice/text resume cycles, duplicate replay,
stale concurrent writers, retry without lost facts, resident isolation,
direct-write denial, and 31-day cleanup outbox behavior.

The real browser/audio release matrix still requires configured Supabase and
OpenAI environments plus Chrome, Safari, mobile, slow speech, accents,
background noise, reflective pauses, and interruption testing. Passing local
tests does not make this ready for real residents.

## Main implementation areas

```text
app/api/conversations/    authoritative turns and endings
app/api/auth/             anonymous identity and email-code upgrade
app/api/staff/auth/       invited reviewer/admin email-code sign-in
app/api/realtime/         qualified OpenAI Realtime secret minting
app/api/uploads/          validated private document intake
lib/platform/             Supabase repository and ownership boundary
lib/conversation/         public contracts, policy, and deterministic engine
lib/realtime/             WebRTC client, retries, hydration, graceful ending
lib/security/             invitation, CAPTCHA, request, and role safeguards
supabase/migrations/      schema, RLS, RPCs, Storage, retention
supabase/seed/            versioned fictional county scenarios
```

See `HOW-IT-WORKS.md` for the reviewer-oriented architecture and
`docs/county-demo-release-gates.md` for activation and approval gates.
