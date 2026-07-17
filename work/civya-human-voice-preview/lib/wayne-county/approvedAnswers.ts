/**
 * Voice-optimized approved answers — spoken verbatim on a cache hit.
 * Reconciled against the Nexus Master Operating Intelligence Report
 * (June 11, 2026) and written to the Civya Voice & Messaging Standard
 * v1.0: calm urgency, situation-centered grammar (never blame), risk
 * always paired with a doable next step, no dead ends.
 */

export interface ApprovedAnswer {
  intent: string;
  question: string;
  utterances: string[];
  spokenAnswer: string;
  followUp?: string;
  escalate?: boolean;
  sourceConfidence: "verified" | "stable" | "needs_verification" | "demo_only";
  sourceUrl: string;
}

export const APPROVED_ANSWERS: ApprovedAnswer[] = [
  {
    intent: "can_i_save_my_home",
    question: "Can I still save my home?",
    utterances: ["Can I still save my home?", "Is it too late to save my house?", "Can I keep my home?", "Is there still time to fix this?"],
    spokenAnswer:
      "Your property may be at risk, and there may still be steps available — the exact path depends on where things are in the tax timeline. I'll ask a few quick questions so we can check what applies today: a payment plan, an exemption, or something urgent that needs direct help.",
    followUp: "Have you received any notices about the property — a letter, a court notice, or something posted at the door?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_forfeiture",
    question: "What does forfeiture mean?",
    utterances: ["What does forfeiture mean?", "My property was forfeited, what does that mean?", "What is forfeiture?", "The notice says forfeited"],
    spokenAnswer:
      "Forfeiture sounds scarier than it is. It does not mean the home is lost — it's a recording step that moves the unpaid taxes closer to foreclosure and raises the costs: about one hundred seventy-five dollars in fees, and interest going up to one and a half percent a month. There is still real time to act at this stage, and that's exactly what we're doing.",
    followUp: "Do you know which tax years are behind?",
    sourceConfidence: "stable",
    sourceUrl: "https://www.michigan.gov/taxes/property/delinquent",
  },
  {
    intent: "after_march_31",
    question: "What happens after March 31?",
    utterances: ["What happens after March 31?", "What if I miss the March deadline?", "What happens April 1st?", "What is the March 31 deadline?"],
    spokenAnswer:
      "March thirty-first of a foreclosure year is the last day to pay or be safely enrolled in a plan — on April first, ownership legally transfers. This deadline matters, and acting sooner protects more options. If it has already passed, there are still things worth checking, including a possible claim to leftover auction money and, for owner-occupants, a recent moratorium that may apply.",
    followUp: "Do you know if your property is in its foreclosure year right now?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_irspa",
    question: "What is IRSPA?",
    utterances: ["What is IRSPA?", "What's the interest reduction plan?", "Tell me about IRSPA"],
    spokenAnswer:
      "IRSPA is the Treasurer's reduced-interest payment plan. For people who own and live in their home with the homestead exemption on file, it drops the interest on back taxes from eighteen percent to six percent and puts all the delinquent years into one plan — no income limits. One honest caution: the law behind it was set to expire at the end of June unless lawmakers extended it, so step one is confirming today's status with the Treasurer. I can help you get ready either way.",
    followUp: "Do you own the home and live there most of the year?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_regspa",
    question: "What is REGSPA?",
    utterances: ["What is REGSPA?", "What's the regular payment agreement?"],
    spokenAnswer:
      "It's the Treasurer's standard payment agreement — payments spread out even when the reduced-interest plan doesn't fit, and it can even be held by an heir while an estate is being settled. The county's information on its current availability is mixed right now, so the Treasurer's office confirms the live status and terms. I can help you prepare everything they'll ask for.",
    followUp: "Is the property one you own and live in, or is it a different situation?",
    sourceConfidence: "needs_verification",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_dooe",
    question: "What is DOOE?",
    utterances: ["What is DOOE?", "What is the hardship extension?", "Can they pause my foreclosure for hardship?"],
    spokenAnswer:
      "DOOE is the Treasurer's hardship extension, and it's active. If you own and live in the home — with the deed recorded in your name — and can document real hardship, it holds the property out of this cycle's foreclosure for a year. The smart move is using that year to fix the problem, not just delay it, and I can help line that up.",
    followUp: "Can you tell me a little about the hardship you're facing?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_hope_wc",
    question: "What is HOPE?",
    utterances: ["What is HOPE?", "What's the HOPE program?", "hope exemption"],
    spokenAnswer:
      "HOPE is Detroit's Homeowners Property Exemption. If you own and live in your Detroit home and your income qualifies, it can remove ten to one hundred percent of this year's property taxes — and under a recent state-law change it can reach last year's taxes too. Approval automatically unlocks PAYS, which shrinks the older debt. This year's deadline is November sixth.",
    followUp: "Is the home in Detroit, and do you live there?",
    sourceConfidence: "verified",
    sourceUrl: "https://detroitmi.gov/government/boards/property-assessment-board-review/homeowners-property-exemption-hope",
  },
  {
    intent: "what_is_pays_wc",
    question: "What is PAYS?",
    utterances: ["What is PAYS?", "pay as you stay", "How does PAYS work?"],
    spokenAnswer:
      "PAYS stands for Pay As You Stay. Once you're approved for the HOPE exemption, it automatically cuts your county back taxes to the base taxes or ten percent of your home's taxable value — whichever is less — with up to three years to pay at zero interest, and the interest and fees are canceled when you finish. One honest note: the law behind PAYS was set to expire at the end of June unless extended, so the Treasurer confirms today's status. The HOPE application is still the right first step.",
    followUp: "Have you applied for HOPE before?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_is_dtrf",
    question: "What is the Detroit Tax Relief Fund?",
    utterances: ["What is the Detroit Tax Relief Fund?", "What is DTRF?", "the tax relief fund"],
    spokenAnswer:
      "It's philanthropic money — from the Gilbert Family Foundation and Rocket Community Fund, administered by Wayne Metro — that pays the rest of a PAYS balance down to zero for eligible Detroit homeowners. A qualifying homeowner can go from years of debt to a clean slate through one well-executed HOPE application. I can't promise the fund for your case, but I can help you take the steps that make it possible.",
    followUp: "Want to start with the HOPE screening questions?",
    sourceConfidence: "verified",
    sourceUrl: "https://waynemetro.org",
  },
  {
    intent: "missing_documents",
    question: "What if I do not have all my documents?",
    utterances: ["What if I don't have all my documents?", "I'm missing paperwork", "I don't have my documents together"],
    spokenAnswer:
      "That's completely okay — a lot of people don't have everything on hand, and nothing stops today because of a missing paper. We'll note what you have, I'll mark what's still needed, and you can add things as you find them. For most items, a photo from your phone works.",
    followUp: "Want me to start that checklist for you now?",
    sourceConfidence: "stable",
    sourceUrl: "https://detroitmi.gov",
  },
  {
    intent: "owner_died_wc",
    question: "What if the owner died?",
    utterances: ["What if the owner died?", "The owner passed away", "The house belonged to my mother who died"],
    spokenAnswer:
      "I'm sorry for your loss. I can still collect the basic information so the right person can review it — I'll ask a few questions, but I won't guess on ownership or legal issues. And we don't have to wait on everything: an heir can often hold a payment agreement while the estate is settled, and free legal-aid partners handle the probate side.",
    followUp: "How are you connected to the person who owned the home?",
    escalate: true,
    sourceConfidence: "verified",
    sourceUrl: "https://michiganlegalhelp.org",
  },
  {
    intent: "inherited_no_deed",
    question: "What if I inherited the house but the deed is not in my name?",
    utterances: ["I inherited the house but the deed isn't in my name", "The deed is still in my father's name", "The house was left to me but not transferred"],
    spokenAnswer:
      "That's common, and it's workable. The title side runs through probate, and free legal aid walks heirs through it — while tax deadlines keep running, which is why we work both tracks at once. An heir can often hold a standard payment agreement during probate, so let's collect your information and documents now while the title question goes to the right people.",
    followUp: "Are you living at the property now?",
    escalate: true,
    sourceConfidence: "verified",
    sourceUrl: "https://michiganlegalhelp.org",
  },
  {
    intent: "not_in_detroit",
    question: "What if I am not in Detroit?",
    utterances: ["What if I'm not in Detroit?", "My house is in Taylor", "I live in Westland not Detroit", "Does this work outside Detroit?"],
    spokenAnswer:
      "Wayne County help isn't only for Detroit. The Treasurer's payment plans cover the whole county, your own city may offer a poverty exemption like Detroit's HOPE, and the state homestead credit applies everywhere. Let's find your city's version of the path.",
    followUp: "Which city or township is the property in?",
    sourceConfidence: "stable",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "already_lost_home",
    question: "What if I already lost the home?",
    utterances: ["I already lost the home", "The house was foreclosed already", "It went to auction", "What if I already lost my house?"],
    spokenAnswer:
      "I'm sorry — and there may still be things that matter here. If the home sold for more than what was owed, you may have a right to the leftover money; the claim form must be notarized and reach the Treasurer by July first of the foreclosure year. For older foreclosures there may also be a separate settlement claim. And if you're still living in the home, a buy-back program called Make It Home may be worth checking. These deadlines are strict — let's treat this as urgent today.",
    followUp: "Do you know roughly when the foreclosure happened?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "pay_today",
    question: "Can I pay today?",
    utterances: ["Can I pay today?", "I want to pay right now", "Can I make a payment?"],
    spokenAnswer:
      "Yes. In this demo I can walk you through a simulated payment so you can see how it works — in a real deployment, this would route to the county's approved payment system. Real payments go through the Treasurer's online portal or the office at 400 Monroe in downtown Detroit.",
    followUp: "Would you like to see the demo payment, or get the steps for paying the county directly?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "setup_payment_plan_wc",
    question: "Can I set up a payment plan?",
    utterances: ["Can I set up a payment plan?", "Can I pay in installments?", "Can I pay monthly instead?"],
    spokenAnswer:
      "A payment plan may be available — the Treasurer offers several, including a reduced-interest plan for owner-occupants, and no-down-payment provisions for veterans and first responders. Enrollment can even start online. We'll check which plan fits before you commit to anything.",
    followUp: "Do you own the home and live there most of the year?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "veteran_or_responder",
    question: "Is there help for veterans or first responders?",
    utterances: ["I'm a veteran, is there help for me?", "Is there anything for first responders?", "I served in the military", "I'm a firefighter, does that matter?"],
    spokenAnswer:
      "Yes, and it's concrete: veterans can enter a Treasurer payment plan with no down payment using DD-214 or honorable-discharge papers, and police, firefighters, and EMS workers have the same no-down-payment provision with proof of employment. Wayne County Veterans Affairs can help pull discharge documents if needed.",
    followUp: "Which applies to you — veteran or first responder?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "can_you_submit",
    question: "Can you submit this for me?",
    utterances: ["Can you submit this for me?", "Will you send in my application?", "Can you file it for me?"],
    spokenAnswer:
      "In this demo I can prepare everything and run a simulated submission so you can see exactly how it works. In a real deployment, this would connect to the county's approved workflow — and either way, you'd get a confirmation and never have to re-tell your story.",
    followUp: "Want me to get your packet ready?",
    sourceConfidence: "demo_only",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "is_this_legal_advice",
    question: "Is this legal advice?",
    utterances: ["Is this legal advice?", "Are you a lawyer?", "Can I rely on this legally?"],
    spokenAnswer:
      "No — I explain public program information in plain language and help you take the next step. Some situations need human judgment, and free legal advocates exist for exactly that. I can send your information to the review team and help connect you.",
    followUp: "Is there a legal question on your mind I should route to them?",
    sourceConfidence: "verified",
    sourceUrl: "https://michiganlegalhelp.org",
  },
  {
    intent: "will_i_lose_home",
    question: "Will I lose my home?",
    utterances: ["Will I lose my home?", "Are they taking my house?", "Am I going to lose the house?"],
    spokenAnswer:
      "I can't predict that — but here's what's true: your property may be at risk, and there may still be steps available. Most people who reach out before the final deadline find a workable path — an exemption, a payment plan, or direct help. Let's check what applies today so nothing is left to guessing.",
    followUp: "Have you received any letters or notices about the property recently?",
    sourceConfidence: "verified",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "yellow_bag",
    question: "What is the notice posted on my door?",
    utterances: ["There's a yellow bag on my door", "What is the yellow bag?", "I got a yellow bag notice", "Someone posted a notice at my house", "There's a notice on my door"],
    spokenAnswer:
      "A notice posted at the property is one of the required steps the county takes before foreclosure — which means the timeline is getting serious, and it also means there's still time to act. This deadline matters. Let's read what stage it mentions and move on it today.",
    followUp: "Does the notice mention a hearing date or a deadline?",
    sourceConfidence: "stable",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
  {
    intent: "what_does_delinquent_mean",
    question: "What does delinquent mean?",
    utterances: ["What does delinquent mean?", "The letter says my taxes are delinquent", "What is a delinquency notice?"],
    spokenAnswer:
      "It means there are unpaid taxes connected to the property that have moved to the Wayne County Treasurer, and interest and fees are being added. It does not automatically mean the home is lost — it means now is the right time to look at the options, and that's what we're doing.",
    followUp: "First — do you currently live at the property?",
    sourceConfidence: "stable",
    sourceUrl: "https://treasurer.waynecounty.com",
  },
];
