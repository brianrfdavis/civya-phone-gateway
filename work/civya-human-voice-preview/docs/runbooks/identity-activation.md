# Identity activation runbook

## Purpose and release boundary

Use this runbook to activate Google, Apple, LinkedIn (OIDC), or passkey sign-in through Supabase Auth. Activate one method at a time.

**A Civya account is not Wayne County case authorization.** Authentication may protect saved Civya progress and establish an account subject. It must not reveal that a County case exists, expose case facts, transfer a case, or authorize documents and case actions. Those operations require the separate County-approved entitlement verifier and server-side entitlement enforcement.

Stop activation if any direct API, database, or storage request can retrieve case data with only a valid Supabase session. UI hiding is not an authorization control.

## Readiness and ownership

| State | What is in that state | Owner needed to advance |
| --- | --- | --- |
| **Code-complete** | Provider-aware OAuth start/callback, passkey feature detection/linking, bounded encrypted resume state, generic email recovery, separate entitlement endpoints, and server entitlement guards are present and covered by repository tests. | Civya engineering maintains the contract and evidence. |
| **Activation-ready after gates** | A single provider can become canary-ready after its production callback, credential, recovery, RLS/API negative tests, accessibility review, and rollback drill pass. “Activation-ready” does not authorize case access. | Civya release owner plus County identity/security approver. |
| **County/provider blocked** | Production provider applications and credentials, County-approved Supabase/vendor agreements, the authoritative County entitlement service, human verification operations, and production approval are external dependencies. | County identity, privacy, procurement, entitlement, and provider application owners. |

Do not label an external dependency “code incomplete” or label tested code “activated.” The release record must carry all three states separately.

## Activation cannot proceed without

- A production Supabase project owned or contractually approved by the County, with named business, security, privacy, records-retention, and incident-response owners.
- County approval of the account-versus-case-entitlement design, the entitlement verifier contract, the human-verification path, and the resident-facing provider copy.
- Executed provider terms and approved production applications for each provider being enabled. An unverified developer application is not a production credential.
- A production hostname and exact callback URLs. Preview and wildcard callbacks are not production callbacks.
- A functioning email OTP/recovery path and staffed assistance path before any social provider becomes the only practical sign-in method.
- Evidence that RLS and every case-bearing server endpoint enforce entitlement independently of the browser.

If the County has not supplied an authoritative entitlement service, keep case access closed. Social sign-in can be tested in a non-case sandbox, but cannot activate a production case workflow.

## Roles

| Role | Required decision |
| --- | --- |
| County product owner | Approves resident cohort, copy, fallback, and activation window |
| County identity/security owner | Approves Supabase and provider configuration, threat model, secrets, and logs |
| County privacy/records owner | Approves data fields, retention, deletion, and provider agreements |
| Entitlement service owner | Certifies that account subjects map to case access only after separate verification |
| Civya release owner | Executes configuration, tests, evidence capture, and rollback |
| Support owner | Staffs recovery and case-verification assistance during the launch window |

Two people must participate in production credential changes: an operator and an independent verifier.

## Incident and rollback contacts

Complete this table in the controlled launch packet. Blank contacts are a no-go.

| Contact | Name | 24/7 or launch-window route | Backup |
| --- | --- | --- | --- |
| County incident commander | `_____` | `_____` | `_____` |
| County identity/security owner | `_____` | `_____` | `_____` |
| County entitlement owner | `_____` | `_____` | `_____` |
| Civya rollback operator | `_____` | `_____` | `_____` |
| Supabase escalation | `_____` | `_____` | `_____` |
| Google/Apple/LinkedIn escalation, as enabled | `_____` | `_____` | `_____` |
| Resident support lead | `_____` | `_____` | `_____` |

## Required values

Record values in the release evidence, but record only secret identifiers or vault references—never secret contents.

