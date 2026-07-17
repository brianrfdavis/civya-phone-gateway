# Controlled production launch checklist

## Purpose

This is the master go/no-go checklist for a controlled Civya launch involving resident accounts, Wayne County case entitlement, phone service, or a Wayne County/JPMorgan Chase hosted-payment handoff.

It does not replace the lane runbooks:

- [Identity activation](./identity-activation.md)
- [Phone activation](./phone-activation.md)
- [Payment handoff](./payment-handoff.md)
- [Release](./release.md)
- [Rollback](./rollback.md)
- [Production secrets and observability](./observability-and-secrets.md)

Check an item only when its evidence is stored in the approved release evidence location. A meeting statement, code path, screenshot containing secrets, or planned future action is not evidence.

## Readiness labels

Every launch lane must carry one of these labels. Never collapse them into a single “ready” field.

| Label | Meaning |
| --- | --- |
| **Code-complete** | The reviewed repository contract and automated tests exist. This says nothing about external credentials, authority, operations, or production activation. |
| **Activation-ready after gates** | The exact production configuration, credentials, approvals, fallback, evidence, canary, and rollback drill pass. This permits only the approved cohort and window. |
| **County/provider blocked** | A named external owner must supply a contract, approval, account, credential, endpoint, authoritative data source, staff operation, or decision. Engineering must not simulate or bypass it. |
| **Active** | A named approver authorized the recorded configuration/cohort during the recorded window, and monitoring is live. |
| **Paused/rolled back** | New operations are closed; accepted external operations remain pending until authoritative reconciliation. |

## Master lane status

Complete before each go/no-go meeting.

| Lane | Code-complete evidence | Activation-ready evidence | County/provider blocker | Current label | Owner |
| --- | --- | --- | --- | --- | --- |
| Email account/recovery | `_____` | `_____` | `_____` | `_____` | `_____` |
| Google account | `_____` | `_____` | Google application/County approval: `_____` | `_____` | `_____` |
| Apple account | `_____` | `_____` | Apple team/Services ID/rotation owner: `_____` | `_____` | `_____` |
| LinkedIn OIDC account | `_____` | `_____` | LinkedIn application/product approval: `_____` | `_____` | `_____` |
| Passkeys | `_____` | `_____` | Supabase experimental-risk approval: `_____` | `_____` | `_____` |
| Wayne case entitlement | `_____` | `_____` | County verifier/human operation: `_____` | `_____` | `_____` |
| PSTN phone | `_____` | `_____` | Twilio/OpenAI/Render/County telecom: `_____` | `_____` | `_____` |
| Secure SMS resume | `_____` | `_____` | Messaging sender/consent approval: `_____` | `_____` | `_____` |
| Human transfer | `_____` | `_____` | Staffed queue/hours: `_____` | `_____` | `_____` |
| Wayne/Chase payment | Synthetic contract: `_____` | Live adapter/reconciliation: `_____` | County/Chase/PCI: `_____` | `_____` | `_____` |
| Telemetry receiver | Receiver contract: `_____` | Export/readiness/alert evidence: `_____` | Render/security approval: `_____` | `_____` | `_____` |

If a blocker column is nonempty, that lane cannot be labeled Active.

## Hard no-go conditions

Do not launch or expand a cohort with any of the following:

- Missing County business, security, privacy, records, accessibility, legal/procurement, or operations approval applicable to the lane.
- Missing provider agreement, production account, funded billing, approved application, credential, callback, endpoint, or support escalation.
- Authentication alone can reveal a County case or case facts; entitlement is enforced only in the UI; or direct RLS/storage/API negative tests fail.
- Synthetic provider mode, fixture, synthetic adapter, placeholder secret, demo tenant, or demo-access cookie in production.
- Unknown secret owner/expiry, a secret in evidence/logs, or an untested rotation and compromise response.
- An invalid or replayed webhook can cause an action, or event idempotency depends only on one process's memory.
- Missing staffed human fallback, inaccurate after-hours behavior, or fallback that asks for sensitive data.
- Payment session creation without a direct County/Chase contract, production adapter, durable state, PCI scope decision, and authoritative reconciliation.
- Civya can receive card/bank data, uses Stripe, embeds/proxies checkout, or treats browser return as payment completion.
- Missing count/dollar controls, unresolved payment mismatch, or aged pending operation without a finance owner.
- Missing telemetry, tested alerts, cost cap, cohort limit, incident commander, or provider-level kill/rollback.
- Critical accessibility defect, critical/high security finding without accepted County disposition, failed restore, audit-integrity failure, Sev 1/2, or wrong-case event.

