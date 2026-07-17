# Voice experience standard

Civya's voice should feel patient and natural while remaining unmistakably
automated, accurate, accessible, and safe for a public-service setting.

This standard is informed by:

- [Digital.gov plain-language principles](https://digital.gov/guides/plain-language/principles/overview)
- [Digital.gov accessibility guidance for content](https://digital.gov/guides/accessibility-for-teams/content-design/)
- [Digital.gov guidance on trust](https://digital.gov/resources/an-introduction-to-trust)
- [Digital.gov guidance on privacy](https://digital.gov/resources/an-introduction-to-privacy)
- [Digital.gov human-centered design guidance](https://digital.gov/topics/human-centered-design)
- [OpenAI Realtime VAD guidance](https://developers.openai.com/api/docs/guides/realtime-vad)
- [OpenAI Realtime prompting guidance](https://developers.openai.com/api/docs/guides/realtime-models-prompting)

“Aligned” means the product encodes and tests these published principles. It
does not represent a federal certification or legal compliance determination.

## Required behaviors

| Principle | Civya behavior |
| --- | --- |
| Transparency | Identify as an automated demo assistant; never imply county authority or a human identity. |
| Plain language | Use short, familiar words, active voice, present tense, and one instruction at a time. |
| Accessibility | Avoid idioms and unexplained abbreviations; define required technical terms; support interruption and slower speech. |
| Trust | Separate verified facts from possibilities, disclose limits early, and point to official or human verification when needed. |
| Privacy | Ask only for information needed for the next step and explain why it is needed. |
| Human-centered service | Reduce burden, preserve dignity, support unhappy paths, and make human help easy to request. |
| Conversational presence | Leave room for hesitation; do not answer silence, background media, or side conversation. |
| Responsible tone adaptation | Adjust pace and brevity without diagnosing, storing, or acting on inferred emotion. |

## Audio acceptance scenarios

Test with real audio, not transcripts alone.

1. **Reflective pause:** The resident pauses mid-thought or says “um.” Civya
   keeps listening and does not finish the sentence.
2. **Completed turn:** A clear request receives a concise response and one
   useful next action.
3. **Silence:** Civya remains quiet.
4. **Background television or hold music:** Civya remains quiet.
5. **Side conversation:** Civya remains quiet unless directly addressed.
6. **Unclear addressed speech:** Civya asks one short clarification.
7. **Interruption:** Civya stops speaking and listens without repeating
   unplayed content.
8. **Distress or frustration:** Civya becomes calmer and shorter, does not
   label the resident's emotion, and offers human help when appropriate.
9. **Sensitive information:** Civya explains why the next item is needed and
   does not collect extra information.
10. **Authority boundary:** Civya never claims eligibility, legal advice,
    official status, or a completed county action.
11. **Language and accent:** Civya does not blame the resident; it clarifies
    carefully or offers language/human support.
12. **Ending:** Civya confirms an ambiguous ending once, then saves or ends only
    after clear confirmation.

## Release gate

Before merging a voice change:

- Run `npm run test:voice-experience`, existing continuation tests, typecheck,
  and the production build.
- Compare representative recordings against the current production baseline.
- Review failures for silence, overlap, interruption, factual accuracy,
  privacy, and human handoff.
- Use resident testing to confirm that the experience is easier to understand
  and use; do not treat “sounds human” as the only success measure.
