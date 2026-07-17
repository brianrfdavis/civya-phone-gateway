# How Civya works

This guide describes the current fictional county sandbox. Civya is not a
free-form chatbot: the voice model handles hearing and natural delivery,
while server-side code owns memory, authorization, workflow, and saved facts.

## 1. Identity without a greeting-time login wall

The opening screen does not mention an account. At the first meaningful voice
or text interaction, `/api/auth/anonymous` creates a cookie-backed Supabase
anonymous identity. The hosted route requires a Turnstile token, and the same
CAPTCHA must be enabled in Supabase Auth so public-key Auth calls cannot bypass
the challenge.

That anonymous identity receives one provisional resident, one active case,
and one resumable conversation. A refresh can therefore restore the same
browser session without asking the resident to start over.

General questions remain available anonymously. Before Civya asks for or
saves a name, address, parcel, contact detail, income, ID, document, reminder,
or another saved sensitive action, it explains why an account is needed and
shows the email-code card inside the conversation. Voice capture pauses.

After a six-digit email code is verified:

- a new email is linked to the same anonymous Supabase user, preserving the
  resident, case, conversation, and pending question;
- an existing email receives the current case through a short-lived,
  single-use handoff token;
- if that account already has a case, Civya preserves both and requires an
  explicit case choice before voice or text can resume.

Declining the account step keeps general information available but disables
personal intake, documents, reminders, and saved actions.

## 2. Three reversible voice profiles

The fictional preview defaults to `CIVYA_VOICE_MODE=fast`. Realtime server VAD
detects the end of speech after 500 milliseconds and creates the response
immediately. The full audio model handles ordinary conversation directly;
transcription supplies captions and redacted continuity after response creation,
so it never blocks first audio.

Verified tools remain authoritative for saved facts, official or time-sensitive
information, routing, callbacks, submissions, payments, and other actions. Tool
results include ready-to-speak text and source state. A missing source or failed
write is never represented as verified or saved.

Two fallbacks stay in the codebase:

- `CIVYA_VOICE_MODE=legacy_fast` restores a separately versioned compatibility
  profile based on the July 14 direct-Realtime experience, with current account
  and data-integrity guardrails retained.
- `CIVYA_VOICE_MODE=authoritative` restores the server-first pipeline below.

Non-synthetic and production runtimes force `authoritative`, even if another
mode is requested.

## 3. The authoritative turn pipeline

Realtime server VAD detects that speech ended, but `create_response` is false.
The browser waits for the final `gpt-4o-transcribe` transcript and sends a
`TurnEnvelope` to `/api/conversations/turn`.

The server then:

1. derives the resident, active case, and conversation from the Supabase
   session;
2. saves a redacted resident turn under its idempotency key;
3. runs deterministic policy and intake code;
4. enforces the account gate before sensitive collection;
5. commits structured facts, case version, next question, summary, assistant
   turn, and completion state transactionally;
6. returns a `TurnResult` containing the only text voice is allowed to speak.

The browser sends `response.create` with `tool_choice: none` and instructions
to deliver the approved response without adding claims. Optional model tools
remain available for explicit read/look-up/simulated actions, but they are not
the path by which ordinary conversation becomes durable memory.

Retries reuse the same envelope and idempotency key. A committed replay returns
the same result. Optimistic case versions reject a stale writer; the server
reloads and retries once. Civya never says a failed write was saved.

## 4. Resume and memory

`GET /api/bootstrap` derives ownership from the Auth session and returns:

- authentication and role state;
- resident and active case;
- active conversation;
- confirmed structured facts;
- compact redacted summary;
- six most recent redacted turns across voice/text sessions;
- current workflow state and next question;
- available capabilities.

On refresh, reconnect, Stop/Talk Again, or text/voice switching, both the page
and Realtime session hydrate from this response. Raw audio is never saved.
Browser-supplied case IDs are references only and are checked against the
session-owned active case.

In both fast profiles, resident transcripts are redacted and appended
asynchronously with stable turn keys. Browser-supplied assistant text is not
accepted into trusted resume history. A clearly provided intake answer uses a
narrow allowlisted tool and the existing versioned case commit. Questions,
refusals, repeat requests, and unclear corrections are rejected as facts.

## 5. Supabase boundary

