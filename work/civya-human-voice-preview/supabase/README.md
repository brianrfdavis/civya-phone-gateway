# Civya fictional county-demo data service

This directory replaces the Vercel `/tmp` JSON store on the hosted demo path.
It creates normalized Postgres records, Supabase Auth ownership, strict RLS,
private document storage, idempotent turn commits, version checks, staff roles,
one-time invitations, and 30-day sandbox retention.

## Install

1. Create a dedicated Supabase project with anonymous sign-ins and six-digit
   email OTP enabled. Enable Turnstile in Supabase Auth itself.
2. Apply every file in `migrations/` in numeric order.
3. Apply `seed/20260716_fictional_county_demo_v1.sql`.
4. Configure the variables documented in `.env.example`.
5. Invite staff through Supabase Auth and insert an `active` `staff_roles` row
   scoped to the fictional tenant. The app's staff email-code flow does not
   create accounts or grant roles.
6. Schedule the server-side `pruneExpiredDemoData()` worker at least daily. It
   enforces tenant retention, removes private Storage objects, deletes orphaned
   Auth users, and retries external cleanup through a durable outbox.

`civya_reset_tenant_sandbox()` is the only reset operation. It requires the
tenant's admin role (or service role), deletes only that tenant's resident data,
and preserves the versioned fictional scenarios and staff configuration.

The seed is intentionally fictional and versioned. It never imports the local
runtime JSON database, and no raw audio column exists. The private storage path
contract is `<tenant UUID>/<resident UUID>/<case UUID>/<generated filename>`.
Resident uploads are registered as pending and cannot self-assert a scan or
classification result; staff or a service-role worker must finalize metadata.

The final boundary migration makes every resident workflow mutation
service-role-only. Next.js first performs an RLS ownership read, then calls a
service RPC that receives the authenticated actor ID and repeats ownership
checks inside Postgres. Never expose `SUPABASE_SERVICE_ROLE_KEY` or call those
RPCs from the browser.

A signed demo cookie is exchanged into `private.tenant_access_grants` for the
current Auth user. Resident read policies require that unexpired grant as well
as resident/case ownership. The grant is tied to the redeemed invitation and
cannot outlive either its cookie or the invitation (maximum eight hours).

Document upload URLs are signed server-side for a deterministic
case/idempotency object path. Browser roles cannot insert document metadata or
write the bucket directly; retries reuse the same object, and server cleanup
removes an uploaded object only when no metadata row was committed.
Resident Storage reads also require a matching metadata row whose scan status
is `clean`; invited staff retain role-scoped access for pending-file review.

## Durable resident reminders

Migration `202607160021_durable_entitled_reminders.sql` installs the
service-role-only reminder boundary. Scheduling atomically records separate
SMS-channel and reminder consent, binds the reminder to the exact current
resident/case entitlement, selects an immutable approved non-sensitive
template version, and emits a contact-free transactional outbox event.

The delivery worker resolves contact data only immediately before sending and
rechecks entitlement proof, consent, suppression, and Eastern Time quiet
hours. Twilio does not provide a send idempotency key, so the worker reserves
the external operation first and marks an ambiguous crash outcome
`failed_unknown` instead of blindly retrying. Only a valid signed webhook can
advance provider acceptance to delivered evidence; replayed and out-of-order
receipts are idempotent. Run `npm run test:reminders` after changing any part
of this boundary.

## Existing-email handoff

Before replacing an anonymous session with an already-existing verified email
session, call `createCaseTransferGrant`. After OTP sign-in, call
`redeemCaseTransferGrant` with the one-time token. The case is attached without
merging it. If that account already has an active case, both cases are retained
and the API returns `requiresCaseSelection: true`.
