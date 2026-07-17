# Production secrets, provider readiness, and observability

## What this gate proves

Production configuration is accepted only when Civya-owned authority keys are present, non-placeholder, long enough, and distinct. Readiness separately proves that the private database/storage dependencies respond, every activated provider has an implemented adapter and valid contract configuration, and the OTLP receiver accepts a real privacy-safe record within a bounded timeout.

An environment-variable name or provider mode is not operational evidence. `mode=live`, a URL, `SENTRY_DSN`, or a credential-presence screenshot cannot make readiness green.

## Required production keys

Create separate vault-managed values with at least 32 random bytes for every row. Never paste values into evidence, logs, tickets, or this runbook.

| Variable | Authority protected | Required in production |
| --- | --- | --- |
| `CIVYA_AUTH_FLOW_SECRET` | Encrypted OAuth/passkey/recovery continuation | Yes |
| `CIVYA_AUTH_UPGRADE_SECRET` | Anonymous-to-verified email handoff | Yes |
| `CIVYA_STAFF_AUTH_SECRET` | Staff email challenge state | Yes |
| `CIVYA_ENTITLEMENT_VERIFY_SECRET` | County verifier request authentication | Yes |
| `CIVYA_DOCUMENT_UPLOAD_SECRET` | Direct private-storage upload grants | Yes |
| `CIVYA_TELEMETRY_INGEST_SECRET` | Authenticated Civya-owned OTLP ingestion | Yes |

The values above must be distinct from each other and from any configured `CIVYA_INTERNAL_SERVICE_SECRET`, `CIVYA_SECURE_LINK_SECRET`, `CIVYA_PAYMENT_LINK_SECRET`, `CRON_SECRET`, or webhook-signing secret. Known local, test, synthetic, sample, and `replace-*` values are rejected.

`CIVYA_DEMO_ACCESS_SECRET` signs only fictional demo invitation cookies and is forbidden in production. Production invitation and entitlement records use random opaque tokens, stored as hashes; they do not reuse the demo cookie mechanism.

Also configure an exact HTTPS `CIVYA_ENTITLEMENT_VERIFY_URL`. Rotating one key does not authorize reuse of another key. During compromise response, disable the affected lane, expire/revoke issued grants as applicable, rotate only that key, and rerun negative and positive canaries.

## Civya-owned OTLP HTTP/JSON configuration

The controlled-launch, budget-safe topology sends content-free web telemetry
from Vercel to the always-on Render foundation worker. Generate one new secret
with at least 32 random bytes. Put the same value in each platform's secret
store; do not put it in source, evidence, screenshots, or a browser-exposed
variable.

Configure the Render receiver:

```dotenv
CIVYA_ENVIRONMENT=staging
CIVYA_ENABLE_TELEMETRY_RECEIVER=true
CIVYA_TELEMETRY_INGEST_SECRET=<Render secret reference>
```

Configure the Vercel exporter after Render has supplied its exact HTTPS origin:

```dotenv
CIVYA_TELEMETRY_MODE=otlp-http-json
CIVYA_TELEMETRY_RECEIVER_ORIGIN=https://civya-runtime.example
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://civya-runtime.example/v1/logs
OTEL_EXPORTER_OTLP_HEADERS=x-civya-telemetry-key=<percent-encoded ingest key>
OTEL_SERVICE_NAME=civya-web
CIVYA_TELEMETRY_TIMEOUT_MS=2000
CIVYA_TELEMETRY_INGEST_SECRET=<Vercel secret reference>
```

`CIVYA_TELEMETRY_RECEIVER_ORIGIN` declares that the receiver is Civya-owned.
The runtime then requires an exact `/v1/logs` endpoint and verifies that either
`x-civya-telemetry-key` or a Bearer credential equals the dedicated ingest
secret. Production secret validation requires the ingest secret and checks it
is at least 32 bytes, non-placeholder, and distinct from every other Civya
authority key. A base `OTEL_EXPORTER_OTLP_ENDPOINT` still gets `/v1/logs`
appended for an approved external collector. Production endpoints require
HTTPS and cannot contain URL credentials, query parameters, or fragments.
Header values use percent encoding and stay only in deployment secret stores.

The Render endpoint accepts only `POST application/json` up to 64 KiB. It uses
constant-time credential comparison, then accepts exactly one current Civya
OTLP log record containing a categorical event name, the three allowlisted
resource fields, and bounded allowlisted scalar attributes. Resident, case,
email, phone, address, document, transcript, payload, credential-like, and
secret-like keys or values are rejected. The receiver never logs its raw
request body. It writes one compact redacted acceptance summary to Render
stdout. Expected rejections are `401` for authentication, `413` for the byte
cap, `415` for media type, and `400` for method, envelope, or privacy policy.
An accepted request returns the valid empty OTLP JSON response `{}`.

The structured logger exports only a small categorical allowlist such as route, provider, safe result code, status, and latency. Resident text, email, phone, address, parcel/case identifiers, documents, transcripts, payloads, authorization values, cookies, and secret-like values are excluded. Export failures are not recursively logged.

`/api/health/ready` must call the bounded telemetry health probe and remain
`503` unless the receiver accepts the content-free `civya.telemetry.health`
record with a 2xx response. Render `/health/live`, `/health/ready`, and
`/metrics` expose only the receiver capability, configured/ready state,
counters, cap, and last accepted time—never credentials or submitted values.
Record the web readiness probe, Render receiver counter increment, and a
negative privacy test in release evidence. Alert delivery and an on-call
acknowledgement remain separate launch evidence.

Run the receiver contract before each deployment:

```bash
npm run test:telemetry-receiver
npm run test:runtime-security
```

Rotate by adding the new key to both secret stores during one controlled
window, redeploying Render first and Vercel second, verifying the readiness
probe, then removing the old deployment versions. The receiver intentionally
accepts one key at a time, so do not expand the resident cohort during rotation.

## Provider capability truth

The dependency health response evaluates adapter availability, exact contract, and required configuration; it does not echo credentials.

- Twilio messaging and OpenAI Realtime SIP have live adapter boundaries and still require every validated account, sender, callback, tenant binding, and signing credential.
- The OpenAI Responses intent adapter requires an approved GPT-5.6 model and API credential when live.
- County source ingest, production document scanning, CLEAR identity proofing, and Wayne/Chase checkout remain not activation-ready until their approved live adapters/contracts exist. Setting their modes to `live` must keep readiness red.
- A disabled provider is healthy only when its dependent feature is also disabled. Synthetic providers are never accepted in production.

## Release evidence

Run without recording environment values:

```bash
npm run test:runtime-security
npm run typecheck
```

Store only the result, artifact/release SHA, configuration version, collector/provider contract version, test time, operator, and vault reference. For production canaries, record the health status and redacted failure code—not response bodies or credentials.