## External approval register

All applicable rows require an approval reference and expiry/review date.

| Approval | Named approver | Evidence/reference | Approved scope/cohort | Expiry/review date |
| --- | --- | --- | --- | --- |
| County executive/product outcome | `_____` | `_____` | `_____` | `_____` |
| Wayne County Treasurer/finance | `_____` | `_____` | `_____` | `_____` |
| County information security | `_____` | `_____` | `_____` | `_____` |
| County privacy/data governance | `_____` | `_____` | `_____` | `_____` |
| County legal/procurement | `_____` | `_____` | `_____` | `_____` |
| County records retention/legal hold | `_____` | `_____` | `_____` | `_____` |
| County accessibility/communications | `_____` | `_____` | `_____` | `_____` |
| County contact center/human operations | `_____` | `_____` | `_____` | `_____` |
| Supabase production use/DPA | `_____` | `_____` | `_____` | `_____` |
| Enabled social provider application(s) | `_____` | `_____` | `_____` | `_____` |
| Twilio number/trunk/regulatory approval | `_____` | `_____` | `_____` | `_____` |
| OpenAI project/model/data use | `_____` | `_____` | `_____` | `_____` |
| Render service/region/data use | `_____` | `_____` | `_____` | `_____` |
| Messaging sender/consent path | `_____` | `_____` | `_____` | `_____` |
| JPMorgan Chase hosted payment | `_____` | `_____` | `_____` | `_____` |
| PCI scope determination | `_____` | `_____` | `_____` | `_____` |

An approval for a demo, sandbox, another County application, or another environment does not satisfy production approval.

## Incident, provider, and rollback contacts

Blank contacts are a no-go. Store personal contact details in the restricted on-call system; this packet may reference the schedule/alias.

| Function | Primary/on-call route | Backup route | Authority |
| --- | --- | --- | --- |
| County incident commander | `_____` | `_____` | Pause all lanes and public communications |
| Civya release/rollback operator | `_____` | `_____` | Deploy config/artifact rollback |
| County security/privacy incident lead | `_____` | `_____` | Containment and breach assessment |
| County entitlement owner | `_____` | `_____` | Close/revoke case access and human verification |
| Wayne finance/reconciliation owner | `_____` | `_____` | Hold/reconcile payment outcomes |
| County telecom/Twilio owner | `_____` | `_____` | Detach/reroute phone number |
| Human operations supervisor | `_____` | `_____` | Close/restore transfer and callback queue |
| Supabase escalation | `_____` | `_____` | Auth/database/storage incident |
| OpenAI escalation | `_____` | `_____` | Realtime/webhook/model incident |
| Twilio escalation | `_____` | `_____` | Number/trunk/carrier incident |
| Render escalation | `_____` | `_____` | Call-control runtime incident |
| JPMorgan Chase escalation | `_____` | `_____` | Checkout/webhook/reconciliation incident |
| Resident communications owner | `_____` | `_____` | Approved status/help messaging |

## Credential and endpoint inventory

Do not paste secrets. Record one row per credential, signing key, callback, origin, number, trunk, project, or service endpoint.

| System | Kind | Environment/scope | Owner | Vault/config reference | Created | Expires/rotate by | Last canary | Revocation method |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `_____` | `_____` | `_____` | `_____` | `_____` | `_____` | `_____` | `_____` | `_____` |

Inventory checks:

- [ ] Production and staging credentials are distinct.
- [ ] Every credential has minimum scope and a named owner/backup.
- [ ] Browser-exposed variables contain no server secret.
- [ ] OAuth callbacks, OpenAI/Twilio webhooks, Render host, Chase API/checkout origins, and return URLs are exact HTTPS values.
- [ ] Apple six-month client-secret rotation is calendared with a 30-day lead.
- [ ] Auth-flow, upgrade, staff-auth, entitlement, document-upload, telemetry-ingest, webhook, internal-service, and secure-link secrets are distinct.
- [ ] Rotation and emergency revocation were exercised without capturing secret contents.
- [ ] Provider console audit access and break-glass accounts are approved and tested.
- [ ] Staff host mapping, confirmed-user OTP, exact tenant roles, revocation, and cross-tenant negative tests are recorded.
- [ ] County workforce SSO/SCIM is either activated with County IdP evidence or explicitly recorded as externally blocked for the controlled cohort.