```text
PUBLIC_ORIGIN=https://<production-host>
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_PROVIDER_CALLBACK=https://<project-ref>.supabase.co/auth/v1/callback
CIVYA_CALLBACK=https://<production-host>/api/auth/oauth/callback
```

Deployment configuration:

```text
CIVYA_PUBLIC_ORIGIN=$PUBLIC_ORIGIN
CIVYA_AUTH_FLOW_SECRET=<distinct vault-managed secret>
CIVYA_AUTH_GOOGLE_ENABLED=false
CIVYA_AUTH_APPLE_ENABLED=false
CIVYA_AUTH_LINKEDIN_ENABLED=false
CIVYA_AUTH_PASSKEY_ENABLED=false
CIVYA_ENTITLEMENT_VERIFY_URL=<County-approved HTTPS endpoint>
CIVYA_ENTITLEMENT_VERIFY_SECRET=<distinct verifier secret>
CIVYA_ENTITLEMENT_HUMAN_HELP=<approved assistance instructions>
```

Keep all method flags false until that method passes its staging and production canary gates.

## Common Supabase configuration

1. In Supabase Auth URL Configuration, set the Site URL to `$PUBLIC_ORIGIN`.
2. Add the exact `$CIVYA_CALLBACK` to the redirect allow list. Do not use `**` for production; Supabase recommends exact production redirect paths.
3. Confirm the external providers use `$SUPABASE_PROVIDER_CALLBACK`. Providers return to Supabase first; Supabase PKCE then redirects to Civya's callback.
4. Confirm the application callback exchanges the code server-side, validates the encrypted flow nonce and expiry, and resumes only the bounded pending task.
5. Keep provider client secrets only in the provider console/Supabase secret store. They must never be browser variables, logs, screenshots, tickets, or release evidence.
6. Configure production session lifetime, refresh-token behavior, rate limits, CAPTCHA, audit-log retention, and incident alerts. Record the approved settings.
7. Prove anonymous-to-account linking, existing-account collision handling, and recovery with synthetic identities before enabling any provider.

