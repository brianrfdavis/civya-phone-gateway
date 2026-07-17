# Phone activation runbook

## Purpose and current readiness

Use this runbook to connect one unpublished Twilio number to Civya through Twilio Elastic SIP Trunking, the OpenAI Realtime SIP endpoint, Civya's signed incoming-call webhook, and the always-on Render call-control service. It admits any normal caller-ID-present phone, routes every turn directly into Civya's approved multilingual response protocol, retains only redacted usage metadata, and keeps audio recording disabled.

The intended production path is:

```text
Caller
  -> approved Twilio number
  -> Twilio Elastic SIP trunk over TLS
  -> sip:$PROJECT_ID@sip.api.openai.com;transport=tls
  -> OpenAI realtime.call.incoming signed webhook
  -> https://$PUBLIC_ORIGIN/api/webhooks/openai
  -> https://$CALL_CONTROL_HOST/webhooks/openai on Render
  -> signed https://$PUBLIC_ORIGIN/api/internal/phone/turn
  -> Civya public-answer protocol and approved multilingual speech
  -> OpenAI accept/monitor/refer/hangup APIs
```

The code path is fail-closed and has public admission with per-caller digest limits, approved multilingual speech, a 10-minute call limit, signed-webhook verification, durable turn/event deduplication, secure-link fallback, and human transfer. It never gives the phone model authority to change a case. **It is not activatable merely because those controls exist.**

The default response profile is `phone_fast`: `gpt-realtime-2.1` with Cedar
handles ordinary conversation, while current and official claims must come
through Civya's signed public-answer boundary. The rollback profile is
`renderer`: `gpt-realtime-2.1-mini` speaks only deterministic approved text.
This rollback is an explicit configuration change, never a silent downgrade.

## Readiness and ownership

| State | What is in that state | Owner needed to advance |
| --- | --- | --- |
| **Code-complete** | Signed OpenAI webhook validation, public caller admission by keyed digest, the shared Civya public-answer protocol, best-effort multilingual speech, Realtime SIP accept/monitor/refer/hangup control, a 10-minute limit, durable turn/event handling, health endpoints, secure-link request, and safe human/link fallback are implemented and tested in repository contracts. | Civya engineering maintains the call-control artifact. |
| **Activation-ready after gates** | The pinned Render service and one unpublished canary number can become ready only after health, signature, call-quality, fallback, cost, accessibility, and carrier rollback tests pass. | Civya release/telecom operators plus County service and security approvers. |
| **County/provider blocked** | Production number/trunk, OpenAI project/model/budget, Render service/region, secure SMS sender, staffed transfer target, provider agreements, resident scripts, and final launch approval are external dependencies. | County telecom, legal/privacy/procurement, human operations, and Twilio/OpenAI/Render account owners. |

Do not publish the number while any provider- or County-owned item remains blocked.

## Activation cannot proceed without

- County approval of the public phone number, automated-assistant disclosure, English and Spanish scripts, hours, accessibility, records treatment, escalation policy, and resident cohort.
- County legal/privacy/security review of call metadata, transient transcription, vendor data handling, and telecommunications obligations. Recording is outside this canary and must remain off.
- Executed and funded production agreements/accounts for Twilio, OpenAI, Render, Supabase, and any SMS or human-transfer provider.
- OpenAI project access to the selected Realtime model, an approved project budget, and a production webhook signing secret.
- A Twilio number legally available for the intended geography/use, an Elastic SIP trunk, approved caller-routing configuration, and a funded account.
- A continuously staffed or accurately scheduled human destination. An unstaffed transfer URI is not a fallback.
- A production secure-link issuer and consented SMS sender. The caller's phone number must not be treated as identity or case entitlement.
- County-approved behavior for outages, after-hours calls, emergencies, language needs, and callers who cannot receive SMS.

Do not advertise or port a County number until the full test and rollback path is proven. Civya is not an emergency service and must not be presented as one.

