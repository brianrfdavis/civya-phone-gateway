# Change Packet: Civya Bridge v2 voice and relationship fork

| Field | Value |
|---|---|
| Change ID | CIV-20260720-001 |
| Template version | 1.0.0 |
| Risk tier | R3 |
| Change type | feature |
| Lifecycle | Active |
| Owner | Civya Product / Engineering |
| Created | 2026-07-20 |

## Outcome

Preserve the approved fast phone experience as the internal release **Maya — Harbor v1**, then prepare a separate, undeployed **Civya Bridge v2** candidate that uses a quality-recommended contrast voice and a concise Join → Bridge → Next conversation pattern. The candidate must remain fast, accurate, non-patronizing, transparent that Civya is automated, reversible without data migration, and subject to representative audio testing before activation.

## Authority and boundaries

- Governing canonical sources: C-002, C-003, C-009, Resident Experience Standard, Security & Privacy Standard, voice experience standard, Digital.gov plain-language/HCD guidance, and official OpenAI Realtime documentation.
- In scope: frozen Git refs, phone profile/prompt/opening, Cedar candidate, tests, release/rollback evidence.
- Out of scope: production deployment, new memory/data/tools/providers, official policy or eligibility, and any racial identity claim about a synthetic voice.
- Protected decisions requiring named human authority: Security/Privacy and R3 release approval; research/retention protocol; any production activation.

## Managed packet status

Do not edit between the markers. `scripts/civya-change.mjs` regenerates this section.

<!-- CIVYA:MANAGED:START -->
**Generated:** 2026-07-20T04:51:42.974Z  
**Harness:** 1.1.0  
**Branch/source:** `codex/civya-bridge-v2-cedar` / `bf58be5`  
**GStack project:** brianrfdavis-Civya  
**GStack evidence:** audit: 3, plan: 1, qa: 1, review: 3

### Required documents

| Document | State |
|---|---|
| `CHANGE_PACKET.md` | Present |
| `IMPLEMENTATION_PLAN.md` | Present |
| `REVIEW_REPORT.md` | Present |
| `ACCEPTANCE_TESTS.md` | Present |
| `FEATURE_BRIEF.md` | Present |
| `RELEASE_RECORD.md` | Present |
| `DECISION_RECORD.md` | Present |
| `THREAT_MODEL.md` | Present |

### Captured GStack evidence

| Category | GStack source | Durable snapshot | SHA-256 | Source modified |
|---|---|---|---|---|
| qa | `brfdavis-codex-civya-bridge-v2-cedar-eng-review-test-plan-20260720-003500.md` | [snapshot](evidence/gstack/qa/brfdavis-codex-civya-bridge-v2-cedar-eng-review-test-plan-20260720-003500.md) | `784fa5d95b7c…` | 2026-07-20T04:35:25.850Z |
| plan | `codex-civya-bridge-v2-cedar-autoplan-restore-20260720-002116.md` | [snapshot](evidence/gstack/plan/codex-civya-bridge-v2-cedar-autoplan-restore-20260720-002116.md) | `ef9b0fd40a96…` | 2026-07-20T04:21:31.186Z |
| review | `codex-civya-bridge-v2-cedar-review-outcome-20260720-004900.md` | [snapshot](evidence/gstack/review/codex-civya-bridge-v2-cedar-review-outcome-20260720-004900.md) | `a379584b61e6…` | 2026-07-20T04:49:16.916Z |
| review | `codexcivya-bridge-v2-cedar-reviews.jsonl` | [snapshot](evidence/gstack/review/codexcivya-bridge-v2-cedar-reviews.jsonl) | `95986782dc78…` | 2026-07-20T04:35:49.834Z |
| audit | `decisions.active.json` | [snapshot](evidence/gstack/audit/decisions.active.json) | `24e4668fd698…` | 2026-07-20T04:35:49.913Z |
| audit | `decisions.jsonl` | [snapshot](evidence/gstack/audit/decisions.jsonl) | `fbd5ca4ed648…` | 2026-07-20T04:35:49.912Z |
| review | `tasks-eng-review-20260720-003600.jsonl` | [snapshot](evidence/gstack/review/tasks-eng-review-20260720-003600.jsonl) | `bbe3ad9e359d…` | 2026-07-20T04:35:49.597Z |
| audit | `timeline.jsonl` | [snapshot](evidence/gstack/audit/timeline.jsonl) | `dbea945cb0bc…` | 2026-07-20T04:20:23.525Z |

The snapshots above are evidence, not approval. Resolve decisions and findings in the governed packet documents.
<!-- CIVYA:MANAGED:END -->

## Decisions and deviations

| Decision/deviation | Owner/approver | Evidence | Status |
|---|---|---|---|
| `cedar` is an audition candidate, not a racial label; fit requires representative listening | Product / UX | `DECISION_RECORD.md` | Accepted for candidate |
| Keep the spoken identity as Civya; use Maya only as the internal Harbor release name | Product / Resident Operations | C-002/C-003 and `DECISION_RECORD.md` | Accepted for candidate |
| No live deployment in this change | Civya owner / Release | `FEATURE_BRIEF.md` | Required |

## Final handoff

- Outcome delivered: Maya — Harbor v1 preserved at immutable original and alias refs; undeployed Civya Bridge v2 Cedar source candidate implemented with voluntary relationship behavior, corrected stop/decline controls, and durable profile attribution.
- Verification summary: focused phone tests, full repository tests, TypeScript, foundation/security suites, build, independent review, and rollback-ref checks passed.
- Known limitations and accepted risks: no production risk accepted. Interrupted disclosure, representative audio, latency/completeness, qualified Spanish, fallback, privacy/research, and named approvals remain release blockers.
- Required next role/approval: real SIP QA and Product/Resident Operations, Privacy/Legal/Records, Security, Brand/GTM, named QA, and release authority.
- Canonical records updated: no canonical product truth changed; candidate and frozen-release manifests plus this governed packet were updated.