References: [Supabase Auth](https://supabase.com/docs/guides/auth), [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls), and [session controls](https://supabase.com/docs/guides/auth/sessions).

## Provider activation

### Google

1. Use a County-approved Google Cloud project and Web OAuth client.
2. Complete audience, branding, privacy-policy, authorized-domain, and any required Google verification before production use.
3. Configure only the scopes needed for sign-in (`openid`, email, and profile as required by Supabase). Do not request Google service access.
4. Add `$PUBLIC_ORIGIN` as the authorized JavaScript origin and `$SUPABASE_PROVIDER_CALLBACK` as the authorized redirect URI.
5. Put the client ID and secret into the Supabase Google provider settings.
6. Test with a new Google identity, returning identity, denied consent, cancelled consent, revoked grant, and an identity whose email already belongs to a Civya account.
7. Set `CIVYA_AUTH_GOOGLE_ENABLED=true` only for the approved canary cohort.

Reference: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

### Apple

1. Require a County-approved Apple Developer team, App ID, Services ID, and signing key.
2. Configure the Services ID website domain as the Supabase project domain and the return URL as `$SUPABASE_PROVIDER_CALLBACK`.
3. Generate the Apple OAuth client secret from the protected `.p8` signing key and store both under separate, restricted vault controls.
4. Enter the Services ID/client secret in the Supabase Apple provider settings.
5. Schedule client-secret rotation at least 30 days before expiry. Apple web OAuth secrets must be regenerated every six months. The rotation ticket must name the key owner, expiry, operator, verifier, test date, and rollback secret reference.
6. Test normal email, Hide My Email relay, returning sign-in, denied/cancelled consent, revoked authorization, and missing name. Do not make a full name an authorization input; Apple web OAuth does not reliably return it.
7. Set `CIVYA_AUTH_APPLE_ENABLED=true` only after the rotation drill succeeds.

Reference: [Supabase Apple setup and six-month rotation requirement](https://supabase.com/docs/guides/auth/social-login/auth-apple).

### LinkedIn (OIDC)

1. Use a County-approved LinkedIn application associated with an approved LinkedIn Page.
2. Obtain the **Sign In with LinkedIn using OpenID Connect** product. Do not use the retired legacy LinkedIn provider.
3. Add `$SUPABASE_PROVIDER_CALLBACK` to Authorized Redirect URLs.
4. Configure the LinkedIn (OIDC) client ID/secret in Supabase. Civya's provider identifier is `linkedin_oidc`.
5. Test a new identity, returning identity, denied/cancelled consent, revoked application access, missing optional profile fields, and existing-account collision.
6. Set `CIVYA_AUTH_LINKEDIN_ENABLED=true` only for the approved canary cohort.

Reference: [Supabase LinkedIn OIDC setup](https://supabase.com/docs/guides/auth/social-login/auth-linkedin).

### Passkeys

Passkeys are currently experimental in Supabase and require explicit client opt-in. Treat this as an additional release risk, not as a default replacement for email recovery.

1. In Supabase Auth, enable passkeys and set:

   - Relying Party display name: approved Civya name.
   - RP ID: the stable bare production domain, with no scheme, port, or path.
   - RP origins: exact HTTPS production origins only.

2. Confirm the production domain will remain stable. Changing the RP ID makes existing passkeys unusable.
3. Confirm the deployed Supabase client version supports passkeys and explicit experimental opt-in remains enabled.
4. Permit registration only for an existing confirmed, non-anonymous account. Keep email or another recoverable identity linked.
5. Test registration, discoverable sign-in, cancellation, duplicate credential, deleted credential, lost device, multiple devices, unsupported browser, insecure origin, and account recovery.
6. Test at minimum current Safari/iCloud Keychain, Chrome/Google Password Manager, Android, Windows Hello, and a hardware security key used by the approved cohort.
7. Set `CIVYA_AUTH_PASSKEY_ENABLED=true` only for a small opt-in cohort. Disable it immediately if experimental API behavior changes.

Reference: [Supabase passkey authentication](https://supabase.com/docs/guides/auth/passkeys).

## Account/case boundary gate

Run these tests for every account method. All must pass.

- Sign in successfully without performing case verification. The resident sees only account state and generic verification instructions—no case existence, address, status, balance, documents, history, identifiers, or saved-case choice.
- Call bootstrap, case, document download, upload, conversation-turn, and case-activation APIs directly with the valid account session but no entitlement grant. Each case-bearing request fails closed.
- Query Supabase tables and storage through the public client with the same session. RLS/storage policy returns no case facts.
- Submit an invalid, expired, replayed, wrong-account, and wrong-case entitlement. The response remains non-enumerating.
- Complete a valid entitlement and confirm its account subject, case binding, method, expiry, and revocation behavior.
- Sign out, expire the grant, rotate the verifier secret, and revoke the entitlement. Case access closes without destroying account recovery.
- Choose the human-verification and general-information paths. Neither path leaks case facts.

The evidence must include HTTP status/result classes and redacted request correlation IDs, not resident content.

## Recovery and support gate

1. Verify `/api/auth/recovery/start` gives the same response for known and unknown email addresses and never creates an account.
2. Confirm email OTP delivery through the approved SMTP configuration, including spam and delay monitoring.
3. Test recovery after a provider outage, provider revocation, lost passkey, changed Apple relay address, and account collision.
4. Require step-up or staff review for consequential identity changes; support must never ask for passwords, OTPs, provider secrets, card data, or bank data.
5. Document account merge, unlink, deletion, legal hold, and compromised-account procedures before launch. If these procedures are not approved, support escalates and makes no account change.
6. Confirm a resident can continue with general information while identity or entitlement assistance is pending.

## County staff access gate

The built-in staff login is a production-capable controlled-launch fallback, not a substitute for County federation. The request hostname must appear in `CIVYA_TENANT_HOSTS`; Civya then resolves exactly one active tenant and never falls back to the fictional tenant. A six-digit email OTP is sent only when a service-only preflight finds an existing confirmed Supabase user with an active reviewer/admin `staff_roles` row for that exact tenant. Public start responses remain identical for authorized and unauthorized email addresses, and verification repeats the hostname, confirmed-user, and exact-role checks.

Before County activation:

1. Map each verified staff hostname to exactly one non-fictional tenant and test unknown-host rejection.
2. Provision staff identities out of band, confirm their email addresses, and insert least-privilege active `staff_roles`; staff sign-in never creates an account.
3. Test no-role, revoked-role, unconfirmed-user, wrong-host, and cross-tenant attempts at OTP start, verification, every staff API, workflow mutation, and direct RLS access.
4. Confirm demo invitation, seed/reset, and simulated reminder controls return forbidden in the production tenant.
5. Activate County workforce SSO/SCIM only after the County identity owner supplies IdP metadata, group-to-role mapping, lifecycle/deprovisioning behavior, MFA/conditional-access requirements, break-glass ownership, and signed acceptance evidence. Until then, label workforce federation as externally blocked and use approved email OTP only for the controlled cohort.

## Secret rotation

| Secret/credential | Rotation procedure | Rollback |
| --- | --- | --- |
| Google/LinkedIn client secret | Create replacement, update Supabase, canary sign-in, then revoke old credential | Restore the still-valid prior secret and disable the provider flag |
| Apple client secret | Generate before six-month expiry, update Supabase, canary Apple sign-in, retain the prior unexpired secret only for the approved rollback window | Restore prior unexpired client secret; disable Apple if uncertain |
| Apple `.p8` key | Rotate only with Apple team approval; inventory every client secret signed by it | Disable Apple; never improvise a key rollback |
| `CIVYA_AUTH_FLOW_SECRET` | Disable social/passkey starts, wait at least the maximum 15-minute flow TTL, replace secret, deploy, and canary all callbacks | Restore prior secret only if it is uncompromised; otherwise keep methods disabled |
| Supabase JWT signing key | Follow Supabase's standby/rotation procedure and validate both key sets before revocation | Keep the prior key trusted until all evidence passes |
| Entitlement verifier secret | Coordinate dual-key acceptance or a defined cutover with the County verifier; test negative and positive grants | Close case access and use human verification if either side is uncertain |

Reference: [Supabase JWT signing-key rotation](https://supabase.com/docs/guides/auth/signing-keys).

## Go/no-go evidence

- Provider application approval and contract reference.
- Exact callback and origin inventory.
- Secret-owner and expiry inventory with vault references.
- Successful provider/cancellation/recovery matrix.
- Account-without-entitlement negative evidence at UI, API, RLS, and storage layers.
- Valid entitlement, expiry, revocation, and human-fallback evidence.
- Accessibility test for every provider control and error state.
- Audit events showing method and outcome without tokens, authorization codes, emails, or case facts.
- Named launch owner, support owner, rollback operator, and 24-hour monitoring window.

Any missing item is a no-go.

## Rollback

1. Set only the affected `CIVYA_AUTH_*_ENABLED` flag to `false` and deploy the configuration. Keep email recovery and general information available.
2. If compromise is suspected, disable the provider in Supabase and revoke/rotate its credential. Do not wait for the application deploy.
3. If the entitlement boundary fails, set `CIVYA_PAUSE_ALL=true`, close case APIs at the server/RLS layer, and preserve audit evidence.
4. Do not delete accounts or unlink identities during an incident. Queue uncertain collisions for reviewed recovery.
5. Re-run email recovery and account-without-entitlement negative tests.
6. Record affected sessions, provider, configuration version, credential version, timeline, resident impact, and recovery evidence without storing secrets or case content.

Re-enable only after an independent reviewer signs the same activation gates.
