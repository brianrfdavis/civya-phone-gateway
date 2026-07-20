# QA Outcome: Civya Bridge v2 Cedar candidate

**Revision:** `107728d`  
**Environment:** Local isolated browser regression plus repository automation  
**Decision:** Source candidate passes automated and browser-smoke gates; do not activate in production.

## Automated evidence

- Full repository test suite passed on the candidate working tree.
- TypeScript, focused phone-profile, call-control, phone-turn, official-research, foundation/security, and production build checks passed.
- Prompt/profile contracts verify `gpt-realtime-2.1`, low reasoning, 500 ms VAD, unlimited response output, explicit Cedar audition, and Marin fallback.
- Call lifecycle evidence includes model, voice, response mode, and profile version without caller content.

## Browser smoke

- Home and typed-entry states rendered without visual or control regressions.
- Text input enabled Send and retained named controls and accessibility structure.
- The isolated copy's `/api/bootstrap` returned 503 because no database credentials were supplied; the existing saved-progress error state rendered correctly. This is outside the phone-only diff.

## Blocked human/provider evidence

- Real SIP barge-in must prove that an interrupted automated-service disclosure is replayed or otherwise completed.
- Representative Black resident listening must compare prompt and voice independently; Cedar is a provider voice name, not a demographic label.
- Comparable Harbor/Bridge p50/p95 latency and complete-thought rate are not yet measured.
- Qualified Spanish, deterministic non-AI fallback, privacy/research approval, rollback exercise, and named R3 approvals remain outstanding.

**Open P1:** interrupted opening can proceed without proven disclosure completion. This prohibits production activation.
