# Maya — Civya Harbor v1

- Status: frozen reference release
- Frozen: 2026-07-17
- Source commit: `0d7c166dd9224637c890ba8426709954dd8e186c`
- Git tag: `civya-harbor-v1`
- Archive branch: `codex/civya-harbor-v1-archive`
- Immutable alias tag: `civya-maya-harbor-v1`
- Immutable alias branch: `codex/civya-maya-harbor-v1-archive`

“Maya” is the internal name for this release; the service always introduces
itself to callers as Civya and never claims a separate human identity. Harbor v1
is the approved fast, warm resident-guidance phone experience. Future
voice, prompt, model, routing, or call-control work must start from the Harbor v1
tag on a new branch. Do not move or replace the tag or archive branch.

## Resident experience

- Phone: `+1 (313) 946-9528`
- Voice model: `gpt-realtime-2.1`
- Voice: `marin`
- Response profile: `phone_fast`
- Profile version: `phone-fast-v2-2026-07-17`
- Transcription: `gpt-4o-transcribe`
- Response allowance: `inf`, so a spoken thought is not cut off by a small token cap
- Official lookup model: `gpt-5.6-sol`
- Opening: “Hi, I'm Civya. Tell me what happened, and I'll help you understand it and figure out the best next step.”
- Style: answer first, warm and direct, one to three short sentences, no routine disclaimers
- Current or official facts: verified through the approved official-answer tool before being spoken
- Recording: disabled

## Preserved production artifacts

### Phone gateway

- Render service: `civya-phone-gateway`
- Render service ID: `srv-d9d72fsm815s7395demg`
- Public health origin: `https://civya-phone-gateway.onrender.com`
- Preserved deployment commit: `0d7c166dd9224637c890ba8426709954dd8e186c`
- GitHub source: `brianrfdavis/civya-phone-gateway`

### Web experience

- Vercel project: `civya-human-voice-preview`
- Vercel project ID: `prj_QJsF4BWLR5Luhi4w1QfN79wOpKJz`
- Production deployment ID: `dpl_FLGNurk6atG6CcoZ2gUsiN5gCc5v`
- Production deployment: `https://civya-human-voice-preview-8d6i5r6eu-brianrfdavis-projects.vercel.app`
- Stable domain: `https://civya-human-voice-preview.vercel.app`
- GitHub source: `brianrfdavis/Civya`

## Integrity fingerprints

These SHA-256 values are computed from the files at the Harbor v1 tag.

| Runtime component | SHA-256 |
| --- | --- |
| `services/call-control/phone-fast.ts` | `985e214fffbc60a0d90337cb1e62dcbbb565ac6b61eb9ac31ab5b686559b3194` |
| `services/call-control/openai-sip.ts` | `e47d055e1a644abcd66f4563de6f6ea236bf1061cc4644bd55280667da2ea7f1` |
| `services/call-control/phone-router.ts` | `85b33d1945a7e46861184246e08b932f97d932019e4645cc9b9ae18366dc2b69` |
| `lib/integrations/openai-official-research.server.ts` | `13b78cae13830813aa148508d66d2f64aff5ed958c2bbf9b4cb4424154982a9f` |

## Configuration boundary

The tag preserves all source-controlled behavior. Production credentials remain
in the Render, Vercel, Twilio, OpenAI, and Supabase secret stores and must never
be copied into Git or a release note. The deployment requires the environment
variables documented in `.env.example` and `docs/runbooks/phone-activation.md`.

At the instant Harbor v1 was frozen, production was configured for three calls
per caller per hour. Live evidence showed that this operational limit accepted
the first three calls and rejected the next eight with status 429, causing the
reported ring-then-hang-up behavior. That limit is not part of the approved voice
experience and is repaired on the Harbor v1 call-stability fork without changing
the voice, prompt, model, or response profile. The live service now uses the
explicit stability setting `CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR=20`.

## Return procedure

1. Create a new branch from `civya-harbor-v1`.
2. Restore the Render phone service to commit `0d7c166dd9224637c890ba8426709954dd8e186c`.
3. Restore Vercel deployment `dpl_FLGNurk6atG6CcoZ2gUsiN5gCc5v` if the web experience also needs rollback.
4. Confirm `/health/ready` reports `gpt-realtime-2.1`, `marin`, `phone_fast`, and `phone-fast-v2-2026-07-17`.
5. Place a real phone call and confirm the greeting, a complete response, interruption handling, and an official-fact lookup.

The original and Maya-alias Git tags, archive branches in both repositories,
GitHub releases, and hosted deployment histories are independent recovery
points for the same approved release.
