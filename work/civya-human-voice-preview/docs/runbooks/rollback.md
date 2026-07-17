# Rollback runbook

1. Pause the affected workflow, channel, provider or model; use pause-all for cross-cutting integrity risk.
2. Preserve inbound events and durable jobs. Do not discard uncertain provider outcomes.
3. Promote the previously pinned web and durable-runtime artifacts.
4. Keep additive schema changes in place unless a separately tested forward fix is required.
5. Reconcile provider operations accepted during the incident before replaying work.
6. Run liveness, readiness, identity/entitlement, five-workflow, webhook, staff recovery and evidence smoke tests.
7. Record the incident, release/config/schema versions, scope, timeline and recovery evidence.

Rollback target: under 15 minutes. A rollback does not turn a pending external operation into a failure or success; reconciliation remains authoritative.
