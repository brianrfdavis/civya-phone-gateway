# Civya — Wayne County controlled-launch MVP

Civya is a voice-, phone-, and text-first civic service for helping Wayne County residents understand an urgent property-tax notice, navigate payment-plan steps, prepare documents, stay on track, and reach an authorized person. The repository contains both a credential-free synthetic environment and the production-shaped controls required for a County-controlled launch.

The application is intentionally staged. Code completeness does not activate County data, payments, phone numbers, identity proofing, or resident outreach. Those integrations remain off until the corresponding County/provider agreement, credential, content approval, operational owner, and launch evidence are recorded.

## What is implemented

- Five versioned resident workflows with deterministic transitions, explicit recovery, and authoritative completion evidence.
- Supabase Postgres/Auth/private Storage with tenant isolation, production case entitlements, staff roles, legal holds, retention schedules, immutable audit chains, and RLS.
- Separate account and case-access boundaries: email, Google, Apple, LinkedIn, and passkeys can protect Civya progress; none opens a Wayne County case by itself.
- Private document quarantine, type/signature/size checks, scanning/review boundaries, and short-lived downloads. Raw audio is never retained.
- Durable leased jobs with heartbeats, retries, dead-letter/replay, provider deduplication, outbox delivery, and external-operation idempotency.
- Entitled resident SMS reminders with explicit per-case consent, quiet-hours and suppression checks, generic secure-link content, crash-safe Twilio acceptance, and signed delivery receipts. Sandbox reminders remain visibly simulated and send nothing.
- Browser voice with `gpt-realtime-2.1` and server-approved responses; text remains available when voice is unavailable.
- PSTN call control for Twilio Elastic SIP Trunking → OpenAI Realtime SIP. The `phone_fast` profile uses `gpt-realtime-2.1`; source defaults safely to the frozen Harbor v1 Marin voice, while Cedar can be selected explicitly for the Bridge v2 candidate audition. It calls the approved public-answer boundary before stating current or official facts. An explicit `renderer` rollback uses `gpt-realtime-2.1-mini` and speaks only deterministic approved text. Both profiles retain signed webhooks, secure-link and human-transfer controls, and no model authority over consequential decisions.
- Direct hosted Wayne/J.P. Morgan Chase and DocuSign handoff contracts. Civya never collects card or bank credentials, and a browser return never proves completion.
- Protected staff operations with host-resolved tenant isolation, confirmed-user email OTP, exact active reviewer/admin roles, owned exceptions, review queues, recovery, workflow controls, and evidence chronology.
- Split liveness/readiness/dependency health, pause-all and channel/provider kill switches, privacy-safe telemetry, release evidence, rollback, and activation runbooks.

## Product surfaces

- `/` — resident voice/text conversation and progressive sign-in
- `/services` — five launch workflows
- `/trust` — plain-language privacy, identity, payment, document, and voice boundaries
- `/case/<case-id>` — entitled resident case view
- `/staff` and `/staff/operations` — tenant-bound authorized staff review and launch operations
- `/admin`, `/admin/review`, `/results` — protected administration and redacted metrics
- `/api/health/live`, `/api/health/ready`, `/api/health/dependencies` — operational probes

Case identifiers are never bearer credentials. An authenticated account, a valid scoped entitlement, tenant policy, and server/RLS checks all apply independently.

## Ten-minute local setup

Requirements: Node 22 and npm 10. Provider credentials are not required for the local slice.

```bash
nvm use
npm ci
npm run setup:dev
npm run dev
```

`npm run slice` executes the complete synthetic source → case entitlement → workflow → hosted-handoff receipt → authoritative reconciliation → completion-evidence path without a browser or external account.

For a hosted sandbox, copy `.env.example` to `.env.local`, apply every SQL file in `supabase/migrations/` in filename order, then apply `supabase/seed/20260716_fictional_county_demo_v1.sql`. Configure Supabase Auth/private Storage and only the provider modes being tested.

## Runtime shape

```text
Resident web/voice ── Vercel Next.js ── Supabase Auth/Postgres/private Storage
          │                    │
          │                    └── durable jobs/outbox/provider receipts
          │
Phone ── Twilio SIP ── OpenAI Realtime SIP ── Render call-control runtime
                                               │
                                               ├── phone_fast conversation + official lookup
                                               ├── renderer rollback + approved speech
                                               ├── secure web-resume link
                                               └── authorized human transfer

Wayne/JPM/DocuSign/CLEAR ── typed adapters + signed webhooks + reconciliation
```

Models handle language and delivery only. Deterministic policy and authoritative sources own case selection, identity/entitlement, eligibility, deadlines, amounts, routing, provider status, and completion.

## Verification

```bash
npm run doctor
npm run verify:fast
npm run test
npm run build
```

The complete test gate applies all migrations in PGlite and checks retained sandbox continuity, resident isolation, direct-write denial, concurrency, retention, audit integrity, durable jobs, account/entitlement boundaries, provider signatures/replay/deduplication, the five workflow kernels, browser voice safeguards, and phone routing.

Hosted release evidence still requires configured Supabase and selected providers plus browser, mobile, screen-reader, voice/noise/accent, load, restore, rollback, and real webhook tests. Passing local tests never substitutes for County acceptance or provider activation.

Live reminders remain fail-closed until the County approves the consent text and non-sensitive template, Twilio approves the sender/A2P registration, STOP handling has an operational owner, and a signed acceptance/delivery test succeeds. The foundation worker must run both `foundation.outbox.dispatch` and `outbox.reminder.delivery.requested`; Twilio acceptance alone is not delivery evidence.

## Main implementation areas

```text
app/api/auth/              email, OAuth, passkey, recovery and linking
app/api/entitlements/      separate Wayne County case verification
app/api/conversations/     authoritative browser text/voice turns
app/api/webhooks/          signed OpenAI, Twilio and payment receipts
lib/workflows/             five versioned deterministic workflows
lib/jobs/ + workers/       leased work, outbox and always-on runtime
lib/integrations/          provider contracts and reconciliation boundaries
services/call-control/     Realtime SIP call controller and approved router
supabase/migrations/       tenancy, RLS, evidence, jobs, audit and channels
docs/runbooks/             release, rollback and provider activation
```

Start with [the developer guide](docs/development/README.md), [the release runbook](docs/runbooks/release.md), and the repository-level Wayne County technology roadmap.
