export type PhoneIntent =
  | "welcome"
  | "urgent_notice"
  | "payment_plan"
  | "document_readiness"
  | "reminders"
  | "account_help"
  | "secure_link"
  | "human_transfer"
  | "end"
  | "menu";

export type PhoneEffect = "none" | "send_secure_link" | "transfer_human" | "end_call";

export interface PhoneRoute {
  intent: PhoneIntent;
  approvedSpeech: string;
  effect: PhoneEffect;
  offerSecureLink: boolean;
  locale: string;
}

export interface PhoneRouterState {
  offeredSecureLink: boolean;
  locale: string;
}

const LINK = /\b(text me|send (?:me )?(?:a |the )?link|send (?:it|that) to me|secure link|sms|message me|yes.*(?:text|link)|env[ií]ame.*enlace|mensaje de texto)\b/i;
const END = /\b(goodbye|bye|hang up|that(?:'s| is) all|no thanks|adios|adi[oó]s|terminar)\b/i;
const SPANISH = /\b(espa[nñ]ol|ayuda|aviso|pago|documentos?|recordatorio|persona)\b/i;
const HUMAN_NOUN = "(?:person|human|representative|agent|navigator|someone|somebody|operator|staff|persona|humano|representante|agente)";
const HUMAN_REQUEST = new RegExp(
  `(?:^\\s*${HUMAN_NOUN}\\s*[.!?]*$|\\b(?:need|want|would like|let me|get me|quiero|necesito)\\b.{0,30}\\b${HUMAN_NOUN}\\b|\\b(?:talk|speak|hablar)\\s+(?:to|with|con)\\s+(?:a|an|the|una?|el|la)?\\s*${HUMAN_NOUN}\\b|\\b(?:transfer me|put me through|connect me (?:to|with)|comunicarme con)\\b)`,
  "i",
);
const NEGATED_HUMAN = new RegExp(
  `\\b(?:do not|don't|dont|not|no|never|no quiero)\\b.{0,35}\\b(?:speak|talk|transfer|connect|${HUMAN_NOUN})\\b`,
  "i",
);
const NEGATED_LINK = /\b(?:do not|don't|dont|not|no|never|no quiero)\b.{0,30}\b(?:text|link|sms|message|enlace|mensaje)\b/i;
const NEGATED_END = /\b(?:do not|don't|dont|not|no|never|no quiero)\b.{0,20}\b(?:hang up|end|goodbye|bye|terminar)\b/i;
const PAYMENT_ACTION = /\b(?:ready|want|need|trying|would like)\s+to\s+(?:pay|make (?:a |the )?payment|check out)|\b(?:pay|make (?:a |the )?payment)\s+(?:it|this|that|now|today|online)\b/i;
const UPLOAD_ACTION = /\b(?:ready|want|need|trying|would like)\s+to\s+(?:upload|send|submit|attach)\b|\b(?:upload|send|submit|attach)\s+(?:my |the |a )?(?:document|file|notice|photo|paperwork)\b/i;

export function welcomePhoneRoute(locale: "en" | "es" = "en"): PhoneRoute {
  if (locale === "es") {
    return route(
      "welcome",
      "Hola, soy Civya. Estoy aquí para ayudarle a entender lo que pasa y encontrar el mejor próximo paso. ¿Qué está pasando?",
      "none",
      false,
      locale,
    );
  }
  return route(
    "welcome",
    "Hi, I'm Civya. I'm here to help you understand what's happening and find the best next step. What's going on?",
    "none",
    false,
    locale,
  );
}

export function routePhoneTranscript(transcript: string, state: PhoneRouterState): PhoneRoute {
  const normalized = transcript.trim().slice(0, 2_000);
  const locale: "en" | "es" = state.locale === "es" || SPANISH.test(normalized) ? "es" : "en";
  if (!normalized) return menu(locale);

  const control = routePhoneControlTranscript(normalized, { ...state, locale });
  if (control) return control;

  if (UPLOAD_ACTION.test(normalized)) {
    return locale === "es"
      ? route("document_readiness", "Puedo enviarle la página para cargar el archivo. Podemos seguir hablando aquí mientras lo prepara.", "none", true, locale)
      : route("document_readiness", "I can send the upload page for that file. We can keep talking here while you get it ready.", "none", true, locale);
  }

  if (PAYMENT_ACTION.test(normalized)) {
    return locale === "es"
      ? route("payment_plan", "Puedo enviarle la página de pago cuando esté listo. También podemos seguir hablando aquí si primero quiere entender el monto o sus opciones.", "none", true, locale)
      : route("payment_plan", "I can send the payment page when you're ready. We can also keep talking here if you want help understanding the amount or your options first.", "none", true, locale);
  }

  if (/\b(foreclos|auction|court|sheriff|deadline|urgent|notice|aviso|subasta|tribunal|fecha l[ií]mite)\b/i.test(normalized)) {
    return locale === "es"
      ? route("urgent_notice", "Puedo ayudarle con eso. Dígame la fecha y las palabras principales del aviso, y le explicaré lo que significa y el mejor próximo paso.", "none", false, locale)
      : route("urgent_notice", "I can help with that. Tell me the date and the main wording on the notice, and I'll explain what it means and the best next step.", "none", false, locale);
  }

  if (/\b(payment|pay|plan|balance|amount|installment|pago|plan de pago|saldo|cantidad)\b/i.test(normalized)) {
    return locale === "es"
      ? route("payment_plan", "Puedo explicarle cómo funcionan los planes de pago y ayudarle a comparar el próximo paso. ¿Qué quiere saber sobre el monto o el plan?", "none", false, locale)
      : route("payment_plan", "I can explain how payment plans work and help you compare the next step. What do you want to know about the amount or the plan?", "none", false, locale);
  }

  if (/\b(document|upload|proof|income|identification|id card|paperwork|documento|subir|comprobante|ingreso|identificaci[oó]n)\b/i.test(normalized)) {
    return locale === "es"
      ? route("document_readiness", "Puedo ayudarle a preparar una lista clara de documentos. Dígame para qué programa o aviso está reuniendo los papeles.", "none", false, locale)
      : route("document_readiness", "I can help you make a clear document checklist. Tell me which program or notice you're gathering the paperwork for.", "none", false, locale);
  }

  if (/\b(remind|reminder|follow up|call me|text me later|recordatorio|recu[eé]rdame|seguimiento)\b/i.test(normalized)) {
    return locale === "es"
      ? route("reminders", "Puedo ayudarle a planear un recordatorio. Dígame qué necesita recordar y para cuándo.", "none", false, locale)
      : route("reminders", "I can help you plan a reminder. Tell me what you need to remember and when.", "none", false, locale);
  }

  if (/\b(sign in|login|account|passkey|google|apple|linkedin|verify|identity|iniciar sesi[oó]n|cuenta|verificar|identidad)\b/i.test(normalized)) {
    return locale === "es"
      ? route("account_help", "Puedo ayudarle a entender el acceso a su cuenta y el paso que sigue. Dígame qué aparece en su pantalla o qué está intentando hacer.", "none", false, locale)
      : route("account_help", "I can help you work through account access and the next step. Tell me what you see on the screen or what you're trying to do.", "none", false, locale);
  }

  return menu(locale);
}

/**
 * Only these deterministic commands may trigger a consequential phone effect.
 * Ordinary questions go through the shared public phone-turn protocol.
 */
export function routePhoneControlTranscript(transcript: string, state: PhoneRouterState): PhoneRoute | null {
  const normalized = transcript.trim().slice(0, 2_000);
  const locale: "en" | "es" = state.locale === "es" || SPANISH.test(normalized) ? "es" : "en";
  if (!NEGATED_HUMAN.test(normalized) && HUMAN_REQUEST.test(normalized)) {
    return locale === "es"
      ? route("human_transfer", "Voy a intentar comunicarle con una persona. Si no hay nadie disponible, le explicaré la opción segura para continuar.", "transfer_human", false, locale)
      : route("human_transfer", "I'll try to connect you with a person. If no one is available, I'll explain the secure way to continue.", "transfer_human", false, locale);
  }
  if (!NEGATED_LINK.test(normalized)
      && (LINK.test(normalized) || (state.offeredSecureLink && /^(yes|sure|okay|ok|s[ií])\b/i.test(normalized)))) {
    return locale === "es"
      ? route("secure_link", "Le enviaré un enlace seguro. El enlace vence y solo puede usarse una vez. Civya nunca le pedirá por mensaje de texto su contraseña, tarjeta o cuenta bancaria.", "send_secure_link", false, locale)
      : route("secure_link", "I'll send a secure link. The link expires and can be used only once. Civya will never ask for your password, card, or bank account by text message.", "send_secure_link", false, locale);
  }
  if (!NEGATED_END.test(normalized) && END.test(normalized)) {
    return locale === "es"
      ? route("end", "Me alegra haber podido ayudarle. Cuídese, y llámenos cuando necesite otro paso. Adiós.", "end_call", false, locale)
      : route("end", "I'm glad I could help. Take care, and call us whenever you need the next step. Goodbye.", "end_call", false, locale);
  }
  return null;
}

function menu(locale: "en" | "es"): PhoneRoute {
  return locale === "es"
    ? route("menu", "Puedo ayudar con un aviso urgente, pasos de un plan de pago, documentos, recordatorios o apoyo humano. Diga cuál necesita, o diga persona en cualquier momento.", "none", false, locale)
    : route("menu", "I can help with an urgent notice, payment-plan steps, documents, reminders, or human support. Say which one you need, or say person at any time.", "none", false, locale);
}

function route(
  intent: PhoneIntent,
  approvedSpeech: string,
  effect: PhoneEffect,
  offerSecureLink: boolean,
  locale: string,
): PhoneRoute {
  return { intent, approvedSpeech, effect, offerSecureLink, locale };
}
