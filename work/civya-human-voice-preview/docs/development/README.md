# Civya developer guide

## Choose the journey

| Journey | Access required | Expected first result | Purpose |
|---|---|---:|---|
| Local synthetic | Node 22 and npm 10 | Under 10 minutes | Domain, UI, adapter, migration and failure development |
| Hosted sandbox | Test Supabase and selected provider credentials | 30–60 minutes after access | Hosted Auth/RLS/Storage and exact provider contracts |
| Production activation | Reviewed release plus County/provider approval | Evidence-gated | Controlled County cohort only |

## Ten-minute quickstart

```bash
nvm use
npm ci
npm run setup:dev
npm run dev
```

Open the resident URL printed by the setup command. `npm run slice` reruns the deterministic County-to-evidence path without starting the browser application.

## Safety model

- Account authentication and County case entitlement are separate.
- Models do not own case selection, entitlement, deadlines, amounts, eligibility, provider handoff, status, or completion.
- Every external effect uses an idempotency key, durable operation state, and reconciliation.
- Provider/browser returns are advisory until an authoritative status is reconciled.
- Documents remain quarantined until approved scanning and review pass.
- Production rejects demo tenants, demo access, fictional fixtures, placeholder secrets, and synthetic provider modes.

## Common commands

| Command | Result |
|---|---|
| `npm run doctor` | Runtime, config and command preflight with actionable corrections |
| `npm run slice` | Credential-free authoritative synthetic vertical slice |
| `npm run test:workflows` | Workflow, source, rule, launch and model-authority invariants |
| `npm run test:persistence` | Fresh migration/RLS/concurrency/retention continuity |
| `npm run test:runtime-security` | Production key isolation, provider capability, and live OTLP acceptance contracts |
| `npm run test:telemetry-receiver` | Authenticated OTLP receiver caps, privacy rejection, health, and metrics |
| `npm run verify:fast` | Fast local/CI-parity gate |
| `npm run verify` | Complete local release gate and production build |

## Make a provider change

1. Implement the typed provider interface; do not write domain tables from the adapter.
2. Normalize the provider result into the domain contract.
3. Add success, timeout, duplicate, replay, stale/out-of-order, malformed, mismatch, reversal, and unavailable fixtures.
4. Preserve the existing idempotency key across retry.
5. Run provider contracts and the golden slice.
6. Add the exact hosted provider gate before enabling the adapter outside synthetic mode.

## Migration changes

Migrations 001–009 are immutable. New migrations use expand/backfill/cutover/contract. Retention safety in migration 010 must precede production tenancy. Never combine destructive DDL, a production backfill, and application cutover in one migration. CI must prove a fresh install and a retained-v009 upgrade.

## Debugging

Use the privacy-safe correlation ID from the API, job, provider event, or golden slice. Errors must include a stable code, what remains safe, what did not complete, and the next recovery action. Never add raw resident text, documents, payment fields, identity documents, secrets, or full provider payloads to logs.
