# Release runbook

1. Run `npm ci` on the pinned runtime and `npm run verify`.
2. Record source SHA, lockfile digest, schema/config/rule/content/workflow/model/provider versions and test evidence.
3. Apply additive migrations to staging and prove both fresh and retained-v009 paths. PGlite proves schema and state-machine behavior, but it does not certify PostgreSQL row-lock contention: before activating provider webhooks, run a hosted-Postgres concurrent duplicate-event probe and prove one claimant, active-lease retry, expired-lease reclaim, rotated-token fencing, and stale-token completion rejection.
4. Deploy the immutable web and durable-runtime artifacts to staging.
5. Run hosted Auth/RLS/Storage, provider contract, five-workflow, staff recovery, accessibility, load, security, fault and restore evidence.
6. Verify channel/provider/model/workflow kill switches and pause-all.
7. Promote the same artifact; do not rebuild between staging and production.
8. Run a live synthetic smoke and verify alerts, queues, reconciliation and rollback target.
9. Activate only the approved workflow/cohort gate.

Production activation stops for any wrong-case event, unresolved reconciliation, suppression failure, critical accessibility blocker, Sev 1/2, unaccepted critical/high security finding, audit-integrity failure or failed restore.
