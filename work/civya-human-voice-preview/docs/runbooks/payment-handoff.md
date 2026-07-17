# Wayne County / JPMorgan Chase payment handoff runbook

## Purpose and non-negotiable boundary

Use this runbook to activate a direct, County-authorized handoff from Civya to the Wayne County/JPMorgan Chase hosted checkout and to reconcile the result back from an authoritative County or Chase source.

**Civya is not a payment processor.** Civya must never collect, transmit, proxy, tokenize, log, or store card number, CVV/CVC, bank account number, routing number, online-banking credentials, payment credentials, or a Stripe token. Stripe is not part of this architecture. Payment entry occurs only in the County/Chase-hosted full-tab experience.

A browser return is advisory. It means only that the browser came back. It never proves submission, authorization, settlement, posting, payment-plan activation, or completion.

## Readiness and ownership

| State | What is in that state | Owner needed to advance |
| --- | --- | --- |
| **Code-complete (production-shaped, activation gated)** | Credential rejection, typed live-adapter seam, durable external-operation reservation, durable hosted sessions, encrypted one-time launch/return links, advisory browser-return classification, signed-evidence seam, exact reconciliation, and crash/retry contract tests exist. | Civya engineering maintains and tests the boundary. |
| **Activation-ready after gates** | No live payment path is activation-ready today. The County/J.P. Morgan wire client, County obligation source, signed webhook/poll verifier, finance exception operations, and contracted provider evidence must first pass every gate in this runbook. | Civya release and County finance/security approvers. |
| **County/provider blocked** | Direct Wayne/Chase API and hosted-session authority, merchant credentials, webhook/feed specification, PCI determination, production test obligations, fees/completion rules, and finance sign-off are external dependencies. | Wayne County Treasurer/finance, procurement/legal/security, PCI owner, and JPMorgan Chase onboarding/support. |

Do not interpret production-shaped code as provider connectivity or authority to take payment.

## Current implementation status: blocked for live activation

The repository contains both a synthetic adapter and a production-shaped, fail-closed Wayne/J.P. Morgan boundary. Live activation is prohibited until all of the following are complete:

- Wayne County and JPMorgan Chase provide an executed agreement, production onboarding, approved endpoint/origin inventory, credential process, test environment, webhook or reconciliation feed, service levels, support contacts, and authoritative field/status definitions.
- Wayne County/J.P. Morgan implement and approve the typed `ContractedJpmChaseCheckoutClient`, including provider-enforced idempotency. Civya intentionally supplies no guessed HTTP endpoint or field mapping, so the live create route returns 503 until that client is wired.
- Wayne County implement and approve the authoritative case-obligation source. Browser-supplied amount, parcel, tax year, or obligation fields are never accepted by the live route.
- The contracted signed-webhook verifier and/or authenticated polling client is implemented against the approved provider schema. Civya's synthetic HMAC is never reused as a live signature scheme.
- Finance validates the durable external-operation, hosted-session, one-time link, provider-event, and reconciliation records under crash, retry, duplicate, and multi-instance tests.
- Finance owns a durable reconciliation worker and exception queue through final posting, return, reversal, refund, dispute, or unmatched resolution.
- Production uses `JPM_CHECKOUT_WEBHOOK_SECRET`; `CIVYA_PAYMENT_WEBHOOK_SECRET` remains synthetic-test-only. `CIVYA_PAYMENT_HANDOFF_MODE` is the sole payment-mode switch; the legacy global provider-mode variable is ignored by this lane.
- The County approves the case-entitlement prerequisite. A signed-in Civya account alone must not reveal an obligation or create a payment session.

No operator may work around these blocks by setting synthetic mode in production, exposing a raw provider URL, collecting payment fields in Civya, or adding Stripe.

## Required approvals and contracts