## Release and evidence packet

- [ ] Immutable source SHA: `_____`
- [ ] Lockfile digest: `_____`
- [ ] Web artifact ID: `_____`
- [ ] Durable runtime/Render artifact ID: `_____`
- [ ] Database schema/migration version: `_____`
- [ ] Configuration version: `_____`
- [ ] Rule/content/workflow/model/provider versions: `_____`
- [ ] `npm ci` and `npm run verify` result: `_____`
- [ ] Production build result: `_____`
- [ ] Fresh-install and retained-data migration/restore evidence: `_____`
- [ ] Auth/RLS/storage direct negative evidence without entitlement: `_____`
- [ ] Entitlement valid/invalid/expired/revoked/wrong-account evidence: `_____`
- [ ] Provider callback, cancel, timeout, replay, duplicate, and recovery matrix: `_____`
- [ ] Accessibility keyboard/screen-reader/zoom/language evidence: `_____`
- [ ] Load, fault injection, dependency outage, queue recovery, and restore evidence: `_____`
- [ ] No-secret/no-sensitive-log scan: `_____`
- [ ] Phone signed-webhook/call/fallback/carrier rollback evidence, if in scope: `_____`
- [ ] Payment full-tab/advisory-return/reconciliation/finance rollback evidence, if in scope: `_____`
- [ ] Alert delivery and on-call acknowledgement test: `_____`
- [ ] OTLP receiver acceptance probe and privacy-safe payload test: `_____`
- [ ] Prior artifact/config rollback completed within target: `_____`

Use synthetic residents and designated provider test entities. Never put resident text, documents, case facts, payment credentials, raw phone numbers, OAuth codes, or secrets in release evidence.

## Cohort plan

Activate one consequential dimension at a time. Record actual limits; blanks are a no-go.

| Phase | Allowed people/data/actions | Entry gate | Limit/window | Exit evidence |
| --- | --- | --- | --- | --- |
| 0. Synthetic | Engineers; synthetic tenant/providers only | Full automated suite | `_____` | Contract and failure-path evidence |
| 1. Internal live-provider | Named County/Civya testers; no real case or payment | Provider credentials and rollback | `_____` | Auth/call transport only |
| 2. Account canary | Invited testers; account/recovery; no case entitlement | Identity runbook | `_____` | Account-without-case negative evidence |
| 3. Entitled case canary | Named approved test cases; least-consequential workflows | County verifier and RLS/API gate | `_____` | Correct-case and revocation evidence |
| 4. Phone canary | One unpublished number; named callers | Phone runbook | `_____` | Quality/fallback/cost observation |
| 5. Payment canary | County-designated test obligations; finance watches every event | Payment runbook and direct contract | `_____` | Exact authoritative reconciliation |
| 6. Limited resident cohort | Explicit geography/workflow/channel limits | Prior phase sign-off | `_____` | Approved observation period |

Do not use a successful account cohort to infer case, phone, or payment readiness. Do not use a successful browser return to expand payment scope.

## Kill switches and expected effect

Configuration is read at process start in parts of the runtime; a switch change generally requires a controlled configuration deploy/restart. Prove the observed effect on the pinned production-like artifact.

