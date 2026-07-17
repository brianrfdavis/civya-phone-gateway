# Civya — AI-Assisted Development Operating Layer

## gstack is required

This project uses [gstack](https://github.com/garrytan/gstack) as the default AI-assisted development workflow. Do not treat this as a passive note. When an AI coding agent works in this repo, it should actively route planning, implementation, review, QA, security, and shipping through gstack skills.

Install gstack before starting work:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Then restart the AI coding tool so the skills are loaded.

## Required development workflow

For meaningful product, design, architecture, or deployment work, use this sequence unless the user explicitly asks for a tiny one-line fix:

1. **Clarify the goal and constraints**
   - Use `/office-hours` for product intent, user value, business tradeoffs, and scope.
   - For Civya, always reason from the resident, county staff, and Treasurer/customer perspective.

2. **Plan before editing**
   - Use `/autoplan` or the relevant review-planning skill before making non-trivial changes.
   - For high-level product choices, use `/plan-ceo-review`.
   - For architecture or reliability choices, use `/plan-eng-review`.
   - For UX and UI changes, use `/plan-design-review`, `/design-consultation`, `/design-shotgun`, or `/design-html`.

3. **Implement deliberately**
   - Keep changes narrow and traceable to the plan.
   - Preserve the resident-first voice: plain, warm, calm, non-judgmental, and completion-oriented.
   - Avoid building generic government SaaS. Civya is opportunity infrastructure for urgent resident engagement and foreclosure prevention.

4. **Review before ship**
   - Use `/review` for code review.
   - Use `/cso` for security, privacy, secrets, auth, data, and abuse-risk review.
   - Use `/qa` or `/qa-only` for browser/user-flow verification.
   - Use `/design-review` for UI/UX changes.

5. **Ship only after gates pass**
   - Use `/ship` or `/land-and-deploy` for final readiness.
   - Use `/canary` where deployment risk is material.
   - Use `/document-release` when behavior, user flows, env vars, or deployment requirements changed.

## Standard gstack skills

Common skills available through gstack:

`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Civya-specific gates

Before considering work complete, verify the relevant gates:

- **Resident experience:** the path is simple, mobile-first, low-friction, and does not make the resident feel judged.
- **Completion logic:** the flow helps users complete the next concrete step, not merely learn information.
- **County value:** the change improves verified engagement, completion, staff visibility, outreach effectiveness, or foreclosure-prevention operations.
- **Data/privacy:** no secrets, personal data, uploaded documents, tax data, or contact information are exposed or mishandled.
- **Deployment:** Vercel/runtime behavior, env vars, database assumptions, and browser flows are verified when touched.

## Browsing and research

Use `/browse` from gstack when public research is needed. For official program rules, deadlines, forms, tax-relief eligibility, payment-plan terms, or legal/process details, prefer official county, city, state, court, or trusted partner sources and cite them in release notes or documentation.

## Do not skip the operating layer

If gstack is unavailable, pause and say so clearly. Do not silently proceed with major development as if the repo has no process. Tiny mechanical fixes may proceed, but meaningful work should use the gstack workflow above.