| Owner | Required approval |
| --- | --- |
| Wayne County Treasurer/finance | Authoritative obligations, permitted payment actions, fee presentation, completion definition, reconciliation controls, refunds/reversals, and exception ownership |
| County procurement/legal | Executed Chase/provider agreement, subcontractors, terms, liability, support, and change notification |
| County security/privacy | Data-flow and threat model, secret management, logging, retention, incident response, and approved origins |
| County PCI owner/QSA | Written PCI scope determination for the redirect architecture and evidence obligations; do not assume redirect-only means no PCI responsibility |
| JPMorgan Chase onboarding owner | Merchant/service configuration, sandbox/production credentials, hosted-checkout URLs, signing method, idempotency, webhook/feed, and escalation |
| Civya release owner | Production adapter, secure links, tests, feature gates, evidence, and rollback |
| Reconciliation owner | Daily controls and resolution of every unmatched or nonfinal operation |

## Incident and rollback contacts

Complete this table in the controlled launch packet. Blank contacts are a no-go.

| Contact | Name | 24/7 or launch-window route | Backup |
| --- | --- | --- | --- |
| County incident commander | `_____` | `_____` | `_____` |
| Wayne County finance/reconciliation owner | `_____` | `_____` | `_____` |
| JPMorgan Chase production support | `_____` | `_____` | `_____` |
| County PCI/security lead | `_____` | `_____` | `_____` |
| Civya rollback operator | `_____` | `_____` | `_____` |
| Resident payment-support lead | `_____` | `_____` | `_____` |

If Wayne County or Chase has not approved a direct Civya-initiated hosted session, Civya may show only the County's reviewed public payment-options link and human contact path. It may not simulate a direct integration.