| Control | Use | Required observed effect | Important limitation/companion action |
| --- | --- | --- | --- |
| `CIVYA_PAUSE_ALL=true` | Cross-cutting integrity incident | Readiness reports paused and consequential work is closed | Current code visibly uses this for readiness; do not rely on it alone until every consequential route/worker has enforcement evidence. Also use lane-specific switches/provider controls. |
| `CIVYA_AUTH_GOOGLE_ENABLED=false` | Stop Google starts | Google unavailable; email/general fallback remains | Disable/revoke in Supabase/Google too if compromised. |
| `CIVYA_AUTH_APPLE_ENABLED=false` | Stop Apple starts | Apple unavailable; email/general fallback remains | Disable/revoke in Supabase/Apple too if compromised. |
| `CIVYA_AUTH_LINKEDIN_ENABLED=false` | Stop LinkedIn starts | LinkedIn unavailable; email/general fallback remains | Disable/revoke in Supabase/LinkedIn too if compromised. |
| `CIVYA_AUTH_PASSKEY_ENABLED=false` | Stop passkey starts/registration | Passkey unavailable; other recovery remains | Existing sessions remain; revoke a compromised credential through Supabase. |
| Entitlement verifier disable/revocation | Close new case grants | New verification fails closed; case APIs remain closed without grant | Production needs durable grant revocation; rotating a verifier secret alone may not invalidate already issued short-lived grants. |
| `CIVYA_ENABLE_PSTN=false` + `CIVYA_TELEPHONY_MODE=disabled` | Stop automated phone acceptance | Public call webhook refuses call control | First detach/reroute the Twilio number to approved human/announcement so callers are not stranded. |
| `CIVYA_ENABLE_MESSAGES=false` + `CIVYA_MESSAGING_MODE=disabled` | Stop new messages | No new SMS operation | Preserve delivery receipts and consent/suppression evidence. |
| `CIVYA_ENABLE_HOSTED_HANDOFF=false` + `CIVYA_PAYMENT_HANDOFF_MODE=disabled` | Stop payment sessions | No new hosted session/launch | Keep webhook/feed ingestion and reconciliation running for accepted operations. Live adapter must enforce both controls before activation. |
| Remove Chase destination allowlist / revoke credential | Payment compromise | New provider calls and navigation fail closed | Finance must reconcile all previously created operations. |
| Render rollback / scale route off | Call-control defect | Prior pinned service or no automation | Pair with carrier reroute; do not leave number pointed at an unavailable webhook. |
| Provider-console disable/revoke | Credential compromise | Provider cannot issue new successful operations | Record exact time/version; preserve audit and uncertain operations. |

Kill-switch drill evidence must include who acted, time to effect, direct negative request, resident fallback, provider state, and recovery—not merely the configuration value.

## Activation sequence

1. Freeze the immutable artifacts and configuration; record all versions and digests.
2. Confirm every out-of-scope lane is disabled and every external blocker has an owner.
3. Complete approvals, contacts, credential inventory, cost caps, cohort limits, and evidence packet.
4. Deploy the same pinned artifacts to staging; run full release, lane, fault, restore, and rollback gates.
5. Deploy the same artifacts to production with all new provider/channel flags still disabled.
6. Run production-safe health and direct negative authorization checks.
7. Configure the single selected provider/lane and run named canaries while the public cohort remains closed.
8. Convene go/no-go with County, release, security/privacy, operations, and provider/finance owners applicable to the lane.
9. Record the decision, approvers, lane, cohort, start/end time, limits, cost cap, and rollback trigger.
10. Enable only that lane/cohort. Monitor in real time through the launch window and the documented observation period.
11. Stop or roll back on any stop condition; do not wait for a meeting.
12. Expand only with a new recorded decision. Never automatically increase a cohort based on traffic or elapsed time.

## Live monitoring and stop conditions

Monitor health/readiness, auth errors, entitlement denies/grants, wrong-case attempts, provider signature/replay failures, webhook retries/duplicates, durable queue age, staff queue availability, call latency/duration/fallback, payment pending/mismatch/reversal, accessibility reports, sensitive-log detection, and spend.

Immediately pause the affected lane—and use cross-cutting containment for integrity risk—on:

- Any wrong-case or cross-tenant disclosure.
- Authentication treated as case entitlement.
- Invalid/replayed webhook accepted or duplicate consequential operation.
- Secret, resident content, case fact, phone number, or payment credential in an unauthorized log/evidence path.
- Model-originated amount, deadline, eligibility, case status, payment status, identity decision, or completion claim.
- Human fallback unavailable during published staffed hours without accurate alternate guidance.
- Payment control mismatch, unowned aged pending item, false completion, or unsupported provider destination.
- Cost at the approved hard threshold or an unexplained spend spike.
- Critical accessibility/security defect, Sev 1/2, durable-store loss, audit-integrity failure, or failed restore.

Preserve accepted external operations and reconcile them. A pause or rollback never changes an uncertain provider outcome into success or failure.

## Go/no-go decision record

```text
Release/config version: ______________________________
Lane and exact cohort: _______________________________
Activation window (America/Detroit): _________________
County approver: _____________________________________
Security/privacy approver: ___________________________
Operations/finance/telecom approver as applicable: ___
Civya release owner: _________________________________
Incident commander: __________________________________
Rollback operator: ___________________________________
Evidence packet: _____________________________________
Cost and cohort limits: ______________________________
Known external blockers outside activated scope: _____
Decision: GO / NO-GO
Decision time: _______________________________________
Next review or automatic cohort close: _______________
```

All named approvers sign the stored decision. A verbal go, a partially completed form, or a go for a different lane/environment is a no-go.
