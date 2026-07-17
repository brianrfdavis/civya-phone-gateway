# County-demo release gates

This is a fictional sandbox checklist, not an authorization to serve real
residents.

## Automated repository gates

Run before every demo build:

```bash
npm ci
npm run typecheck
npm run test:persistence
npm run test:voice-experience
npm run test:county-readiness
npm run build
```

The persistence gate must apply every migration and seed, complete 20 resume
cycles, replay duplicate turns safely, reject stale concurrent writers, keep
resident records isolated, deny direct workflow/storage mutations, and verify
the 30-day cleanup outbox.

## Hosted integration gates

- Apply migrations and fictional seed to the selected Supabase project.
- Enable anonymous Auth, six-digit email OTP, and Turnstile in Supabase Auth.
- Provision reviewer/admin Auth users and active tenant-scoped `staff_roles`;
  verify that a demo invitation alone never grants staff authority.
- Create an invitation in the admin dashboard, redeem it once, and confirm its
  cookie and database access grant expire no later than the invitation.
- Confirm invitation, Auth, Realtime, upload, reset, results, and staff routes
  fail closed without the correct role/session.
- Complete anonymous → linked email without changing resident, case,
  conversation, or pending question.
- Complete existing-email handoff and explicitly choose between two preserved
  cases.
- Sign in on another device and restore only the correct resident's case.
- Run two deployed instances against one database and verify no lost update or
  duplicate action.
- Inject database timeout/outage, 429, 500, invalid JSON, disconnect-after-
  write, and simultaneous action failures. No response may falsely claim save.
- Confirm private Storage and quarantine behavior with spoofed MIME/signatures,
  oversize files, and cross-resident document IDs.
- Trigger retention with test-aged data and confirm database, Storage, and Auth
  cleanup plus retry/alert behavior.

## Real-audio gate

Test Chrome, Safari, and mobile with slow speech, approved accents, reflective
pauses, background television/noise, and interruption. Required targets:

- zero repeated confirmed facts;
- zero false responses to the approved silence/noise corpus;
- zero premature cutoffs in the approved pause corpus;
- barge-in stops output audio within 300 ms;
- speech end to first audio at or below 1.5 seconds p95;
- Cancel never produces a late greeting;
- every ending releases the microphone.

## Formal approvals still required

- County content and program owner
- Privacy, legal, and records-retention owner
- Accessibility and language-access owner
- Human escalation/operations owner
- Security, incident response, monitoring, backup, and recovery owner

Until all approvals are recorded, label every view and transaction fictional
and do not describe Civya as ready for real residents.