## Roles

| Role | Required decision |
| --- | --- |
| County service owner | Approves number, scripts, hours, cohort, and fallback |
| County telecom owner | Owns Twilio number/trunk and carrier rollback |
| County privacy/legal/security | Approves data path, contracts, disclosures, and evidence |
| Human-operations owner | Certifies staffing, transfer target, acceptance, and after-hours behavior |
| Civya release owner | Deploys app/call-control artifacts and feature gates |
| Cost owner | Approves Twilio/OpenAI/Render limits and daily review |
| Incident commander | Can detach the number and disable PSTN immediately |

## Incident and rollback contacts

Complete this table in the controlled launch packet. Blank contacts are a no-go.

| Contact | Name | 24/7 or launch-window route | Backup |
| --- | --- | --- | --- |
| County incident commander | `_____` | `_____` | `_____` |
| County telecom/Twilio owner | `_____` | `_____` | `_____` |
| Human transfer supervisor | `_____` | `_____` | `_____` |
| Civya/Render rollback operator | `_____` | `_____` | `_____` |
| OpenAI support escalation | `_____` | `_____` | `_____` |
| Twilio support escalation | `_____` | `_____` | `_____` |
| Privacy/security incident lead | `_____` | `_____` | `_____` |

## Required configuration

Keep these values in the appropriate application or Render secret store. Evidence records vault references, not values.

```text
TWILIO_ACCOUNT_SID=<production account>
TWILIO_AUTH_TOKEN=<production secret>
TWILIO_PHONE_NUMBER=<E.164 number>
TWILIO_SIP_TRUNK_SID=<trunk SID>
OPENAI_API_KEY=<project-scoped key>
OPENAI_PROJECT_ID=proj_<project>
OPENAI_WEBHOOK_SECRET=<webhook signing secret>
CIVYA_CALL_CONTROL_BASE_URL=https://<render-call-control-host>
CIVYA_WAYNE_TENANT_ID=<production tenant UUID>
CIVYA_TWILIO_PHONE_NUMBER=<same approved E.164 destination>
CIVYA_HUMAN_TRANSFER_URI=tel:+<approved E.164> | sip:<approved target>
CIVYA_SECURE_LINK_ISSUER_URL=https://<internal issuer>
CIVYA_INTERNAL_SERVICE_SECRET=<service-to-service secret>
CIVYA_SECURE_LINK_SECRET=<distinct link secret>
CIVYA_PHONE_TURN_URL=https://<production-host>/api/internal/phone/turn
CIVYA_PHONE_TURN_SERVICE_SECRET=<distinct 32+ byte secret>
CIVYA_PHONE_DIGEST_SECRET=<distinct 32+ byte HMAC secret>
CIVYA_PSTN_ACCESS_MODE=public
CIVYA_CALL_RECORDING_MODE=disabled
CIVYA_PSTN_MAX_CONCURRENT_CALLS=2
CIVYA_PSTN_MAX_TURNS=20
CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR=3
CIVYA_PSTN_MAX_DURATION_SECONDS=600
```

Start with both gates closed:

```text
CIVYA_ENABLE_PSTN=false
CIVYA_TELEPHONY_MODE=disabled
```

In `public` mode, Civya accepts any normally presented E.164 caller ID and immediately derives a tenant-keyed digest. It does not retain raw caller numbers, audio, or transcript text in durable call metadata. Withheld or malformed caller IDs fail closed. `CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR`, the concurrent-call cap, turn cap, and duration cap are required public-abuse and cost controls. Keep the two phone secrets in the deployment secret store.

The canary must keep `CIVYA_CALL_RECORDING_MODE=disabled`. Twilio Elastic SIP trunk recording is configured at the trunk and begins before a mid-call consent choice can be honored, so it cannot provide consent-gated recording on this direct OpenAI SIP route. If recording is ever needed, treat it as a separate, legally reviewed architecture with an audible disclosure and affirmative consent—not an environment-variable change.

