# Civya Bridge v2 — Cedar candidate

- Status: source-only candidate; not deployed
- Parent: Maya — Harbor v1 (`civya-maya-harbor-v1`)
- Candidate branch: `codex/civya-bridge-v2-cedar`
- Change packet: `CIV-20260720-001`

Bridge v2 keeps Harbor's low-latency Realtime architecture and official-answer
boundary. It tests a warmer relationship pattern: answer what the caller said,
ask permission to return to the tax concern, offer one useful next step, and
respect a decline. The internal release names are never spoken to callers.

## Candidate configuration

| Setting | Value |
| --- | --- |
| `CIVYA_PHONE_RESPONSE_MODE` | `phone_fast` |
| `CIVYA_PHONE_REALTIME_MODEL` | `gpt-realtime-2.1` |
| `CIVYA_PHONE_REALTIME_VOICE` | `cedar` (explicit opt-in) |
| reasoning | `low` |
| transcription | `gpt-4o-transcribe` |
| server VAD silence | `500 ms` |
| response allowance | `inf` |
| profile version | `civya-bridge-v2-2026-07-20` |

If the voice setting is absent or invalid, source code falls back to `marin`.
Cedar is an OpenAI quality-recommended voice; OpenAI does not publish racial or
gender labels for its voices. Selection must therefore be based on consented,
blind listening research rather than a demographic claim.

## Required blind comparison

Test all four combinations so prompt and voice effects are not confused:

1. Harbor prompt + Marin.
2. Bridge prompt + Marin.
3. Harbor prompt + Cedar.
4. Bridge prompt + Cedar.

Use representative Wayne County callers on real PSTN audio. Record first-audio
latency, interruptions, complete-thought rate, task progress, comprehension,
warmth, respect, trust, preference, and any stereotyped or patronizing quality.
Bridge must improve at least one resident-experience measure without worsening
completion, official-fact accuracy, disclosure comprehension, or safety.
Research notes and recordings are Confidential until deidentified; recording
remains disabled in ordinary calls.

## Activation blockers

Do not activate or advertise Bridge v2 until all of these are complete:

- real SIP event-machine and repeated-call tests, including “no thanks,” stop,
  interrupted opening disclosure, human transfer, secure link, and fallback;
- PSTN median and p95 speech-stop-to-first-audio evidence versus Harbor;
- representative blind listening research and documented disposition;
- English content, qualified Spanish content, accessibility, and non-AI
  fallback verification;
- Product/Resident Operations, Privacy/Legal/Records, Security, Brand/GTM, and
  release-owner approvals recorded in the governed change packet.

This candidate adds no new deterministic crisis-decision path, analytics,
recording, or memory behavior. The conservative official-lookup trigger remains
unchanged; a future stateful latency design requires its own review.

## Rollback

Stop new admissions, let active calls drain when possible, then restore the
Maya — Harbor v1 source/configuration tuple:

- source `0d7c166dd9224637c890ba8426709954dd8e186c`;
- `phone_fast`, `gpt-realtime-2.1`, `marin`;
- profile `phone-fast-v2-2026-07-17`;
- `CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR=20`.

If an urgent shutdown cannot drain calls, record that active callers were
interrupted and provide the staffed fallback before reopening the number.
