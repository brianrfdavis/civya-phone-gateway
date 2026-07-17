# Outcome verification standard

Status: demonstrated in the fictional sandbox only. This control is not evidence of a live Wayne County integration or production authorization.

## Control objective

Civya must never treat a resident conversation, checklist action, document upload, simulated submission, case closure, or model-generated statement as proof that a public outcome occurred. In the current sandbox, a test outcome is eligible to appear as verified only after a service-controlled reconciliation uses an administrator-activated synthetic definition, a governed synthetic source snapshot, an exact case-to-record identifier match, and deterministic criteria. A future official outcome would additionally require County-approved definitions, sources, controls, and acceptance.

## Evidence chain

1. Register a versioned synthetic-test outcome definition with its required source key, record type, schema, fields, positive criteria, explicit reversal criteria, and non-overlapping effective period.
2. Ingest an immutable source snapshot, calculate its canonical payload hash inside the trusted boundary, and record the source time.
3. Append a case-to-source match decision. The demonstrated accepted path requires an exact parcel identifier; ambiguous, rejected, stale, conflicting, or forked matches cannot verify an outcome.
4. Run the versioned deterministic evaluator through a service-only boundary.
5. Append a verification or reversal event. Prior events remain immutable.
6. Derive each logical outcome projection from its controlling event and provide an administrator-only evidence export containing the definition, source system, batch, source records, matches, runs, events, current projection, package digest, and export audit event.

## Invariants

- Resident and browser roles cannot invoke outcome-control functions.
- Ordinary conversation turns update interaction lifecycle only.
- Synthetic evidence is labeled `synthetic`; the current schema cannot present it as County-authorized evidence.
- History tables reject updates and deletes.
- A later qualifying record may reverse a verified test result only when explicit reversal criteria are satisfied; missing evidence cannot reverse it.
- Match and reconciliation requests serialize on the case to prevent sibling event chains.
- A case parcel identifier cannot change while an outcome projection exists; the match must be invalidated and reconciled first.
- Idempotent replay returns the historical run result and separately labels the current projection; conflicting reuse of an idempotency key fails.
- Application service credentials can execute governed functions but cannot directly insert ledger rows or update projections.
- Synthetic retention deletion is allowed only through a service-controlled, transaction-local purge boundary; the test removes evidence linked to expired cases while preserving fresh unmatched source records.

## Current proof

The local persistence suite applies all migrations to a fresh Postgres-compatible database and exercises positive and negative paths for calculated payload and reconciliation hashes, exact matching, replay, resident/reviewer/admin authorization, cross-tenant isolation, direct-service write denial, incomplete evidence, ambiguity, stale evidence, fork prevention, explicit reversal, re-verification, privileged export, package-digest verification, aggregate reconciliation, and retention of a case with outcome history. Run `npm run test:persistence` for the behavioral test and `npm run test:county-readiness` for static boundary checks.

## Not yet established

- County-approved outcome definitions or source authority
- A production County source connector and identity-matching protocol
- Signed source manifests or authenticated County transport
- A signed evidence package or independent assurance
- County security, accessibility, legal, records, and operational acceptance
- Independent production-scale, penetration, recovery, or accuracy testing