## 1. Deploy and qualify Render call control

1. Create a dedicated, non-sleeping Render web service from the same pinned source SHA as the web release.
2. Use the repository's pinned Node runtime, build with `npm ci`, and start with `npm run worker:foundation`.
3. Run exactly one continuously available call-control instance for this number. Scale-to-zero and multiple replicas are not supported until active-call ownership is distributed.
4. Set the health-check path to `/health/ready`; also monitor `/health/live` and `/metrics`. Readiness must show the durable store current and `pstn.configured: true` before a canary.
5. Configure the approved region, outbound access to Supabase and OpenAI, restricted inbound HTTPS, log retention, and secret access.
6. Set `CIVYA_WORKER_CAPABILITIES=foundation.healthcheck,foundation.outbox.dispatch` so durable provider receipts and follow-up work can leave the outbox. Add any other capability only after its live adapter and governance boundary pass review.
7. Deploy an immutable artifact and prove a Render rollback to the prior artifact before connecting SIP.
8. Alert on restart loops, readiness failure, webhook non-2xx, call-accept failure, WebSocket failure, active-call saturation, and store health.

References: [Render deploys and rollback](https://render.com/docs/deploys#rolling-back-a-deploy) and [Render health checks](https://render.com/docs/health-checks).

## 2. Configure the OpenAI project and signed webhook

1. Use a production OpenAI project dedicated to the approved Civya environment. Record project ID, organization, model access, key owner, budget, and rotation date.
2. In OpenAI Project > Webhooks, create an endpoint at:

   ```text
   https://$PUBLIC_ORIGIN/api/webhooks/openai
   ```

3. Subscribe to `realtime.call.incoming` and store the one-time displayed signing secret as `OPENAI_WEBHOOK_SECRET` in both the web deployment and Render call-control service.
4. Preserve the raw request body and the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers. Both Civya's public endpoint and call-control verify the signature; invalid signatures return 400 and must never reach call acceptance.
5. Use `webhook-id` for durable idempotency. Duplicate events return success without accepting the same call twice.
6. Keep the webhook URL at its final HTTPS destination. OpenAI does not follow `3xx` webhook redirects and retries failures for up to 72 hours.
7. Send dashboard test events, a locally signed invalid event, a stale event, and a duplicate event. Capture redacted evidence.
8. Rotate a webhook secret in staging. Update both destinations as one change, test, then retire the previous secret. If either destination differs, keep PSTN disabled.

Set and record the phone response profile independently of browser voice:

| Setting | Normal `phone_fast` profile | Renderer rollback |
| --- | --- | --- |
| `CIVYA_PHONE_RESPONSE_MODE` | `phone_fast` | `renderer` |
| `CIVYA_PHONE_REALTIME_MODEL` | `gpt-realtime-2.1` | `gpt-realtime-2.1-mini` |
| `CIVYA_PHONE_REALTIME_VOICE` | `cedar` | `cedar` or qualified `marin` |

Changing one of these values requires a new canary call that checks the
profile, model, voice, greeting, ordinary conversation, official lookup,
interruption, secure link, human transfer, and privacy-safe metrics. Do not
route callers to automation if the observed profile differs from the recorded
release configuration.

References: [OpenAI Realtime SIP](https://developers.openai.com/api/docs/guides/realtime-sip) and [OpenAI webhook verification, retries, deduplication, and rotation](https://developers.openai.com/api/docs/guides/webhooks).

## 3. Configure Twilio number and Elastic SIP trunk

1. Purchase or port one approved production number. Complete any Twilio regulatory bundle, emergency-address, trust, or identity requirements applicable to that number before use.
2. Create one dedicated Elastic SIP trunk and record its SID, owner, friendly name, and environment.
3. Add this exact Origination SIP URI, substituting the OpenAI project ID:

   ```text
   sip:$PROJECT_ID@sip.api.openai.com;transport=tls
   ```

   Use the `sip` scheme with `transport=tls`, not `sips`. Twilio documents TLS 1.2 or later for secure SIP signaling. Do not enable a media-encryption option until Twilio/OpenAI interop has been explicitly tested and approved.

4. Associate only the canary number with the trunk. Do not attach an existing public County number during initial testing.
5. Confirm Twilio conveys the dialed number in the SIP `Diversion` header. Call control compares it with `CIVYA_TWILIO_PHONE_NUMBER` and rejects a different destination.
6. Enable Elastic SIP Trunking call transfer support, then prove one transfer to the approved staffed destination. The direct Elastic SIP route does not provide Programmable Voice live-call/status-callback controls; do not configure the messaging receipt URL as a voice callback.
7. Set the trunk's call-recording setting to **Do Not Record**. Confirm call logs and PCAP access are restricted to approved telecom/security operators.
8. Document the carrier-level rollback: detach the number from the trunk or route it to an approved human/announcement destination.

References: [Twilio Elastic SIP Trunking](https://www.twilio.com/docs/sip-trunking) and [Twilio SIP trunk pricing](https://www.twilio.com/en-us/sip-trunking/pricing/us).

## 4. Qualify secure-link and human fallbacks

### Secure link

- Ask permission before sending SMS. A prior call or possession of a number is not consent.
- The issuer receives only the approved purpose and destination, creates a random, session-bound, single-use link, sends it through the approved messaging provider, and never speaks the token aloud.
- The link uses HTTPS, has the approved short TTL, contains no phone number, case ID, parcel ID, tax data, or other resident data in the URL, and becomes unusable after first use.
- Opening the link begins at account authentication. It does not establish case entitlement.
- If sending fails, the approved speech says so and offers a human route; it must not request sensitive information over the call.

### Human transfer

- `CIVYA_HUMAN_TRANSFER_URI` must be an approved E.164 `tel:` or controlled `sip:` destination.
- Prove the receiving queue is staffed for published hours and that a person actually accepts the test transfer.
- Transfer only after the caller requests a person or deterministic policy requires escalation. Do not send a transcript or case facts unless a separate approved consent and minimization policy permits it.
- After hours or on transfer failure, use the approved callback/secure-link wording. Never claim that a person has accepted until the downstream system confirms it.

## 5. End-to-end test gate

Use synthetic callers and County-approved test accounts only. Calls must not alter a real case.

| Test | Required result |
| --- | --- |
| Valid inbound call | Signed event accepted once; destination matches; approved greeting plays |
| Invalid/stale signature | 400; no OpenAI accept call; security metric increments |
| Duplicate webhook | Deduplicated; no second call acceptance or speech |
| Wrong destination number | Call rejected; no tenant or case facts disclosed |
| Normal English/Spanish menu | Approved speech; no invented amount, status, deadline, eligibility, or completion |
| Additional approved test languages | Best-effort detection/localization preserves protected names, numbers, dates, URLs, and meaning; otherwise Civya safely falls back |
| Resident asks for case facts | Secure web/account-entitlement route offered; phone number is not treated as identity |
| Secure-link consent and send | One SMS, one-time link, expiry and reuse rejection proven |
| Secure-link send failure | Safe wording and human alternative |
| Human request | Confirmed transfer to staffed destination or accurate fallback |
| OpenAI/Render/Supabase outage | No fabricated response or completion; safe end/fallback and alert |
| Worker restart during call | Call ends safely; active-call map clears; readiness recovers |
| Maximum duration | Call closes at 30 minutes; no additional model or carrier use |
| Webhook retry | Redelivery remains idempotent and does not create a second accepted call |
| Kill switch | New calls no longer reach automation and callers reach the approved carrier fallback |
| Recording guard | Twilio trunk shows **Do Not Record** and runtime refuses to become ready for any recording mode other than `disabled` |

Also run `npm run test:call-control`, `npm run test:providers`, `npm run typecheck`, and the full release verification suite on the pinned artifact.

## 6. Cost cap and initial cohort

The cost owner must enter actual approved values before go-live. Blank or “unlimited” is a no-go.

| Control | Approved value | Evidence |
| --- | --- | --- |
| Monthly Twilio spend cap | `$_____` | Twilio budget/usage-trigger screenshot ID |
| Monthly OpenAI project budget | `$_____` | OpenAI project budget evidence ID |
| Render monthly service cap | `$_____` | Render plan/budget evidence ID |
| Maximum simultaneous calls | `_____` | Load-test and provider-limit evidence |
| Per-caller calls per hour | `3` | Public-admission configuration |
| Launch hours/time zone | `_____ America/Detroit` | Human staffing approval |

Set alerts at 50%, 75%, 90%, and 100% of the approved monthly cap. At 100%, or if projected spend exceeds the cap, stop new automated calls with the carrier rollback and PSTN kill switch. Provider budgets might alert rather than hard-stop; the incident owner remains responsible for disabling the route.

Keep the number unadvertised while it is being qualified. Public admission is bounded by the configured per-caller, concurrent-call, turn, duration, and provider-spend caps. Do not advertise it until monitored quality, fallback, latency, accessibility, and cost thresholds are satisfied.

## Treasurer test card

The treasurer can call from any ordinary caller-ID-present phone. They should hear that the assistant is automated, the call is not recorded, and limited redacted usage metadata is retained.

1. Ask one ordinary public-information question in English.
2. Ask the same question in another language the treasurer can evaluate.
3. Ask for private case details; Civya must offer a secure route and must not speak them.
4. Ask for a person; transfer must reach the approved staffed destination or say accurately that transfer is unavailable.
5. Hang up and confirm the operator record shows `public-caller`, a keyed call digest, duration, locale, outcome, and `recording: disabled`—never audio, transcript text, or the raw caller number.

## Go/no-go evidence

- County and vendor approval references; number/trunk/project ownership.
- Exact SIP URI, webhook URLs, destination number, and Render artifact SHA.
- Secret inventory with owner, vault reference, creation/expiry/rotation dates.
- Signed-webhook negative and deduplication evidence.
- Full test matrix, including a successful staffed transfer and secure-link failure.
- Redacted latency, failure, call-duration, and spend dashboards with alert tests.
- Approved disclosure, English/Spanish scripts, hours, after-hours, outage, and emergency wording.
- Carrier and application rollback drill completed within the approved target.

Any missing item is a no-go.

## Rollback

1. At the carrier layer, detach the canary number from the OpenAI trunk or route it to the approved human/announcement destination. Do this first so callers do not encounter repeated webhook failures.
2. Set `CIVYA_ENABLE_PSTN=false` and `CIVYA_TELEPHONY_MODE=disabled`; deploy the configuration and verify `/health/ready` reports PSTN inactive.
3. If the issue is limited to `phone_fast`, set `CIVYA_PHONE_RESPONSE_MODE=renderer` and `CIVYA_PHONE_REALTIME_MODEL=gpt-realtime-2.1-mini`. Deploy while the number remains off automation, then pass the renderer canary before reconnecting it.
4. If the issue is in call control rather than the response profile, roll Render back to the pinned prior artifact. Keep the number off automation until the full canary passes.
5. If a key or webhook secret is compromised, rotate it in the provider dashboard and both receiving services. Keep PSTN disabled during the cutover.
6. Preserve durable provider events and reconcile calls accepted before the cutoff. Do not delete uncertain events or mark transfers/SMS as successful without provider evidence.
7. Verify web general-information, account recovery, human support, and case-entitlement paths remain available.
8. Record trigger, timestamps, provider/config/artifact versions, affected call references as hashes, spend, resident impact, and recovery evidence.

Reactivation requires a new independent go/no-go decision.