The normalized schema includes tenants, residents, cases, case facts,
conversations, turns, documents, checklist items, consent, review tasks,
reminders, simulated transactions, audit events, staff roles, invitations,
rate limits, transfer grants, and retention cleanup work.

Residents can read only their own tenant records and private files. Invited
reviewers/admins can see only the configured fictional county tenant.
Workflow mutation RPCs and Storage writes are server-only, so a browser cannot
bypass the deterministic turn route or upload validation through the public
Supabase API. RLS remains defense in depth for reads.

The signed invitation cookie is not the database authorization by itself.
On bootstrap, the server verifies that cookie and records an expiring grant
for the current Supabase user and invitation. Resident RLS requires both case
ownership and that live grant. A copied or stale Auth session therefore loses
resident access when the invitation ends.

Rows use versions and unique idempotency constraints. Simulated callbacks,
reviews, reminders, submissions, and payments use dedupe keys. All program
transactions remain visibly fictional.

## 6. Documents

`POST /api/uploads` requires a verified resident session and the active case.
It enforces the request/file size, extension, declared MIME type, and magic
bytes. The object goes into the private `civya-private-documents` bucket under
the tenant/resident/case prefix.

New uploads start as `scan_status = pending`, have no guessed classification
or extraction confidence, and require human review. A normal resident cannot
download a quarantined file—not through the application route or by calling
Supabase Storage directly. Resident Storage RLS exposes only clean objects.
Invited staff retain review access; application downloads require the explicit
quarantine-review purpose, and signed URLs last only briefly.

Retries use an idempotency digest and do not create duplicate metadata or
orphaned object paths.

## 7. Voice reliability

The county-demo route accepts only:

- model: `gpt-realtime-2.1`;
- reasoning effort: low;
- voice: `marin` or `cedar` (`marin` default);
- transcription: `gpt-4o-transcribe`;
- server VAD silence window: 500 ms;
- automatic response creation: on for `fast` and `legacy_fast`, off for
  `authoritative`.

The session response includes the requested mode, effective mode, and frozen
profile version. The client treats the effective mode as immutable, binds each
automatic response and function call to a stable turn, and never submits a
fast transcript to `/api/conversations/turn` for a second answer.

First-audio events record the response mode, profile version, and ordinary/tool
kind. Export the privacy-safe audit events and run
`npm run report:voice-latency -- <events.json-or-jsonl>` to compare sample count,
median, and p95 speech-stop-to-first-audio latency across profiles.

Connection setup is cancellable. The client watches the peer connection, ICE,
and data channel; tries at most two reconnects; scopes queued continuations to
the response that created them; bounds network/response/playback waits; and
falls back explicitly to text without changing saved case state.

When the authoritative result marks the conversation complete, Civya lets the
final audio finish, records the ending, stops every microphone track, closes
the data channel/peer connection, and returns the page to idle.

## 8. Staff, invitations, metrics, and retention

An admin creates an expiring resident-demo invitation inside the protected
dashboard. It is redeemed for an HttpOnly signed demo-access cookie and shown
only at creation time. The cookie tenant must match
`CIVYA_DEMO_TENANT_SLUG`. Hosted deployments fail closed when invitation
protection is omitted. Reviewer/admin pages require a pre-invited Supabase
account, email-code verification, and an active staff role scoped to that
tenant; the demo link never grants a staff role by itself.

Operational events use a strict allowlist. Session/turn identifiers are hashed;
text values are redacted server-side; audit rows live in Supabase rather than
local files or `/tmp`. `/results` is staff-only.

The Vercel cron endpoint runs daily, deletes fictional cases inactive beyond
the tenant's 30-day retention period, and drains a durable outbox for private
Storage objects and orphaned anonymous Auth users. Failures remain queued for
retry and make the worker return an unhealthy status.

## 9. Review status

This repository can demonstrate continuity and safety controls, but it must
not be represented as approved for real residents. Before that claim, the
county must formally own and approve:

- program wording and source freshness;
- privacy notice, consent, retention, and records handling;
- accessibility and language testing;
- escalation staffing and service levels;
- security review, monitoring, incident response, backups, and recovery;
- the full browser/device/audio matrix and latency objectives.

See `docs/county-demo-release-gates.md` for the executable and manual checklist.
