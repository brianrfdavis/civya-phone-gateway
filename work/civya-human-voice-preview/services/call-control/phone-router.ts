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

const HUMAN = /\b(person|human|representative|agent|navigator|someone|operator|staff|persona|humano|representante|agente)\b/i;
const LINK = /\b(text me|send (?:me )?(?:a )?link|secure link|sms|message me|yes.*(?:text|link)|env[ií]ame.*enlace|mensaje de texto)\b/i;
const END = /\b(goodbye|bye|hang up|that(?:'s| is) all|no thanks|adios|adi[oó]s|terminar)\b/i;
const SPANISH = /\b(espa[nñ]ol|ayuda|aviso|pago|documentos?|recordatorio|persona)\b/i;

export function welcomePhoneRoute(locale: "en" | "es" = "en"): PhoneRoute {
  if (locale === "es") {
    return route(
      "welcome",
      "Hola, soy Civya, un asistente automatizado. Esta llamada de prueba no se graba; solo guardamos datos limitados de uso. Puedo ayudarle con información general o comunicarle con una persona. No soy la Tesorería y no puedo cambiar un registro oficial. ¿Qué necesita hoy?",
      "none",
      false,
      locale,
    );
  }
  return route(
    "welcome",
    "Hi, I'm Civya, an automated assistant. This test call is not recorded; only limited usage metadata is kept. I can help with general information or help you reach a person. I'm not the Treasurer and I can't change an official record. What do you need today?",
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

  if (/\b(foreclos|auction|court|sheriff|deadline|urgent|notice|aviso|subasta|tribunal|fecha l[ií]mite)\b/i.test(normalized)) {
    return locale === "es"
      ? route("urgent_notice", "Puedo ayudarle a revisar el aviso sin adivinar fechas o resultados. Para proteger sus opciones, use el aviso oficial como fuente y pida ayuda humana si una fecha está cerca. Puedo enviarle un enlace seguro o comunicarle con una persona.", "none", true, locale)
      : route("urgent_notice", "I can help you review the notice without guessing about dates or outcomes. To protect your options, use the official notice as the source and ask for human help if a date is close. I can text a secure link or connect you with a person.", "none", true, locale);
  }

  if (/\b(payment|pay|plan|balance|amount|installment|pago|plan de pago|saldo|cantidad)\b/i.test(normalized)) {
    return locale === "es"
      ? route("payment_plan", "Puedo explicarle los pasos de un plan de pago, pero no diré que un monto o pago está confirmado sin una respuesta de la fuente aprobada. Civya no recibe datos de tarjeta o banco. Puedo enviarle un enlace seguro para continuar.", "none", true, locale)
      : route("payment_plan", "I can explain payment-plan steps, but I won't say an amount or payment is confirmed without a response from the approved source. Civya does not collect card or bank details. I can text a secure link so you can continue safely.", "none", true, locale);
  }

  if (/\b(document|upload|proof|income|identification|id card|paperwork|documento|subir|comprobante|ingreso|identificaci[oó]n)\b/i.test(normalized)) {
    return locale === "es"
      ? route("document_readiness", "Puedo ayudarle a preparar una lista de documentos. Los archivos deben cargarse por el sitio seguro, donde comienzan privados y en cuarentena para su revisión. Puedo enviarle el enlace seguro.", "none", true, locale)
      : route("document_readiness", "I can help you prepare a document checklist. Files must be uploaded through the secure site, where they start private and quarantined for review. I can text the secure link.", "none", true, locale);
  }

  if (/\b(remind|reminder|follow up|call me|text me later|recordatorio|recu[eé]rdame|seguimiento)\b/i.test(normalized)) {
    return locale === "es"
      ? route("reminders", "Puedo ayudarle a configurar recordatorios después de que confirme el canal y dé su consentimiento. Un recordatorio no confirma que el Condado haya recibido o aprobado algo. Puedo enviarle un enlace seguro.", "none", true, locale)
      : route("reminders", "I can help set reminders after you confirm the channel and give consent. A reminder does not confirm that the County received or approved anything. I can text a secure link.", "none", true, locale);
  }

  if (/\b(sign in|login|account|passkey|google|apple|linkedin|verify|identity|iniciar sesi[oó]n|cuenta|verificar|identidad)\b/i.test(normalized)) {
    return locale === "es"
      ? route("account_help", "Puede iniciar sesión con las opciones disponibles en el sitio seguro. Iniciar sesión protege su progreso, pero no abre por sí solo un expediente del Condado. La verificación del expediente es un paso separado. Puedo enviarle el enlace seguro.", "none", true, locale)
      : route("account_help", "You can sign in with the available options on the secure site. Signing in protects your progress, but it does not open a County case by itself. Case verification is a separate step. I can text the secure link.", "none", true, locale);
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
  if (HUMAN.test(normalized)) {
    return locale === "es"
      ? route("human_transfer", "Voy a intentar comunicarle con una persona. Si no hay nadie disponible, le explicaré la opción segura para continuar.", "transfer_human", false, locale)
      : route("human_transfer", "I'll try to connect you with a person. If no one is available, I'll explain the secure way to continue.", "transfer_human", false, locale);
  }
  if (LINK.test(normalized) || (state.offeredSecureLink && /^(yes|sure|okay|ok|s[ií])\b/i.test(normalized))) {
    return locale === "es"
      ? route("secure_link", "Le enviaré un enlace seguro. El enlace vence y solo puede usarse una vez. Civya nunca le pedirá por mensaje de texto su contraseña, tarjeta o cuenta bancaria.", "send_secure_link", false, locale)
      : route("secure_link", "I'll send a secure link. The link expires and can be used only once. Civya will never ask for your password, card, or bank account by text message.", "send_secure_link", false, locale);
  }
  if (END.test(normalized)) {
    return locale === "es"
      ? route("end", "Gracias por llamar. Ningún paso oficial se considera completado hasta que la fuente aprobada lo confirme. Adiós.", "end_call", false, locale)
      : route("end", "Thanks for calling. No official step is treated as complete until the approved source confirms it. Goodbye.", "end_call", false, locale);
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