References: [Wayne County Treasurer payment options](https://www.waynecounty.com/elected/treasurer/tax-payment-options.aspx) and [Wayne County Treasurer payment FAQ](https://www.waynecounty.com/elected/treasurer/faqs.aspx).

## Required production contract

The signed interface specification must define, without guesswork:

- Exact HTTPS base URL and every allowed hosted-checkout destination origin.
- Authentication scheme, credential scopes, key rotation, source allowlists, and mutual-TLS requirements if any.
- Hosted-session request/response fields, idempotency semantics, expiry, cancellation, and retry rules.
- Opaque obligation and parcel references suitable for Civya. Raw parcel/account identifiers must not appear in launch URLs or client logs.
- Amount, currency, tax year, installment/plan, partial-payment, fee, and minimum/maximum rules.
- Whether a return URL is supported and the exact allowlisted return URL.
- Signed webhook or authoritative file/API feed format, signature verification, timestamp/replay window, event ID, retry period, and ordering behavior.
- Final status vocabulary for payment and plan states, including pending, posted, returned, reversed, refunded, disputed, failed, and unmatched.
- Source revision, transaction reference, posting/effective dates, correction behavior, and historical re-query period.
- Record-count and dollar-control totals for batch/file reconciliation where applicable.
- Production support, incident, settlement, and finance escalation contacts.

Do not infer an API from the public Chase portal or automate its browser UI.

## Configuration inventory

Keep both controls closed until production canary approval:

```text
CIVYA_ENABLE_HOSTED_HANDOFF=false
CIVYA_PAYMENT_HANDOFF_MODE=disabled
```

Production secrets/configuration, after contract approval:

```text
CIVYA_HANDOFF_ALLOWED_ORIGINS=https://<exact-approved-county-or-chase-origin>[,...]
JPM_CHECKOUT_BASE_URL=https://<contracted-api-origin>
JPM_CHECKOUT_CLIENT_ID=<vault-managed identifier>
JPM_CHECKOUT_CLIENT_SECRET=<vault-managed secret>
JPM_CHECKOUT_CONTRACT_VERSION=<exact-approved-version>
JPM_CHECKOUT_WEBHOOK_SECRET=<vault-managed signing secret>
CIVYA_PAYMENT_LINK_SECRET=<distinct-32+-byte-payment-link-secret>
```

Allowlist exact origins, not subdomain wildcards. Reject HTTP, embedded credentials, unexpected ports, redirects to a different origin, and destination URLs containing resident or payment data. Evidence stores vault references and credential versions only.

## Approved handoff sequence

1. **Authorize the resident.** Require a verified Civya account and a current, server-enforced case entitlement. Authentication alone is insufficient.
2. **Read the obligation from an authoritative source.** Obtain current obligation, parcel binding, tax year, amount, and source revision from Wayne County. Use opaque references across the payment adapter.
3. **Show a review step.** Display the authoritative amount, tax year, obligation context, retrieval time, and clear notice that the resident is leaving Civya for the official hosted payment site. Do not calculate or promise fees.
4. **Reserve the external operation durably.** Before contacting the provider, bind the exact redacted request digest to the tenant, operation kind, and idempotency key. Mark it in flight; an unknown result remains recoverable and never becomes a new logical operation.
5. **Create the session server-side.** Send only the approved opaque references, USD amount in integer minor units, tax year, safe idempotency key, and approved return capability to the contracted Wayne/Chase endpoint. Retry only under the contracted provider-enforced idempotency guarantee.
6. **Validate and persist the provider response.** Require the expected provider, opaque session reference, HTTPS destination on the exact origin allowlist, expiry, and explicit confirmation that Civya does not capture payment credentials. Mark the external operation with only the session-reference digest, then create `hosted_handoff_sessions` before returning a launch URL.
7. **Issue short, single-use links.** Bind encrypted launch and advisory-return links to the account, case, tenant, handoff, purpose, and expiry; store only token digests and consume atomically. Use private/no-store responses and `Referrer-Policy: no-referrer`.
8. **Open a full browser tab.** Navigate the top-level tab to the Civya launch URL, consume it once, then redirect to the validated hosted destination. Do not use an iframe, embedded webview, popup dependency, or server-side proxy.
9. **Handle browser return as advisory.** A valid, single-use return may record `provider_open`/`returned` evidence and display: “Status is still being confirmed with Wayne County.” It must set `maySetCompletion: false`.
10. **Ingest authoritative evidence.** Verify the contracted signature against the raw body, timestamp, and event ID; deduplicate durably; store a redacted immutable provider event; then enqueue reconciliation. A webhook candidate still does not directly set completion.
11. **Reconcile.** Match obligation reference, parcel reference, tax year, currency, amount, record count, and dollar control total. Require the County-approved final status combination. The current contract treats only `paymentStatus=posted` and `planStatus=active` as verified completion; if the live provider cannot supply those exact semantics, finance must approve and version a different rule before release.
12. **Monitor post-completion corrections.** A later return, reversal, refund, dispute, or County correction reopens the operation and routes it to the finance exception queue. Never preserve a stale “complete” state against newer authoritative evidence.

## Fees and resident copy

Wayne County's public payment-options page currently describes no-cost ACH and a card service fee paid to the service provider. Finance must re-verify the current methods and fee immediately before launch and on every provider change.

- The hosted County/Chase page is authoritative for available methods, fee, and final total.
- Civya must not hardcode, compute, collect, waive, or characterize a provider fee as County revenue.
- Civya must show the amount returned by the authoritative source and tell the resident to review the official hosted total before submitting.
- A fee change is a content/configuration change requiring finance approval and regression evidence.

## Security and privacy gate

- Reject any request, response, event, log, trace, metric, or support artifact whose keys or values contain PAN/card number, CVV/CVC, routing, bank account, online-banking credential, or payment token.
- Do not put resident name, email, address, phone, parcel ID, amount, tax year, case ID, or obligation in URL query/fragment values. Use opaque server-side references.
- Bind launch and return tokens to the authenticated server session; enforce single use and expiry atomically across all instances.
- Re-authenticate/step up if the approved session-age policy is exceeded before launch.
- Use distinct secrets for provider API authentication, provider webhook verification, secure links, and Civya sessions.
- Verify the exact raw webhook body before JSON parsing and deduplicate the provider event before any consequential work.
- Store payment evidence under the approved finance/records retention and legal-hold policy. Application telemetry contains only opaque references and result classes.
- Never let browser-return data, a screenshot, email receipt, resident statement, or Civya model output become authoritative payment evidence.

## Test gate

All tests use the provider sandbox or a County-designated nonresident obligation. Never use an employee's or resident's real card/bank credentials for release testing.

| Test | Required result |
| --- | --- |
| Valid hosted session | Exact allowlisted full-tab destination; no credentials touch Civya |
| Unexpected destination/redirect | Handoff rejected before navigation |
| Reused, expired, wrong-session token | Rejected with no destination disclosure |
| Request with prohibited payment field | Rejected and security event emitted |
| Duplicate create request | Same logical session/result under contracted idempotency semantics |
| User closes provider tab/no return | State remains nonfinal; reconciliation continues |
| Return before webhook/feed | Advisory message only; no completion |
| Duplicate/out-of-order webhook | Deduplicated and ordered by authoritative revision/rule |
| Invalid signature/stale timestamp | Rejected; no candidate record |
| Wrong obligation, parcel, tax year, currency, or amount | `unmatched`; finance exception; no completion |
| Count or dollar control mismatch | Batch/operation held; no partial completion |
| Pending/failed status | Accurate nonfinal state and approved resident guidance |
| Posted + active exact match | Completion only after authoritative reconciliation |
| Return/reversal/refund after posting | Completion withdrawn/reopened and exception queued |
| Provider/County source outage | New handoffs disabled or accurately unavailable; pending operations preserved |
| Human fallback | Official Wayne payment-options/human path opens without exposing case data |
| Kill switch | New sessions stop; outstanding operations continue reconciliation |

Run the provider contract tests, workflow tests, typecheck, production build, accessibility test, and full release verification suite on the pinned artifact. Finance independently validates reconciliation controls and totals.

## Canary and monitoring

1. Start with named County testers and designated nonresident/test obligations.
2. Limit the canary by explicit account/case allowlist, daily session count, maximum amount, and activation hours. Record approved values; blanks are a no-go.
3. Have finance watch every canary handoff through final reconciliation.
4. Alert on session-create failure, origin rejection, token replay, webhook signature failure, duplicate surge, aged pending operations, unmatched controls, return/reversal/refund, reconciliation lag, and provider spend.
5. Expand only after the County-defined observation period has zero unexplained mismatches, no credential exposure, and documented support outcomes.

## Go/no-go evidence

- Executed Wayne County/Chase contract and production onboarding reference.
- Signed interface specification and exact endpoint/origin inventory.
- PCI scope determination and security/privacy approval.
- Production adapter review; durable link, replay, event, reconciliation, and exception stores.
- Credential inventory with owner, vault reference, scopes, created/expiry/rotation dates.
- Full-tab UX/accessibility and resident-copy approval.
- Complete test matrix with authoritative count-and-dollar reconciliation evidence.
- Finance dashboard, aged-pending alert, unmatched queue, and daily control owner.
- Provider, application, and finance rollback drill.

Any missing item is a no-go.

## Rollback

1. Set `CIVYA_ENABLE_HOSTED_HANDOFF=false` and `CIVYA_PAYMENT_HANDOFF_MODE=disabled`; deploy and confirm new session creation returns a safe unavailable state.
2. If provider compromise or misrouting is suspected, revoke/rotate the affected Chase credential and remove the destination origin allowlist immediately.
3. Preserve every created, launched, pending, returned, and uncertain operation. Disabling new launches does not cancel a provider transaction.
4. Continue authoritative ingestion and reconciliation until finance resolves every operation accepted before cutoff. Do not convert uncertainty into failure or success.
5. Route residents to the County-approved public payment-options and human-assistance paths. Do not substitute Stripe or a Civya payment form.
6. Roll the application back only if needed; keep additive evidence and reconciliation data in place.
7. Record provider/config/rule/artifact versions, affected opaque references, control totals, timeline, resident impact, and finance sign-off.

Reactivation requires County finance, security, and release owners to approve a fresh go/no-go packet.
