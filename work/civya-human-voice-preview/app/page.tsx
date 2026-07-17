"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CivyaRealtimeClient,
  type CaseUpdate,
  type CivyaStatus,
} from "@/lib/realtime/client";
import { SiteHeader } from "./components/site-header";
import { TurnstileWidget } from "./components/turnstile-widget";
import {
  browserSupportsPasskeys,
  registerCivyaPasskey,
  signInWithCivyaPasskey,
} from "@/lib/auth/passkey-client";
import { uploadDocumentDirect } from "@/lib/documents/upload-client";
import {
  IconChat,
  IconCheck,
  IconClipboard,
  IconDoc,
  IconExternal,
  IconGlobe,
  IconHeadset,
  IconMic,
  IconSend,
  IconUpload,
} from "./components/icons";

// ── Types ─────────────────────────────────────────────────────────────

interface Msg {
  id: number;
  who: "resident" | "civya";
  text: string;
  final: boolean;
  actions?: { label: string; prompt: string }[];
}

interface Activity {
  id: number;
  label: string;
  detail?: string;
  time: string;
  kind: "doc" | "chat" | "check";
}

interface PanelState {
  caseId: string;
  status?: string;
  address?: string;
  nextBestAction?: string;
  intakeCollected?: number;
  intakeTotal?: number;
  missingDocuments?: string[];
  checklistSummary?: string;
  reviewRequired?: boolean;
  pathwayLabel?: string;
}

type AuthState = "guest" | "anonymous" | "verified" | "declined";
type SaveState = "idle" | "saving" | "saved" | "degraded";

interface AuthRequirement {
  reason?: string;
  message: string;
  pendingTurnId?: string;
  pendingQuestion?: string;
  sensitiveFields?: string[];
}

type AccountProvider = "google" | "apple" | "linkedin";
type EntitlementState = "unknown" | "account_required" | "required" | "verifying" | "verified" | "selection" | "unavailable" | "human";

interface OAuthProviderCapability {
  provider: AccountProvider;
  label: string;
  available: boolean;
  unavailable_reason?: string;
}

interface PasskeyCapability {
  available: boolean;
  browser_feature_detection_required?: boolean;
  unavailable_reason?: string;
}

interface EntitlementCapability {
  notice_code: boolean;
  invitation_code: boolean;
  staff_assisted: boolean;
  unavailable_reason?: string;
}

interface EntitlementStatusResponse {
  account?: { state?: string };
  entitlement?: { state?: string; method?: string; expires_at?: string };
  resume?: ProtectedResumeResponse["resume"];
  case_selection_required?: boolean;
  attached_case_id?: string;
  existing_active_case_id?: string;
  existing_case_available?: boolean;
  capabilities?: EntitlementCapability;
  error?: string;
}

interface ProtectedResumeResponse {
  account?: { state?: string; method?: string };
  entitlement?: { state?: string };
  resume?: {
    pending_task?: {
      turnId?: string;
      turn_id?: string;
      question?: string;
      action?: "upload" | "paste" | "resume" | "saved_action";
      reason?: string;
    };
  };
  case_selection_required?: boolean;
  attached_case_id?: string;
  existing_active_case_id?: string;
  existing_case_available?: boolean;
  error?: string;
}

interface CaseSelectionRequirement {
  attachedCaseId: string;
  existingActiveCaseId: string;
  existingCaseAvailable: boolean;
  pendingQuestion?: string;
}

interface ResumeContext {
  confirmedFacts?: Record<string, string>;
  confirmed_facts?: Array<{ key: string; value: string; confirmed_at?: string }>;
  conversationSummary?: string;
  conversation_summary?: string;
  recentTurns?: Array<{
    id?: string;
    role?: "user" | "assistant" | "resident" | "civya";
    text?: string;
    transcript?: string;
    redactedText?: string;
    redacted_text?: string;
  }>;
  recent_turns?: Array<{
    id?: string;
    role?: "user" | "assistant" | "resident" | "civya";
    text?: string;
    transcript?: string;
    redactedText?: string;
    redacted_text?: string;
  }>;
  currentWorkflowState?: string;
  current_workflow_state?: string;
  next_question?: string;
}

interface SessionBootstrap {
  authentication?: {
    state?: string;
    email?: string;
    verified?: boolean;
    isAnonymous?: boolean;
    is_anonymous?: boolean;
    masked_email?: string;
  };
  auth?: SessionBootstrap["authentication"];
  resident?: { id?: string } | null;
  activeCase?: Record<string, unknown> | null;
  active_case?: Record<string, unknown> | null;
  case?: Record<string, unknown> | null;
  conversation?: { id?: string; status?: string; pending_turn_id?: string | null } | null;
  resumeContext?: ResumeContext;
  resume_context?: ResumeContext;
  resumeSummary?: string;
  resume_summary?: string;
  nextAction?: string | { kind?: string; question?: string };
  next_action?: string | { kind?: string; question?: string };
  degraded?: boolean;
  persistence?: { state?: "saved" | "degraded" | "unavailable" | string; message?: string };
  capabilities?: { voice?: boolean; uploads?: boolean; reminders?: boolean; staff?: boolean };
  sandbox?: { fictional?: boolean; retention_days?: number };
  error?: string;
}

interface TurnResult {
  spokenResponse?: string;
  spoken_response?: string;
  assistantText?: string;
  assistant_text?: string;
  nextQuestion?: string;
  next_question?: string;
  authRequired?: Partial<AuthRequirement> | null;
  auth_required?: Partial<AuthRequirement> | null;
  caseUpdate?: Record<string, unknown> | null;
  case_update?: Record<string, unknown> | null;
  persisted?: boolean;
  interaction_state?: string;
  conversation_id?: string;
  persistence?: { state?: "saved" | "degraded" | "unavailable" | string; message?: string };
  error?: string;
}

// ── Copy (EN/ES for the landing surface) ──────────────────────────────

const COPY = {
  en: {
    badge: "Plain language. No judgment. We're here to help.",
    heroA: "What can we help",
    heroB: "you with ",
    heroHl: "today?",
    sub: "Tell Civya what's going on, and we'll guide you to your next best step.",
    placeholder: 'Ask Civya anything… (e.g., "I got a foreclosure notice")',
    placeholderShort: "Ask Civya anything…",
    placeholderChat: "Message Civya…",
    trySection: "Try asking Civya",
    popularSection: "Popular ways we can help",
    langBtn: "Español",
  },
  es: {
    badge: "Lenguaje claro. Sin juicios. Estamos aquí para ayudar.",
    heroA: "¿En qué podemos",
    heroB: "ayudarle ",
    heroHl: "hoy?",
    sub: "Cuéntele a Civya qué está pasando y le guiaremos a su mejor próximo paso.",
    placeholder: 'Pregúntele a Civya… (p. ej., "Recibí un aviso de ejecución")',
    placeholderShort: "Pregúntele a Civya…",
    placeholderChat: "Escríbale a Civya…",
    trySection: "Pruebe preguntarle a Civya",
    popularSection: "Formas populares de ayudar",
    langBtn: "English",
  },
};

const RESOURCES = [
  { label: "HOPE Property Tax Exemption", href: "https://detroitmi.gov/government/boards/property-assessment-board-review/homeowners-property-exemption-hope" },
  { label: "PAYS Program Overview", href: "https://www.waynemetro.org/pays/" },
  { label: "Wayne County Treasurer", href: "https://www.waynecounty.com/elected/treasurer/home.aspx" },
  { label: "Legal Aid & Partner Support", href: "https://michiganlegalhelp.org/" },
];

const FALLBACK_REPLY =
  "I can help with Wayne County property-tax notices, relief programs, and payment plans. What would you like to handle first? You can ask for a person at any time.";

const JOURNEY_STEPS = [
  "Understand your situation",
  "Check your options",
  "Get documents ready",
  "Take the next step",
];

const CASE_DRAWER_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function journeyStage(panel: PanelState | null, started: boolean): number {
  if (!panel) return started ? 1 : 0; // step 1 active (or nothing yet)
  const s = panel.status ?? "started";
  if (s === "started" || s === "intake_in_progress") return 2;
  if (s === "documents_needed" || s === "human_review_required") return 3;
  return 4; // packet_ready and beyond
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function prettify(v?: string): string {
  return (v ?? "").replace(/_/g, " ");
}

const DOC_LABELS: Record<string, string> = {
  tax_notice: "a tax notice",
  foreclosure_notice: "a foreclosure notice",
  id: "a photo ID",
  proof_of_income: "proof of income",
  proof_of_occupancy: "proof of occupancy",
  ownership_document: "an ownership document",
  court_notice: "a court notice",
  unknown: "a document we'll review",
};

/** Case copy is written for the agent — strip stage directions for residents. */
function residentFacing(text?: string): string {
  return (text ?? "")
    .replace(/^Ask \(one at a time\):\s*/i, "")
    .replace(/^Invite an upload\s*—\s*/i, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function maskEmailDisplay(value: string): string {
  const [local = "", domain = ""] = value.split("@");
  if (!domain) return value;
  return `${local.slice(0, 2)}•••@${domain}`;
}

function authFromBootstrap(value: SessionBootstrap): {
  state: AuthState;
  email?: string;
  displayEmail?: string;
} {
  const auth = value.authentication ?? value.auth;
  const raw = auth?.state?.toLowerCase();
  if (auth?.verified || raw === "verified" || raw === "authenticated") {
    return {
      state: "verified",
      email: auth?.email,
      displayEmail: auth?.masked_email ?? auth?.email,
    };
  }
  if (raw === "declined") return { state: "declined" };
  if (auth?.isAnonymous || auth?.is_anonymous || raw === "anonymous") {
    return { state: "anonymous" };
  }
  return { state: "guest" };
}

function panelFromBootstrap(value: SessionBootstrap): PanelState | null {
  const kase = value.activeCase ?? value.active_case ?? value.case;
  if (!kase) return null;
  const id = readString(kase.id) ?? readString(kase.caseId) ?? readString(kase.case_id);
  if (!id) return null;
  const intake = kase.intake as { collected?: number; total?: number } | undefined;
  return {
    caseId: id,
    status: readString(kase.status),
    address:
      readString(kase.propertyAddress) ?? readString(kase.property_address),
    nextBestAction:
      readString(kase.nextBestAction) ?? readString(kase.next_best_action),
    intakeCollected:
      typeof kase.intakeCollected === "number"
        ? kase.intakeCollected
        : typeof kase.intake_collected === "number"
          ? kase.intake_collected
          : intake?.collected,
    intakeTotal:
      typeof kase.intakeTotal === "number"
        ? kase.intakeTotal
        : typeof kase.intake_total === "number"
          ? kase.intake_total
          : intake?.total,
    missingDocuments: Array.isArray(kase.missingDocuments)
      ? (kase.missingDocuments as string[])
      : Array.isArray(kase.missing_documents)
        ? (kase.missing_documents as string[])
        : undefined,
    checklistSummary:
      readString(kase.checklistSummary) ?? readString(kase.checklist_summary),
    reviewRequired: Boolean(kase.reviewRequired ?? kase.review_required),
    pathwayLabel: readString(kase.pathwayLabel) ?? readString(kase.pathway_label),
  };
}

function authRequirementFrom(value: unknown): AuthRequirement | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    reason: readString(item.reason),
    message:
      readString(item.message) ??
      readString(item.spoken_explanation) ??
      "To save personal details, Civya needs to protect this conversation. A free account saves your progress, limits who can open your documents, and lets you return later.",
    pendingTurnId:
      readString(item.pendingTurnId) ?? readString(item.pending_turn_id),
    pendingQuestion:
      readString(item.pendingQuestion) ?? readString(item.pending_question),
    sensitiveFields: Array.isArray(item.sensitiveFields)
      ? (item.sensitiveFields as string[])
      : Array.isArray(item.sensitive_fields)
        ? (item.sensitive_fields as string[])
        : undefined,
  };
}

const COMPOSER_MAX_HEIGHT = 128;

function voiceErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "NotAllowedError" || /permission|not allowed/i.test(message)) {
    return "Microphone access is blocked. Allow it in your browser, or use text instead.";
  }
  if (name === "NotFoundError" || /no.*microphone|device.*not found/i.test(message)) {
    return "No microphone was found. Connect one, or use text instead.";
  }
  if (name === "NotReadableError") {
    return "Your microphone is busy in another app. Close it there, then try again.";
  }
  return "Voice could not connect. Try again, or use text instead.";
}

async function postTurnWithRetry(payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("/api/conversations/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        continue;
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }
  if (lastError instanceof DOMException && lastError.name === "AbortError") {
    throw new Error("Saving timed out. Your earlier progress is safe; please try again.");
  }
  throw lastError instanceof Error ? lastError : new Error("Civya could not save that turn.");
}

// ── Page ──────────────────────────────────────────────────────────────

export default function HomePage() {
  const [lang, setLang] = useState<"en" | "es">("en");
  const t = COPY[lang];

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [caseDrawerMode, setCaseDrawerMode] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<CivyaStatus>("idle");
  const [entryStep, setEntryStep] = useState<"voice" | "text">("voice");
  const [connectionSlow, setConnectionSlow] = useState(false);
  const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "degraded">("loading");
  const [fictionalWorkspace, setFictionalWorkspace] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("guest");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [authRequirement, setAuthRequirement] = useState<AuthRequirement | null>(null);
  const [caseSelection, setCaseSelection] = useState<CaseSelectionRequirement | null>(null);
  const [deferredCaseSelection, setDeferredCaseSelection] = useState<CaseSelectionRequirement | null>(null);
  const [selectingCase, setSelectingCase] = useState(false);
  const [authStep, setAuthStep] = useState<"email" | "sending" | "code" | "verifying">("email");
  const [authFlowMode, setAuthFlowMode] = useState<"upgrade" | "recovery">("upgrade");
  const [authCode, setAuthCode] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | undefined>();
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderCapability[]>([
    { provider: "google", label: "Google", available: false, unavailable_reason: "Checking availability…" },
    { provider: "apple", label: "Apple", available: false, unavailable_reason: "Checking availability…" },
    { provider: "linkedin", label: "LinkedIn", available: false, unavailable_reason: "Checking availability…" },
  ]);
  const [oauthBusy, setOauthBusy] = useState<AccountProvider | null>(null);
  const [passkeyCapability, setPasskeyCapability] = useState<PasskeyCapability>({ available: false });
  const [passkeyBusy, setPasskeyBusy] = useState<"signin" | "register" | null>(null);
  const [passkeyNotice, setPasskeyNotice] = useState<string | null>(null);
  const [entitlementState, setEntitlementState] = useState<EntitlementState>("unknown");
  const [entitlementGateOpen, setEntitlementGateOpen] = useState(false);
  const [entitlementMethod, setEntitlementMethod] = useState<"notice_code" | "invitation_code">("notice_code");
  const [entitlementCode, setEntitlementCode] = useState("");
  const [entitlementCapabilities, setEntitlementCapabilities] = useState<EntitlementCapability>({
    notice_code: false,
    invitation_code: false,
    staff_assisted: true,
  });
  const [entitlementError, setEntitlementError] = useState<string | null>(null);
  const [entitlementNotice, setEntitlementNotice] = useState<string | null>(null);
  const [resumeSummary, setResumeSummary] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [generalOnly, setGeneralOnly] = useState(false);
  const [textModeActive, setTextModeActive] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileEpoch, setTurnstileEpoch] = useState(0);

  const idRef = useRef(0);
  const caseRef = useRef<{ caseId: string | null; residentId: string | null }>({
    caseId: null,
    residentId: null,
  });
  const sessionRef = useRef(`web-${Math.random().toString(36).slice(2, 10)}`);
  const conversationRef = useRef<string | null>(null);
  const bootstrapRef = useRef<SessionBootstrap | null>(null);
  const bootstrapEpochRef = useRef(0);
  const entitlementVerifiedRef = useRef(false);
  const identityPromiseRef = useRef<Promise<void> | null>(null);
  const pendingActionRef = useRef<null | "upload" | "paste">(null);
  const pendingTurnIdRef = useRef<string | null>(null);
  const awaitingProtectedAnswerRef = useRef(false);
  const protectedAnswerSubmittedRef = useRef(false);
  const resumeVoiceAfterAuthRef = useRef(false);
  const voiceRef = useRef<CivyaRealtimeClient | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const casePanelRef = useRef<HTMLElement | null>(null);
  const caseToggleRef = useRef<HTMLButtonElement | null>(null);
  const casePanelCloseRef = useRef<HTMLButtonElement | null>(null);
  const caseDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

  const accountGateOpen = Boolean(authRequirement && authState !== "verified");
  const interactionPaused = Boolean(accountGateOpen || caseSelection || entitlementGateOpen);
  const inConversation = messages.length > 0 || Boolean(resumeSummary) || interactionPaused;
  const voiceLive = voiceStatus !== "idle" && voiceStatus !== "error";
  const hasCaseEntitlement = authState === "verified" && entitlementState === "verified";
  const canShowCase = !generalOnly && (authState !== "verified" || hasCaseEntitlement);

  // Short placeholder on small screens so the pill never clips its hint.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 980px)");
    const update = () => {
      setCaseDrawerMode(mq.matches);
      if (!mq.matches) setPanelOpen(false);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!panelOpen || !caseDrawerMode) return;
    const drawer = casePanelRef.current;
    if (!drawer) return;

    caseDrawerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : caseToggleRef.current;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      (casePanelCloseRef.current ?? drawer).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanelOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(CASE_DRAWER_FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      const returnTarget = caseDrawerReturnFocusRef.current;
      caseDrawerReturnFocusRef.current = null;
      window.requestAnimationFrame(() => returnTarget?.focus());
    };
  }, [caseDrawerMode, panelOpen]);

  useEffect(() => {
    if (!canShowCase && panelOpen) setPanelOpen(false);
  }, [canShowCase, panelOpen]);

  const placeholder = inConversation
    ? t.placeholderChat
    : narrow
      ? t.placeholderShort
      : t.placeholder;

  // Auto-grow the composer up to a max height, then scroll internally.
  const autoResize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, []);
  useEffect(() => {
    autoResize();
  }, [input, autoResize]);

  useEffect(() => {
    setConnectionSlow(false);
    if (voiceStatus !== "connecting") return;
    const timer = window.setTimeout(() => setConnectionSlow(true), 9000);
    return () => window.clearTimeout(timer);
  }, [voiceStatus]);

  // Scroll the conversation viewport only — never the page. Respect the
  // reader: if they scrolled up, don't yank them back down.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const pushMsg = useCallback((msg: Omit<Msg, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: ++idRef.current }]);
  }, []);

  /** Streaming-friendly upsert used by the voice transcripts. */
  const upsertMsg = useCallback((who: Msg["who"], text: string, final: boolean) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.who === who && !last.final) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text, final };
        return updated;
      }
      return [...prev, { id: ++idRef.current, who, text, final }];
    });
  }, []);

  const pushActivity = useCallback((label: string, kind: Activity["kind"], detail?: string) => {
    setActivity((prev) =>
      [{ id: ++idRef.current, label, detail, time: nowTime(), kind }, ...prev].slice(0, 6),
    );
  }, []);

  // ── Durable session bootstrap ───────────────────────────────────────

  const hydrateBootstrap = useCallback((value: SessionBootstrap) => {
    setFictionalWorkspace(value.sandbox?.fictional === true);
    const auth = authFromBootstrap(value);
    const canHydrateCase =
      auth.state === "anonymous" ||
      (auth.state === "verified" && entitlementVerifiedRef.current);
    bootstrapRef.current = canHydrateCase
      ? value
      : {
          authentication: value.authentication ?? value.auth,
          persistence: value.persistence,
          capabilities: value.capabilities,
          sandbox: value.sandbox,
          degraded: value.degraded,
        };
    setAuthState(auth.state);
    setGeneralOnly(auth.state === "declined");
    if (auth.email) setAccountEmail(auth.email);
    if (auth.displayEmail) setAccountLabel(auth.displayEmail);

    const nextPanel = canHydrateCase ? panelFromBootstrap(value) : null;
    setPanel(nextPanel);
    caseRef.current = {
      caseId: nextPanel?.caseId ?? null,
      residentId: canHydrateCase ? value.resident?.id ?? null : null,
    };
    conversationRef.current = canHydrateCase ? value.conversation?.id ?? null : null;
    if (canHydrateCase && value.conversation && "pending_turn_id" in value.conversation) {
      pendingTurnIdRef.current = value.conversation.pending_turn_id ?? null;
    }

    const resume = value.resumeContext ?? value.resume_context;
    const rawNextAction = value.nextAction ?? value.next_action;
    const nextQuestion =
      (typeof rawNextAction === "object" ? readString(rawNextAction.question) : undefined) ??
      resume?.next_question;
    const summary =
      readString(value.resumeSummary) ??
      readString(value.resume_summary) ??
      readString(resume?.conversationSummary) ??
      readString(resume?.conversation_summary) ??
      (nextQuestion ? `Ready to continue: ${nextQuestion}` : undefined) ??
      null;
    setResumeSummary(canHydrateCase ? summary : null);

    const conversationWithTurns = value.conversation as
      | ({ recentTurns?: ResumeContext["recentTurns"]; recent_turns?: ResumeContext["recentTurns"] } &
          NonNullable<SessionBootstrap["conversation"]>)
      | null
      | undefined;
    const turns =
      resume?.recentTurns ??
      resume?.recent_turns ??
      conversationWithTurns?.recentTurns ??
      conversationWithTurns?.recent_turns ??
      [];
    if (!canHydrateCase) {
      setMessages([]);
    } else if (turns.length > 0) {
      setMessages((current) => {
        if (current.length > 0) return current;
        return turns.slice(-6).flatMap((turn) => {
          const text =
            turn.redactedText ??
            turn.redacted_text ??
            turn.text ??
            turn.transcript;
          if (!text) return [];
          const who = turn.role === "user" || turn.role === "resident" ? "resident" : "civya";
          return [{ id: ++idRef.current, who, text, final: true } satisfies Msg];
        });
      });
    }

    const persistence = value.persistence?.state;
    if (auth.state !== "guest" && persistence && persistence !== "saved") {
      setSaveState("degraded");
      if (value.persistence?.message) setErrorMsg(value.persistence.message);
    } else if (auth.state !== "guest" && persistence === "saved") {
      setSaveState("saved");
    }
    if (value.capabilities?.voice === false && auth.state !== "guest") {
      setEntryStep("text");
      setTextModeActive(true);
    }
  }, []);

  const loadBootstrap = useCallback(async (quiet = false): Promise<SessionBootstrap | null> => {
    const epoch = ++bootstrapEpochRef.current;
    try {
      const res = await fetch("/api/bootstrap", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as SessionBootstrap;
      if (!res.ok && res.status !== 401) {
        throw new Error(data.error ?? "Civya could not restore your saved progress.");
      }
      if (epoch !== bootstrapEpochRef.current) return bootstrapRef.current;
      hydrateBootstrap(data);
      const degraded = data.degraded || (
        authFromBootstrap(data).state !== "guest" &&
        Boolean(data.persistence?.state && data.persistence.state !== "saved")
      );
      setBootstrapState(degraded ? "degraded" : "ready");
      if (degraded) setSaveState("degraded");
      return data;
    } catch (error) {
      if (epoch !== bootstrapEpochRef.current) return bootstrapRef.current;
      setBootstrapState("degraded");
      setSaveState("degraded");
      if (!quiet) {
        setErrorMsg(
          error instanceof Error
            ? error.message
            : "Civya could not restore your saved progress.",
        );
      }
      return null;
    }
  }, [hydrateBootstrap]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    let cancelled = false;
    const accountResult = new URLSearchParams(window.location.search).get("account");

    const readCapabilities = async () => {
      const [oauthResult, passkeyResult, entitlementResult] = await Promise.allSettled([
        fetch("/api/auth/oauth/start", { cache: "no-store" }).then((response) => response.json()),
        fetch("/api/auth/passkeys/capabilities", { cache: "no-store" }).then((response) => response.json()),
        fetch("/api/entitlements/status", { cache: "no-store" }).then((response) => response.json()),
      ]);
      if (cancelled) return;
      if (oauthResult.status === "fulfilled" && Array.isArray(oauthResult.value?.providers)) {
        setOauthProviders(oauthResult.value.providers as OAuthProviderCapability[]);
      }
      if (passkeyResult.status === "fulfilled") {
        setPasskeyCapability(passkeyResult.value as PasskeyCapability);
      }
      if (entitlementResult.status === "fulfilled") {
        const status = entitlementResult.value as EntitlementStatusResponse;
        if (status.capabilities) setEntitlementCapabilities(status.capabilities);
        if (status.entitlement?.state === "verified") {
          entitlementVerifiedRef.current = true;
          setEntitlementState("verified");
          setEntitlementGateOpen(false);
          await loadBootstrap(true);
        } else if (
          status.entitlement?.state === "selection_required"
          && status.case_selection_required
          && status.attached_case_id
          && status.existing_active_case_id
        ) {
          const task = status.resume?.pending_task;
          const pendingQuestion = task?.question;
          pendingTurnIdRef.current = task?.turnId ?? task?.turn_id ?? null;
          pendingActionRef.current = task?.action === "upload" || task?.action === "paste"
            ? task.action
            : null;
          entitlementVerifiedRef.current = false;
          setAuthState("verified");
          setGeneralOnly(false);
          setEntitlementState("selection");
          setEntitlementGateOpen(false);
          setAuthRequirement(null);
          setCaseSelection({
            attachedCaseId: status.attached_case_id,
            existingActiveCaseId: status.existing_active_case_id,
            existingCaseAvailable: status.existing_case_available !== false,
            pendingQuestion,
          });
        } else if (status.account?.state === "verified") {
          entitlementVerifiedRef.current = false;
          setAuthState("verified");
          setEntitlementState("required");
          setEntitlementGateOpen(true);
        } else {
          entitlementVerifiedRef.current = false;
          setEntitlementState("account_required");
        }
      }
    };

    const restoreAccountFlow = async () => {
      if (accountResult !== "complete") {
        if (accountResult === "unavailable") {
          setAuthError("That account sign-in could not be completed. Try another sign-in option.");
        }
        return;
      }
      try {
        const response = await fetch("/api/auth/link/resume", { cache: "no-store" });
        const result = (await response.json().catch(() => ({}))) as ProtectedResumeResponse;
        if (!response.ok || result.account?.state !== "verified") {
          throw new Error(result.error ?? "That account sign-in could not be restored.");
        }
        if (cancelled) return;
        const task = result.resume?.pending_task;
        pendingTurnIdRef.current = task?.turnId ?? task?.turn_id ?? null;
        pendingActionRef.current = task?.action === "upload" || task?.action === "paste" ? task.action : null;
        setAuthRequirement({
          reason: task?.reason,
          message: "Your Civya account is ready. Wayne County case access is a separate check.",
          pendingTurnId: pendingTurnIdRef.current ?? undefined,
          pendingQuestion: task?.question,
        });
        setAuthState("verified");
        setGeneralOnly(false);
        setEntitlementState("required");
        setEntitlementGateOpen(true);
      } catch (error) {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : "That account sign-in could not be restored.");
        }
      }
    };

    void Promise.all([readCapabilities(), restoreAccountFlow()]).finally(() => {
      if (accountResult && !cancelled) {
        const url = new URL(window.location.href);
        url.searchParams.delete("account");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadBootstrap]);

  /** Create the anonymous identity only after the resident speaks or types. */
  const ensureAnonymousIdentity = useCallback(async (): Promise<void> => {
    if (authState !== "guest") return;
    if (identityPromiseRef.current) return identityPromiseRef.current;
    if (turnstileSiteKey && !turnstileToken) {
      throw new Error("Please complete the quick security check, then try again.");
    }

    const work = (async () => {
      const epoch = ++bootstrapEpochRef.current;
      const res = await fetch("/api/auth/anonymous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionRef.current,
          turnstile_token: turnstileToken ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SessionBootstrap & {
        bootstrap?: SessionBootstrap;
      };
      if (!res.ok) {
        if (turnstileSiteKey) {
          setTurnstileToken(null);
          setTurnstileEpoch((value) => value + 1);
        }
        throw new Error(data.error ?? "Civya could not start a secure session.");
      }
      if (epoch !== bootstrapEpochRef.current) return;
      hydrateBootstrap(data.bootstrap ?? data);
      setBootstrapState("ready");
    })();
    identityPromiseRef.current = work;
    try {
      await work;
    } finally {
      identityPromiseRef.current = null;
    }
  }, [authState, hydrateBootstrap, turnstileSiteKey, turnstileToken]);

  const refreshCase = useCallback(async (_caseId?: string) => {
    await loadBootstrap(true);
  }, [loadBootstrap]);

  const pauseForAccount = useCallback(
    (requirement: Partial<AuthRequirement> = {}, action?: "upload" | "paste") => {
      void ensureAnonymousIdentity().catch((error) => {
        setAuthError(error instanceof Error ? error.message : "Civya could not start a secure session.");
      });
      const normalized: AuthRequirement = {
        reason: requirement.reason,
        message:
          requirement.message ??
          "Before we save personal details, let's protect your progress. A free account limits access to your documents and lets you return later.",
        pendingTurnId: requirement.pendingTurnId,
        pendingQuestion: requirement.pendingQuestion,
        sensitiveFields: requirement.sensitiveFields,
      };
      setAuthRequirement(normalized);
      setAuthStep("email");
      setAuthCode("");
      setAuthError(null);
      pendingTurnIdRef.current = normalized.pendingTurnId ?? pendingTurnIdRef.current;
      pendingActionRef.current = action ?? null;
      resumeVoiceAfterAuthRef.current = Boolean(voiceRef.current && voiceLive);
      const client = voiceRef.current as
        | (CivyaRealtimeClient & { setMicrophoneEnabled?: (enabled: boolean) => void })
        | null;
      client?.setMicrophoneEnabled?.(false);
    },
    [ensureAnonymousIdentity, voiceLive],
  );

  const lockCasePresentation = useCallback(() => {
    entitlementVerifiedRef.current = false;
    setPanel(null);
    setPanelOpen(false);
    setResumeSummary(null);
    setMessages([]);
    caseRef.current = { caseId: null, residentId: null };
    conversationRef.current = null;
  }, []);

  const pendingTaskPayload = useCallback(() => ({
    turn_id: pendingTurnIdRef.current ?? authRequirement?.pendingTurnId,
    question: authRequirement?.pendingQuestion,
    action: pendingActionRef.current ?? (authRequirement ? "resume" : undefined),
    reason: authRequirement?.reason,
  }), [authRequirement]);

  const startOAuthAccount = useCallback(async (provider: AccountProvider) => {
    const capability = oauthProviders.find((item) => item.provider === provider);
    if (!capability?.available || oauthBusy) return;
    setOauthBusy(provider);
    setAuthError(null);
    try {
      await ensureAnonymousIdentity();
      const response = await fetch("/api/auth/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, pending_task: pendingTaskPayload() }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        authorization_url?: string;
        error?: string;
      };
      if (!response.ok || !result.authorization_url) {
        throw new Error(result.error ?? `${capability.label} sign-in could not start.`);
      }
      window.location.assign(result.authorization_url);
    } catch (error) {
      setOauthBusy(null);
      setAuthError(error instanceof Error ? error.message : "Account sign-in could not start.");
    }
  }, [ensureAnonymousIdentity, oauthBusy, oauthProviders, pendingTaskPayload]);

  const usePasskeyAccount = useCallback(async () => {
    if (passkeyBusy || !passkeyCapability.available) return;
    if (!browserSupportsPasskeys()) {
      setAuthError("Passkeys are not supported by this browser or secure connection.");
      return;
    }
    setPasskeyBusy("signin");
    setAuthError(null);
    try {
      await ensureAnonymousIdentity();
      const startResponse = await fetch("/api/auth/passkeys/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pending_task: pendingTaskPayload() }),
      });
      const start = (await startResponse.json().catch(() => ({}))) as {
        challenge_id?: string;
        error?: string;
      };
      if (!startResponse.ok || !start.challenge_id) {
        throw new Error(start.error ?? "Passkey sign-in could not start.");
      }
      await signInWithCivyaPasskey();
      const linkResponse = await fetch("/api/auth/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: start.challenge_id }),
      });
      const result = (await linkResponse.json().catch(() => ({}))) as ProtectedResumeResponse;
      if (!linkResponse.ok || result.account?.state !== "verified") {
        throw new Error(result.error ?? "The passkey signed in, but Civya could not protect this session.");
      }
      const task = result.resume?.pending_task;
      pendingTurnIdRef.current = task?.turnId ?? task?.turn_id ?? pendingTurnIdRef.current;
      pendingActionRef.current = task?.action === "upload" || task?.action === "paste"
        ? task.action
        : pendingActionRef.current;
      lockCasePresentation();
      setAuthState("verified");
      setGeneralOnly(false);
      setEntitlementState("required");
      setEntitlementGateOpen(true);
      setAuthRequirement((current) => current ?? {
        message: "Your Civya account is ready. Wayne County case access is a separate check.",
        pendingTurnId: pendingTurnIdRef.current ?? undefined,
        pendingQuestion: task?.question,
        reason: task?.reason,
      });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey sign-in could not be completed.");
    } finally {
      setPasskeyBusy(null);
    }
  }, [ensureAnonymousIdentity, lockCasePresentation, passkeyBusy, passkeyCapability.available, pendingTaskPayload]);

  const addPasskey = useCallback(async () => {
    if (passkeyBusy || !passkeyCapability.available) return;
    setPasskeyBusy("register");
    setPasskeyNotice(null);
    try {
      await registerCivyaPasskey();
      setPasskeyNotice("Passkey added. You can use it the next time you sign in.");
    } catch (error) {
      setPasskeyNotice(error instanceof Error ? error.message : "The passkey could not be added.");
    } finally {
      setPasskeyBusy(null);
    }
  }, [passkeyBusy, passkeyCapability.available]);

  const resumeProtectedTask = useCallback(async (pendingQuestion?: string) => {
    const pendingAction = pendingActionRef.current;
    pendingActionRef.current = null;
    setAuthRequirement(null);
    awaitingProtectedAnswerRef.current = Boolean(pendingTurnIdRef.current);
    protectedAnswerSubmittedRef.current = false;

    const client = voiceRef.current as
      | (CivyaRealtimeClient & {
          resumeAfterAuth?: (question?: string) => void | Promise<void>;
          setMicrophoneEnabled?: (enabled: boolean) => void;
        })
      | null;
    let voiceResumed = false;
    if (resumeVoiceAfterAuthRef.current && client?.resumeAfterAuth) {
      try {
        await client.resumeAfterAuth(pendingQuestion);
        voiceResumed = true;
      } catch {
        setTextModeActive(true);
        setErrorMsg("Your case is open. Voice could not resume, so please continue by text.");
      }
    } else {
      client?.setMicrophoneEnabled?.(true);
    }
    if (pendingQuestion && !voiceResumed) {
      pushMsg({ who: "civya", text: pendingQuestion, final: true });
    }
    resumeVoiceAfterAuthRef.current = false;
    window.setTimeout(() => {
      if (pendingAction === "upload") fileRef.current?.click();
      if (pendingAction === "paste") setPasteOpen(true);
    }, 0);
  }, [pushMsg]);

  const verifyCaseEntitlement = useCallback(async () => {
    const code = entitlementCode.trim();
    if (!code) {
      setEntitlementError("Enter the code from your notice or invitation.");
      return;
    }
    setEntitlementState("verifying");
    setEntitlementError(null);
    setEntitlementNotice(null);
    try {
      const response = await fetch("/api/entitlements/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: entitlementMethod, code }),
      });
      const result = (await response.json().catch(() => ({}))) as ProtectedResumeResponse;
      const selectionRequired = result.entitlement?.state === "selection_required"
        && result.case_selection_required
        && Boolean(result.attached_case_id)
        && Boolean(result.existing_active_case_id);
      if (!response.ok || (result.entitlement?.state !== "verified" && !selectionRequired)) {
        throw new Error(result.error ?? "Case access could not be verified.");
      }
      setEntitlementCode("");
      const task = result.resume?.pending_task;
      const pendingQuestion = task?.question ?? authRequirement?.pendingQuestion;
      pendingTurnIdRef.current = task?.turnId ?? task?.turn_id ?? pendingTurnIdRef.current;
      pendingActionRef.current = task?.action === "upload" || task?.action === "paste"
        ? task.action
        : pendingActionRef.current;
      const selection =
        selectionRequired && result.attached_case_id && result.existing_active_case_id
          ? {
              attachedCaseId: result.attached_case_id,
              existingActiveCaseId: result.existing_active_case_id,
              existingCaseAvailable: result.existing_case_available !== false,
              pendingQuestion,
            }
          : deferredCaseSelection;
      setDeferredCaseSelection(null);
      if (selection) {
        entitlementVerifiedRef.current = false;
        setEntitlementState("selection");
        setEntitlementGateOpen(false);
        setCaseSelection(selection);
        setAuthRequirement(null);
        return;
      }
      entitlementVerifiedRef.current = true;
      setEntitlementState("verified");
      setEntitlementGateOpen(false);
      await loadBootstrap(true);
      await resumeProtectedTask(pendingQuestion);
    } catch (error) {
      setEntitlementState("required");
      setEntitlementError(
        error instanceof Error
          ? error.message
          : "We could not verify access. Check the code or ask a person for help.",
      );
    }
  }, [authRequirement?.pendingQuestion, deferredCaseSelection, entitlementCode, entitlementMethod, loadBootstrap, resumeProtectedTask]);

  const requestHumanEntitlement = useCallback(async () => {
    setEntitlementError(null);
    setEntitlementNotice(null);
    try {
      const response = await fetch("/api/entitlements/human", { method: "POST" });
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
        disclosure?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Civya could not request human help.");
      setEntitlementState("human");
      setEntitlementNotice(
        [result.message, result.disclosure].filter(Boolean).join(" ") ||
          "A person can help verify access without opening case information here.",
      );
    } catch (error) {
      setEntitlementError(error instanceof Error ? error.message : "Civya could not request human help.");
    }
  }, []);

  useEffect(() => {
    if (entitlementState !== "human") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/entitlements/human", { cache: "no-store" });
        const result = (await response.json().catch(() => ({}))) as {
          entitlement?: { state?: string };
          message?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error ?? "Assisted verification status is unavailable.");
        if (result.entitlement?.state === "verified") {
          entitlementVerifiedRef.current = true;
          setEntitlementState("verified");
          setEntitlementGateOpen(false);
          setEntitlementNotice(result.message ?? "Your time-limited case access is ready.");
          await loadBootstrap(true);
          return;
        }
        if (["staff_assisted_denied", "staff_assisted_expired", "staff_assisted_cancelled"]
          .includes(result.entitlement?.state || "")) {
          setEntitlementState("required");
          setEntitlementError(result.message ?? "Staff could not establish access from this request.");
        } else if (result.message) {
          setEntitlementNotice(result.message);
        }
      } catch (error) {
        if (!cancelled) {
          setEntitlementError(error instanceof Error ? error.message : "Assisted verification status is unavailable.");
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [entitlementState, loadBootstrap]);

  const continueWithGeneralInformation = useCallback(() => {
    lockCasePresentation();
    setGeneralOnly(true);
    setEntitlementGateOpen(false);
    setEntitlementState("required");
    setAuthRequirement(null);
    pendingActionRef.current = null;
    pendingTurnIdRef.current = null;
    resumeVoiceAfterAuthRef.current = false;
    pushMsg({
      who: "civya",
      text: "We can keep discussing general information. I won't open a Wayne County case, collect documents, or take personalized actions.",
      final: true,
    });
  }, [lockCasePresentation, pushMsg]);

  // ── Text conversation (authoritative, durable turn endpoint) ────────

  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending || interactionPaused) return;
      setErrorMsg(null);
      setInput("");

      setSending(true);
      setSaveState("saving");
      try {
        await ensureAnonymousIdentity();

        // Voice session live → the realtime client uses the same authoritative
        // turn endpoint and speaks the approved result.
        if (voiceRef.current && voiceLive) {
          voiceRef.current.sendText(text);
          return;
        }

        pushMsg({ who: "resident", text, final: true });
        const clientTurnId = crypto.randomUUID();
        const res = await postTurnWithRetry({
          conversation_id: conversationRef.current ?? undefined,
          provider_item_id: undefined,
          client_turn_id: clientTurnId,
          transcript: text,
          channel: "text",
          idempotency_key: `${conversationRef.current ?? sessionRef.current}:${clientTurnId}`,
          pending_turn_id: pendingTurnIdRef.current ?? undefined,
        });
        const result = (await res.json().catch(() => ({}))) as TurnResult;
        if (!res.ok) {
          throw new Error(result.error ?? "Civya could not finish that turn.");
        }
        if (result.conversation_id) conversationRef.current = result.conversation_id;

        const requirement = authRequirementFrom(result.authRequired ?? result.auth_required);
        const reply =
          result.spokenResponse ??
          result.spoken_response ??
          result.assistantText ??
          result.assistant_text ??
          (!requirement ? result.nextQuestion ?? result.next_question : undefined);
        if (reply) pushMsg({ who: "civya", text: reply, final: true });
        if (requirement) pauseForAccount(requirement);
        else {
          pendingTurnIdRef.current = null;
          awaitingProtectedAnswerRef.current = false;
          protectedAnswerSubmittedRef.current = false;
        }
        if (!reply && !requirement) {
          pushMsg({
            who: "civya",
            text: FALLBACK_REPLY,
            final: true,
            actions: [
              { label: "Check my options", prompt: "What are my options?" },
              { label: "Talk to a person", prompt: "__human__" },
            ],
          });
        }

        const persistenceState = result.persistence?.state;
        if (result.persisted === false || (persistenceState && persistenceState !== "saved")) {
          setSaveState("degraded");
          setErrorMsg(
            result.persistence?.message ??
              "That reply was not saved. Your earlier progress is safe; please try this turn again.",
          );
        } else {
          setSaveState("saved");
        }
        if (result.caseUpdate ?? result.case_update) {
          pushActivity("Case progress saved", "check");
        }
        await refreshCase();
      } catch (e) {
        setSaveState("degraded");
        setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [
      interactionPaused,
      ensureAnonymousIdentity,
      pauseForAccount,
      pushActivity,
      pushMsg,
      refreshCase,
      sending,
      voiceLive,
    ],
  );

  // ── Talk to a person ────────────────────────────────────────────────

  const talkToPerson = useCallback(async () => {
    await sendText("I'd like to talk to a person.");
  }, [sendText]);

  const handlePrompt = useCallback(
    (prompt: string) => {
      if (prompt === "__human__") void talkToPerson();
      else void sendText(prompt);
    },
    [sendText, talkToPerson],
  );

  // ── Uploads (letters, notices, IDs) ─────────────────────────────────

  const handleUpload = useCallback(
    async (file: File, sourceLabel?: string) => {
      if (!hasCaseEntitlement) {
        if (authState === "verified") {
          pendingActionRef.current = "upload";
          setAuthRequirement((current) => current ?? {
            reason: "document_upload",
            message: "Your account is ready. Verify Wayne County case access before sharing a document.",
          });
          setEntitlementState("required");
          setEntitlementGateOpen(true);
          return;
        }
        pauseForAccount(
          {
            reason: "document_upload",
            message:
              "Before you share a document, let's protect it. Your account limits access to the file, saves your progress, and lets you come back later.",
          },
          "upload",
        );
        return;
      }
      setErrorMsg(null);
      setUploading(true);
      setSaveState("saving");
      try {
        const result = await uploadDocumentDirect(file, caseRef.current.caseId || undefined);
        pushMsg({
          who: "resident",
          text: `📎 Uploaded ${sourceLabel ?? file.name}`,
          final: true,
        });
        pushMsg({
          who: "civya",
          text: result.document_type === "unknown"
            ? "I stored that privately and queued it for review. I won't guess what it is from the filename."
            : `Got it — that looks like ${
                DOC_LABELS[result.document_type as string] ?? prettify(result.document_type)
              }. ${result.checklist_summary ?? ""} ${residentFacing(result.next_best_action)}`.trim(),
          final: true,
        });
        pushActivity(`${file.name} uploaded`, "doc", "Stored privately; review pending");
        setSaveState("saved");
        void refreshCase();
        voiceRef.current?.notifyUpload(result);
      } catch (e) {
        setSaveState("degraded");
        setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [authState, hasCaseEntitlement, pauseForAccount, pushActivity, pushMsg, refreshCase],
  );

  const submitPaste = useCallback(() => {
    const text = pasteText.trim();
    if (!text) return;
    const file = new File([text], "pasted-notice.txt", { type: "text/plain" });
    setPasteOpen(false);
    setPasteText("");
    void handleUpload(file, "a pasted notice");
  }, [handleUpload, pasteText]);

  // ── Voice-led email code upgrade ───────────────────────────────────

  const startEmailUpgrade = useCallback(async () => {
    const email = accountEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError("Enter a valid email address.");
      return;
    }
    setAuthError(null);
    setAuthNotice(null);
    setAuthFlowMode("upgrade");
    setAuthStep("sending");
    try {
      await ensureAnonymousIdentity();
      const res = await fetch("/api/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          pending_turn_id: pendingTurnIdRef.current ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        challenge_id?: string;
        challengeId?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "The code could not be sent.");
      setAccountEmail(email);
      setChallengeId(data.challenge_id ?? data.challengeId);
      setAuthCode("");
      setAuthStep("code");
    } catch (error) {
      setAuthStep("email");
      setAuthError(error instanceof Error ? error.message : "The code could not be sent.");
    }
  }, [accountEmail, ensureAnonymousIdentity]);

  const startAccountRecovery = useCallback(async () => {
    const email = accountEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError("Enter your email address first.");
      return;
    }
    setAuthError(null);
    setAuthNotice(null);
    setAuthStep("sending");
    try {
      await ensureAnonymousIdentity();
      const response = await fetch("/api/auth/recovery/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      const typedResult = result as typeof result & { challenge_id?: string };
      if (!response.ok) throw new Error(result.error ?? "Account recovery could not start.");
      setAccountEmail(email);
      setChallengeId(typedResult.challenge_id);
      setAuthFlowMode("recovery");
      setAuthCode("");
      setAuthNotice(result.message ?? "If a Civya account uses that email, a sign-in code is on its way.");
      setAuthStep("code");
    } catch (error) {
      setAuthStep("email");
      setAuthError(error instanceof Error ? error.message : "Account recovery could not start.");
    }
  }, [accountEmail, ensureAnonymousIdentity]);

  const verifyEmailUpgrade = useCallback(async () => {
    const code = authCode.replace(/\D/g, "");
    if (code.length !== 6) {
      setAuthError("Enter the six-digit code from your email.");
      return;
    }
    setAuthStep("verifying");
    setAuthError(null);
    try {
      ++bootstrapEpochRef.current;
      const res = await fetch(
        authFlowMode === "recovery" ? "/api/auth/recovery/verify" : "/api/auth/email/verify",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: accountEmail.trim().toLowerCase(),
          code,
          challenge_id: challengeId,
          pending_turn_id: pendingTurnIdRef.current ?? undefined,
        }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as SessionBootstrap & {
        bootstrap?: SessionBootstrap;
        case_selection_required?: boolean;
        attached_case_id?: string;
        existing_active_case_id?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That code could not be verified.");

      lockCasePresentation();
      setAuthState("verified");
      setAccountLabel(maskEmailDisplay(accountEmail.trim().toLowerCase()));
      setGeneralOnly(false);
      setSaveState("saved");
      const pendingQuestion = authRequirement?.pendingQuestion;
      if (
        data.case_selection_required &&
        data.attached_case_id &&
        data.existing_active_case_id
      ) {
        setDeferredCaseSelection({
          attachedCaseId: data.attached_case_id,
          existingActiveCaseId: data.existing_active_case_id,
          existingCaseAvailable: true,
          pendingQuestion,
        });
      }
      setAuthStep("email");
      setEntitlementState("required");
      setEntitlementGateOpen(true);
    } catch (error) {
      setAuthStep("code");
      setAuthError(error instanceof Error ? error.message : "That code could not be verified.");
    }
  }, [accountEmail, authCode, authFlowMode, authRequirement?.pendingQuestion, challengeId, lockCasePresentation]);

  const activateSelectedCase = useCallback(async (caseId: string) => {
    if (!caseSelection || selectingCase) return;
    setSelectingCase(true);
    setAuthError(null);
    try {
      const res = await fetch("/api/cases/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: caseId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        bootstrap?: SessionBootstrap;
        error?: string;
      };
      if (!res.ok || !data.bootstrap) {
        throw new Error(data.error ?? "That saved case could not be opened.");
      }
      entitlementVerifiedRef.current = true;
      setEntitlementState("verified");
      setEntitlementGateOpen(false);
      hydrateBootstrap(data.bootstrap);
      const continuingAttached = caseId === caseSelection.attachedCaseId;
      const nextAction = data.bootstrap.next_action ?? data.bootstrap.nextAction;
      const selectedQuestion = continuingAttached
        ? caseSelection.pendingQuestion
        : data.bootstrap.resume_context?.next_question ??
          data.bootstrap.resumeContext?.next_question ??
          (typeof nextAction === "object" ? readString(nextAction.question) : undefined);
      if (!continuingAttached) {
        pendingTurnIdRef.current = null;
        awaitingProtectedAnswerRef.current = false;
        protectedAnswerSubmittedRef.current = false;
      }
      const pendingAction = pendingActionRef.current;
      pendingActionRef.current = null;
      setCaseSelection(null);
      const client = voiceRef.current as
        | (CivyaRealtimeClient & {
            resumeAfterAuth?: (pendingQuestion?: string) => void | Promise<void>;
            setMicrophoneEnabled?: (enabled: boolean) => void;
          })
        | null;
      let voiceResumed = false;
      if (resumeVoiceAfterAuthRef.current && client?.resumeAfterAuth) {
        try {
          await client.resumeAfterAuth(selectedQuestion);
          voiceResumed = true;
        } catch {
          setTextModeActive(true);
          setErrorMsg("The case is open. Voice could not resume, so please continue by text.");
        }
      } else {
        client?.setMicrophoneEnabled?.(true);
      }
      if (selectedQuestion && !voiceResumed) {
        pushMsg({ who: "civya", text: selectedQuestion, final: true });
      }
      resumeVoiceAfterAuthRef.current = false;
      window.setTimeout(() => {
        if (pendingAction === "upload") fileRef.current?.click();
        if (pendingAction === "paste") setPasteOpen(true);
      }, 0);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "That saved case could not be opened.");
    } finally {
      setSelectingCase(false);
    }
  }, [caseSelection, hydrateBootstrap, pushMsg, selectingCase]);

  const declineAccount = useCallback(async () => {
    setAuthError(null);
    try {
      await ensureAnonymousIdentity();
      ++bootstrapEpochRef.current;
      const res = await fetch("/api/auth/decline", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Civya could not save that choice.");
      setAuthState("declined");
      setGeneralOnly(true);
      setAuthRequirement(null);
      pendingActionRef.current = null;
      pendingTurnIdRef.current = null;
      awaitingProtectedAnswerRef.current = false;
      protectedAnswerSubmittedRef.current = false;
      const generalOnlyMessage =
        "That's okay. We can keep discussing general information, but I won't collect personal details, accept documents, or save personalized actions.";
      const client = voiceRef.current as
        | (CivyaRealtimeClient & {
            resumeAfterAuth?: (pendingQuestion?: string) => void | Promise<void>;
            setMicrophoneEnabled?: (enabled: boolean) => void;
          })
        | null;
      if (resumeVoiceAfterAuthRef.current && client?.resumeAfterAuth) {
        try {
          await client.resumeAfterAuth(`${generalOnlyMessage} What general question can I help with?`);
        } catch {
          pushMsg({ who: "civya", text: generalOnlyMessage, final: true });
          setTextModeActive(true);
          setErrorMsg("Your choice was saved. Voice could not resume, so please continue by text.");
        }
      } else {
        pushMsg({ who: "civya", text: generalOnlyMessage, final: true });
        client?.setMicrophoneEnabled?.(true);
      }
      resumeVoiceAfterAuthRef.current = false;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Civya could not save that choice.");
    }
  }, [ensureAnonymousIdentity, pushMsg]);

  // ── Voice (primary mode; microphone access still requires a click) ──

  const persistConversationEnd = useCallback(async (reason: string) => {
    await fetch("/api/conversations/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        conversation_id: conversationRef.current ?? undefined,
        reason,
        idempotency_key: `${conversationRef.current ?? sessionRef.current}:end`,
      }),
    }).catch(() => {});
  }, []);

  const startVoice = useCallback(async () => {
    if (interactionPaused) return;
    setErrorMsg(null);
    setSaveState("idle");
    setTextModeActive(false);
    try {
      await ensureAnonymousIdentity();
      if (bootstrapRef.current?.capabilities?.voice === false) {
        setVoiceStatus("error");
        setEntryStep("text");
        setTextModeActive(true);
        setErrorMsg("Voice is temporarily unavailable. Your progress is safe; continue by text.");
        return;
      }
    } catch (error) {
      setVoiceStatus("error");
      setSaveState("degraded");
      setEntryStep("text");
      setTextModeActive(true);
      setErrorMsg(error instanceof Error ? error.message : voiceErrorMessage(error));
      return;
    }
    const clientEvents = {
      onStatus: (s: CivyaStatus) => setVoiceStatus(s),
      onUserTranscript: (text: string, final: boolean) => {
        upsertMsg("resident", text, final);
        if (final) {
          setSaveState("saving");
          if (awaitingProtectedAnswerRef.current) {
            protectedAnswerSubmittedRef.current = true;
          }
        }
      },
      onAssistantTranscript: (text: string, final: boolean) => {
        upsertMsg("civya", text, final);
        if (final) {
          if (protectedAnswerSubmittedRef.current) {
            pendingTurnIdRef.current = null;
            awaitingProtectedAnswerRef.current = false;
            protectedAnswerSubmittedRef.current = false;
          }
          void loadBootstrap(true);
        }
      },
      onTurnMeta: () => {},
      onNextStep: (card: { title: string; body: string; escalated: boolean }) =>
        pushActivity(card.title, "check", card.body),
      onCaseUpdate: (update: CaseUpdate) => {
        caseRef.current.caseId = update.caseId;
        void refreshCase(update.caseId);
      },
      onAuthRequired: (payload: AuthRequirement) => pauseForAccount(payload),
      onTextFallback: (message: string) => {
        setErrorMsg(message);
        setSaveState("degraded");
        setEntryStep("text");
        setTextModeActive(true);
      },
      onConversationEnded: () => {
        voiceRef.current = null;
        setVoiceStatus("idle");
        void persistConversationEnd("assistant_goodbye");
      },
      onError: (msg: string) => {
        setErrorMsg(msg);
        setSaveState("degraded");
      },
    };
    const client = new CivyaRealtimeClient(clientEvents);
    voiceRef.current = client;
    try {
      await client.connect();
    } catch (e) {
      client.disconnect();
      setVoiceStatus("error");
      setErrorMsg(voiceErrorMessage(e));
      setSaveState("degraded");
      setTextModeActive(true);
      voiceRef.current = null;
    }
  }, [
    interactionPaused,
    ensureAnonymousIdentity,
    pauseForAccount,
    persistConversationEnd,
    pushActivity,
    refreshCase,
    loadBootstrap,
    upsertMsg,
  ]);

  const stopVoice = useCallback(() => {
    void persistConversationEnd("resident_ended");
    voiceRef.current?.disconnect();
    voiceRef.current = null;
    setVoiceStatus("idle");
  }, [persistConversationEnd]);

  const beginProtectedAction = useCallback((action: "upload" | "paste") => {
    if (hasCaseEntitlement) {
      if (action === "upload") fileRef.current?.click();
      else setPasteOpen((value) => !value);
      return;
    }
    if (authState !== "verified") {
      pauseForAccount({ reason: "document_upload" }, action);
      return;
    }
    pendingActionRef.current = action;
    setAuthRequirement((current) => current ?? {
      reason: "document_upload",
      message: "Your Civya account is ready. Wayne County case access is a separate check.",
    });
    setEntitlementState("required");
    setEntitlementGateOpen(true);
  }, [authState, hasCaseEntitlement, pauseForAccount]);

  // ── Quick actions ───────────────────────────────────────────────────

  const quickActions = [
    {
      icon: <IconUpload />,
      label: lang === "es" ? "Subir una carta" : "Upload a letter",
      run: () => beginProtectedAction("upload"),
    },
    {
      icon: <IconClipboard />,
      label: lang === "es" ? "Pegar un aviso" : "Paste a notice",
      run: () => beginProtectedAction("paste"),
    },
    {
      icon: <IconHeadset />,
      label: lang === "es" ? "Hablar con una persona" : "Talk to a person",
      run: () => void talkToPerson(),
    },
  ];

  const stage = journeyStage(panel, inConversation);
  const voiceStatusText: Record<CivyaStatus, string> = {
    idle: "Voice session ended",
    connecting: "Connecting securely…",
    listening: "Listening",
    thinking: "Finding your next step…",
    speaking: "Civya is speaking",
    error: "Voice session ended",
  };

  // ── Shared building blocks ──────────────────────────────────────────

  const composer = (
    <form
      className="cv-ask"
      onSubmit={(e) => {
        e.preventDefault();
        void sendText(input);
      }}
    >
      <textarea
        ref={taRef}
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void sendText(input);
          }
        }}
        placeholder={placeholder}
        aria-label="Ask Civya"
        autoComplete="off"
        disabled={interactionPaused}
      />
      <button
        type="button"
        className="cv-ask-icon cv-ask-mic"
        data-live={voiceLive}
        onClick={() => (voiceLive ? stopVoice() : void startVoice())}
        aria-label={voiceLive ? "End voice conversation" : "Talk to Civya by voice"}
        title={voiceLive ? "End voice conversation" : "Talk to Civya by voice"}
        disabled={interactionPaused}
      >
        <IconMic />
      </button>
      <button
        type="submit"
        className="cv-ask-icon cv-ask-send"
        aria-label="Send"
        disabled={sending || interactionPaused || !input.trim()}
      >
        <IconSend />
      </button>
    </form>
  );

  const hiddenFile = (
    <input
      ref={fileRef}
      type="file"
      accept=".txt,.pdf,.png,.jpg,.jpeg,.webp"
      className="visually-hidden"
      aria-label="Upload a letter or document"
      disabled={uploading}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void handleUpload(f);
      }}
    />
  );

  const pastePanel = pasteOpen && (
    <div className="cv-paste">
      <label htmlFor="paste-notice">Paste the text of your notice or letter</label>
      <textarea
        id="paste-notice"
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        placeholder="Paste the letter text here — Civya will read it and tell you what it means."
      />
      <div className="cv-card-row" style={{ marginTop: 0 }}>
        <button className="cv-btn cv-btn-primary cv-btn-sm" onClick={submitPaste} disabled={!pasteText.trim() || uploading}>
          {uploading ? "Reading…" : "Read my notice"}
        </button>
        <button className="cv-btn cv-btn-ghost cv-btn-sm" onClick={() => setPasteOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const chipsRow = (
    <div className="cv-chips" aria-label="Quick actions">
      {quickActions.map((qa) => (
        <button key={qa.label} className="cv-chip-btn" type="button" onClick={qa.run}>
          {qa.icon} {qa.label}
        </button>
      ))}
    </div>
  );

  const accountCard = authRequirement && authState !== "verified" && (
    <section className="cv-auth-card" aria-labelledby="protect-progress-title">
      <div className="cv-auth-card-heading">
        <span className="cv-auth-lock" aria-hidden="true">✓</span>
        <div>
          <span className="cv-step-label">Step 1 of 2 · Civya account</span>
          <h2 id="protect-progress-title">Choose how you want to sign in.</h2>
        </div>
      </div>
      <p>{authRequirement.message}</p>
      <ul className="cv-auth-benefits">
        <li>Your account saves your place and sign-in choices.</li>
        <li>Signing in does not open or confirm a Wayne County case.</li>
        <li>Case access has its own short verification step.</li>
      </ul>

      <div className="cv-account-providers" aria-label="Recommended sign-in options">
        {oauthProviders
          .filter((item) => item.provider === "google" || item.provider === "apple")
          .map((item) => (
            <button
              key={item.provider}
              type="button"
              className="cv-provider-button"
              disabled={!item.available || oauthBusy !== null}
              title={!item.available ? item.unavailable_reason : undefined}
              onClick={() => void startOAuthAccount(item.provider)}
            >
              {oauthBusy === item.provider ? "Opening…" : `Continue with ${item.label}`}
            </button>
          ))}
      </div>
      {oauthProviders
        .filter((item) => (item.provider === "google" || item.provider === "apple") && !item.available)
        .map((item) => (
          <p className="cv-option-unavailable" key={`${item.provider}-unavailable`}>
            {item.label}: {item.unavailable_reason ?? "not available here"}
          </p>
        ))}
      <div className="cv-auth-divider"><span>or use email</span></div>

      {authStep === "email" || authStep === "sending" ? (
        <form
          className="cv-auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startEmailUpgrade();
          }}
        >
          <label htmlFor="account-email">Email address</label>
          <div className="cv-auth-field-row">
            <input
              id="account-email"
              className="cv-input"
              type="email"
              autoComplete="email"
              value={accountEmail}
              onChange={(event) => setAccountEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
            <button className="cv-btn cv-btn-primary" type="submit" disabled={authStep === "sending"}>
              {authStep === "sending" ? "Sending…" : "Send code"}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="cv-auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verifyEmailUpgrade();
          }}
        >
          <div className="cv-auth-code-heading">
            <label htmlFor="account-code">Six-digit code</label>
            <button
              type="button"
              onClick={() => {
                setAuthStep("email");
                setAuthError(null);
              }}
            >
              Change email
            </button>
          </div>
          <p className="cv-auth-sent">Sent to {accountEmail}</p>
          <div className="cv-auth-field-row">
            <input
              id="account-code"
              className="cv-input cv-code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={authCode}
              onChange={(event) => setAuthCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              aria-describedby="code-help"
              autoFocus
              required
            />
            <button
              className="cv-btn cv-btn-primary"
              type="submit"
              disabled={authStep === "verifying" || authCode.length !== 6}
            >
              {authStep === "verifying" ? "Checking…" : "Continue"}
            </button>
          </div>
          <span id="code-help" className="visually-hidden">Enter the six digits from your email.</span>
        </form>
      )}

      <details className="cv-account-more">
        <summary>More sign-in options</summary>
        <div className="cv-account-more-body">
          {oauthProviders
            .filter((item) => item.provider === "linkedin")
            .map((item) => (
              <div key={item.provider} className="cv-account-option">
                <button
                  type="button"
                  className="cv-provider-button"
                  disabled={!item.available || oauthBusy !== null}
                  onClick={() => void startOAuthAccount(item.provider)}
                >
                  {oauthBusy === item.provider ? "Opening…" : "Continue with LinkedIn"}
                </button>
                {!item.available && (
                  <span>{item.unavailable_reason ?? "LinkedIn sign-in is not available here."}</span>
                )}
              </div>
            ))}
          <div className="cv-account-option">
            <button
              type="button"
              className="cv-provider-button"
              disabled={!passkeyCapability.available || passkeyBusy !== null}
              onClick={() => void usePasskeyAccount()}
            >
              {passkeyBusy === "signin" ? "Checking passkey…" : "Use a passkey"}
            </button>
            <span>
              {passkeyCapability.available
                ? "For a passkey already saved on this device or account."
                : passkeyCapability.unavailable_reason ?? "Passkeys are not available here."}
            </span>
          </div>
          <div className="cv-account-recovery">
            <span>Already have an account but cannot use your usual sign-in?</span>
            <button type="button" onClick={() => void startAccountRecovery()} disabled={authStep === "sending"}>
              Send an account recovery code
            </button>
          </div>
        </div>
      </details>

      {authNotice && <p className="cv-auth-notice" role="status">{authNotice}</p>}
      {passkeyNotice && <p className="cv-auth-notice" role="status">{passkeyNotice}</p>}
      {authError && <p className="cv-auth-error" role="alert">{authError}</p>}
      <div className="cv-auth-card-footer">
        <button type="button" onClick={() => void declineAccount()}>
          Continue with general information only
        </button>
        <span>The microphone is paused while you enter the code.</span>
      </div>
    </section>
  );

  const entitlementCard = entitlementGateOpen && authState === "verified" && (
    <section className="cv-auth-card cv-entitlement-card" aria-labelledby="verify-case-access-title">
      <div className="cv-auth-card-heading">
        <span className="cv-auth-lock" aria-hidden="true">✓</span>
        <div>
          <span className="cv-step-label">Step 2 of 2 · Wayne County case access</span>
          <h2 id="verify-case-access-title">Now verify that you may open the case.</h2>
        </div>
      </div>
      <div className="cv-account-separation" aria-label="Account and case access status">
        <div>
          <span>Civya account</span>
          <strong>{accountLabel || "Signed in"} · ready</strong>
        </div>
        <div>
          <span>Wayne County case</span>
          <strong>Not opened</strong>
        </div>
      </div>
      <p>
        Use a code from an official notice or a private invitation. Civya does not reveal
        whether a matching case exists until access is verified.
      </p>

      <div className="cv-entitlement-methods" role="group" aria-label="Choose a case access code">
        <button
          type="button"
          aria-pressed={entitlementMethod === "notice_code"}
          className={entitlementMethod === "notice_code" ? "active" : ""}
          disabled={!entitlementCapabilities.notice_code}
          onClick={() => {
            setEntitlementMethod("notice_code");
            setEntitlementError(null);
          }}
        >
          Code on my notice
        </button>
        <button
          type="button"
          aria-pressed={entitlementMethod === "invitation_code"}
          className={entitlementMethod === "invitation_code" ? "active" : ""}
          disabled={!entitlementCapabilities.invitation_code}
          onClick={() => {
            setEntitlementMethod("invitation_code");
            setEntitlementError(null);
          }}
        >
          Invitation code
        </button>
      </div>

      <form
        className="cv-auth-form cv-entitlement-form"
        onSubmit={(event) => {
          event.preventDefault();
          void verifyCaseEntitlement();
        }}
      >
        <label htmlFor="entitlement-code">
          {entitlementMethod === "notice_code" ? "Notice code" : "Invitation code"}
        </label>
        <div className="cv-auth-field-row">
          <input
            id="entitlement-code"
            className="cv-input cv-entitlement-code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={entitlementCode}
            onChange={(event) => setEntitlementCode(event.target.value.toUpperCase().slice(0, 40))}
            placeholder="Enter the complete code"
            disabled={!entitlementCapabilities[entitlementMethod] || entitlementState === "verifying"}
          />
          <button
            className="cv-btn cv-btn-primary"
            type="submit"
            disabled={!entitlementCode.trim() || !entitlementCapabilities[entitlementMethod] || entitlementState === "verifying"}
          >
            {entitlementState === "verifying" ? "Checking…" : "Verify case access"}
          </button>
        </div>
      </form>

      {!entitlementCapabilities[entitlementMethod] && (
        <p className="cv-option-unavailable" role="status">
          {entitlementCapabilities.unavailable_reason ??
            "Digital case verification is not connected here. A person can still help."}
        </p>
      )}
      {entitlementNotice && <p className="cv-auth-notice" role="status">{entitlementNotice}</p>}
      {entitlementError && <p className="cv-auth-error" role="alert">{entitlementError}</p>}

      <div className="cv-entitlement-alternatives">
        <button className="cv-btn cv-btn-ghost" type="button" onClick={() => void requestHumanEntitlement()}>
          Ask a person to verify access
        </button>
        <button className="cv-btn cv-btn-ghost" type="button" onClick={continueWithGeneralInformation}>
          Continue with general information only
        </button>
      </div>
      <p className="cv-auth-choice-note">
        No case facts, documents, or status are shown while this check is pending.
      </p>

      {passkeyCapability.available && (
        <details className="cv-account-more cv-passkey-after-signin">
          <summary>Make next sign-in easier</summary>
          <div className="cv-account-more-body">
            <button
              className="cv-provider-button"
              type="button"
              onClick={() => void addPasskey()}
              disabled={passkeyBusy !== null}
            >
              {passkeyBusy === "register" ? "Adding passkey…" : "Add a passkey to my account"}
            </button>
            {passkeyNotice && <span role="status">{passkeyNotice}</span>}
          </div>
        </details>
      )}
    </section>
  );

  const caseSelectionCard = caseSelection && (
    <section className="cv-auth-card" aria-labelledby="choose-case-title">
      <div className="cv-auth-card-heading">
        <span className="cv-auth-lock" aria-hidden="true">✓</span>
        <div>
          <span className="cv-step-label">Case access verified</span>
          <h2 id="choose-case-title">Which saved case should we open?</h2>
        </div>
      </div>
      <p>
        This account already has {fictionalWorkspace ? "saved fictional-preview progress" : "saved case access"}. Civya kept both cases
        separate so nothing was merged or overwritten.
      </p>
      <div className="cv-case-choice-grid">
        <button
          type="button"
          className="cv-btn cv-btn-primary"
          disabled={selectingCase}
          onClick={() => void activateSelectedCase(caseSelection.attachedCaseId)}
        >
          Continue the case I just started
        </button>
        <button
          type="button"
          className="cv-btn cv-btn-ghost"
          disabled={selectingCase || !caseSelection.existingCaseAvailable}
          onClick={() => void activateSelectedCase(caseSelection.existingActiveCaseId)}
        >
          Open my previously saved case
        </button>
      </div>
      {!caseSelection.existingCaseAvailable && (
        <p className="cv-option-unavailable" role="status">
          The previously saved case needs a fresh access check before it can be opened.
        </p>
      )}
      {authError && <p className="cv-auth-error" role="alert">{authError}</p>}
      <p className="cv-auth-choice-note">
        The microphone stays paused until you choose. No case data is combined.
      </p>
    </section>
  );

  const casePanel = (
    <aside
      ref={casePanelRef}
      id="case-panel"
      className={`cv-panel${inConversation ? " cv-app-panel" : ""}${panelOpen ? " open" : ""}`}
      role={caseDrawerMode && panelOpen ? "dialog" : undefined}
      aria-modal={caseDrawerMode && panelOpen ? true : undefined}
      aria-labelledby="case-panel-title"
      tabIndex={caseDrawerMode && panelOpen ? -1 : undefined}
    >
      <div className="cv-panel-row" style={{ marginBottom: "0.2rem" }}>
        <h2 id="case-panel-title" style={{ margin: 0 }}>Your case so far</h2>
        {inConversation && (
          <button
            ref={casePanelCloseRef}
            className="cv-btn cv-btn-ghost cv-btn-sm cv-panel-close"
            type="button"
            aria-label="Close your case panel"
            onClick={() => setPanelOpen(false)}
          >
            Close
          </button>
        )}
      </div>
      <div className="cv-panel-row">
        <span className="cv-panel-label">Status</span>
        <span className={`cv-tag ${panel ? "teal" : ""}`}>
          {panel ? prettify(panel.status) : "not started"}
        </span>
      </div>
      <p className="cv-panel-note">
        {panel
          ? "Keep going — you're on the right path."
          : "Start a conversation and Civya will track your progress here."}
      </p>

      <ol className="cv-journey">
        {JOURNEY_STEPS.map((step, i) => {
          const state = i + 1 < stage ? "done" : i + 1 === stage ? "active" : "todo";
          return (
            <li key={step} data-state={state}>
              <span className="dot" aria-hidden="true">
                {state === "done" && <IconCheck />}
              </span>
              {step}
            </li>
          );
        })}
      </ol>

      {panel?.nextBestAction && (
        <>
          <hr />
          <h3>Recommended next step</h3>
          <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--cv-body)" }}>
            {residentFacing(panel.nextBestAction)}
          </p>
        </>
      )}

      {panel?.missingDocuments && panel.missingDocuments.length > 0 && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: "var(--cv-muted)" }}>
          Still needed: {panel.missingDocuments.map(prettify).join(", ")}
        </p>
      )}

      <hr />
      <h3>Recent activity</h3>
      {activity.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--cv-muted)" }}>
          Nothing yet — your uploads and progress will show up here.
        </p>
      ) : (
        <ul className="cv-activity">
          {activity.map((a) => (
            <li key={a.id}>
              <span className={`cv-tile ${a.kind === "doc" ? "mist" : "seafoam"}`}>
                {a.kind === "doc" ? <IconDoc size={14} /> : a.kind === "check" ? <IconCheck size={12} /> : <IconChat size={14} />}
              </span>
              <span>
                {a.label}
                <time>{a.time}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
      {panel && (
        <p style={{ margin: "0.6rem 0 0" }}>
          <Link
            href={`/case/${panel.caseId}`}
            style={{ fontSize: "0.86rem", fontWeight: 600 }}
          >
            View full case →
          </Link>
        </p>
      )}

      <hr />
      <h3>Helpful resources</h3>
      <ul className="cv-resources">
        {RESOURCES.map((r) => (
          <li key={r.label}>
            <a href={r.href} target="_blank" rel="noreferrer">
              {r.label} <IconExternal />
            </a>
          </li>
        ))}
      </ul>

      <hr />
      <div className="cv-panel-cta">
        {authState === "verified" ? (
          <>
            <p>Progress is protected and saved.</p>
            <span className="cv-account-email">{accountLabel || accountEmail || "Verified account"}</span>
          </>
        ) : (
          <>
            <p>{generalOnly ? "Personalized intake is paused." : "Want to save and come back?"}</p>
            <button
              className="cv-btn cv-btn-ghost cv-btn-sm"
              type="button"
              onClick={() => pauseForAccount({ reason: "save_progress" })}
            >
              Protect my progress
            </button>
          </>
        )}
      </div>
    </aside>
  );

  const header = (
    <SiteHeader
      right={
        <>
          <span className="cv-tag teal cv-demo-tag">
            {fictionalWorkspace ? "Fictional preview" : "Controlled launch"}
          </span>
          <button className="cv-btn cv-btn-ghost cv-btn-sm" onClick={() => setLang(lang === "en" ? "es" : "en")}>
            <IconGlobe /> {t.langBtn}
          </button>
        </>
      }
    />
  );

  // One stable hint line under the composer: status messages swap in place
  // instead of appearing/disappearing, so the layout never moves.
  const composerHint = errorMsg ? (
    <p className="cv-chat-hint cv-hint-error" role="alert">
      {errorMsg}
    </p>
  ) : uploading ? (
    <p className="cv-chat-hint" role="status">
      Uploading and reading your document…
    </p>
  ) : saveState === "saving" ? (
    <p className="cv-chat-hint" role="status">Saving this turn…</p>
  ) : saveState === "saved" ? (
    <p className="cv-chat-hint cv-hint-saved" role="status">
      {authState === "verified" ? "Saved — return later from any device." : "Saved on this browser."}
    </p>
  ) : saveState === "degraded" || bootstrapState === "degraded" ? (
    <p className="cv-chat-hint cv-hint-error" role="status">
      Saving is temporarily unavailable. Earlier saved progress is safe; use text and retry this turn.
    </p>
  ) : (
    <p className="cv-chat-hint">
      Civya can make mistakes. Please double-check important information.
    </p>
  );

  // ── Conversation state: fixed-height agent workspace ────────────────

  if (inConversation) {
    return (
      <div className="cv-page cv-app" lang={lang}>
        <div className="cv-container cv-app-header">
          {header}
          {resumeSummary && (
            <div className="cv-resume-note" role="status">
              <strong>Welcome back.</strong>
              <span>{resumeSummary}</span>
            </div>
          )}
          {generalOnly && (
            <p className="cv-disclaimer" role="status" style={{ margin: "0 0 0.4rem" }}>
              General-information mode — personal intake, uploads, and saved actions are paused.
            </p>
          )}
        </div>

        <main className="cv-container cv-app-body" id="main">
          <div className="cv-app-grid">
            <section className="cv-agent" aria-label="Conversation with Civya">
              <div className="cv-agent-bar cv-minimal-agent-bar">
                <div className="cv-agent-title">
                  <span className="cv-step-label">
                    {interactionPaused
                      ? entitlementGateOpen
                        ? "Microphone paused for case access check"
                        : "Microphone paused for account protection"
                      : voiceLive
                        ? "Microphone on"
                        : saveState === "saved"
                          ? "Progress saved"
                          : "Voice paused"}
                  </span>
                  <h1 className="cv-conversation-title">
                    {interactionPaused
                      ? caseSelection
                        ? "Choose a saved case"
                        : entitlementGateOpen
                          ? "Verify case access"
                          : "Protect your progress"
                      : voiceLive
                        ? voiceStatusText[voiceStatus]
                        : "Your conversation"}
                  </h1>
                </div>
                <div className="cv-agent-tools">
                  {canShowCase && (
                    <button
                      ref={caseToggleRef}
                      className="cv-btn cv-btn-ghost cv-btn-sm cv-case-toggle"
                      type="button"
                      aria-controls="case-panel"
                      aria-expanded={panelOpen}
                      aria-haspopup={caseDrawerMode ? "dialog" : undefined}
                      onClick={() => setPanelOpen(true)}
                    >
                      Your case
                      <span className={`cv-tag ${panel ? "teal" : ""}`}>
                        {panel ? prettify(panel.status) : "not started"}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              <div className="cv-conversation-voice" data-state={voiceStatus}>
                <div className="cv-live-orb" aria-hidden="true">
                  <span /><span /><span /><span /><span />
                </div>
                <p role="status">
                  {interactionPaused
                    ? caseSelection
                      ? "Microphone paused. Choose which saved case to open."
                      : entitlementGateOpen
                        ? "Microphone paused. Verify case access below, or choose a general-information option."
                        : "Microphone paused. Choose a sign-in option below, then we'll continue safely."
                    : voiceLive
                      ? `Microphone on. ${voiceStatusText[voiceStatus]}.`
                      : "Microphone off. Your saved conversation stays here."}
                </p>
                <button
                  type="button"
                  className={`cv-voice-session-button${voiceLive ? " end" : ""}`}
                  onClick={() => (voiceLive ? stopVoice() : void startVoice())}
                  aria-label={voiceLive ? "End voice conversation" : "Start voice conversation"}
                  disabled={interactionPaused}
                >
                  <IconMic /> {interactionPaused ? "Paused" : voiceLive ? "End" : "Talk again"}
                </button>
              </div>

              <div
                className="cv-chat-viewport"
                ref={viewportRef}
                role="log"
                aria-live="off"
                aria-relevant="additions text"
                tabIndex={0}
              >
                <div className="cv-chat">
                  {messages.map((m) => (
                    <div key={m.id} className={`cv-msg ${m.who}`}>
                      {m.who === "civya" && (
                        <span className="cv-msg-avatar" aria-hidden="true">
                          C
                        </span>
                      )}
                      <div className="cv-msg-body">
                        <div className="bubble">{m.text}</div>
                        {m.actions && (
                          <div className="cv-msg-actions">
                            {m.actions.map((a) => (
                              <button key={a.label} className="cv-chip-btn" type="button" onClick={() => handlePrompt(a.prompt)}>
                                {a.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {accountCard}
                  {entitlementCard}
                  {caseSelectionCard}
                  {sending && (
                    <div className="cv-msg civya">
                      <span className="cv-msg-avatar" aria-hidden="true">
                        C
                      </span>
                      <div className="cv-msg-body">
                        <div className="bubble cv-typing" aria-label="Civya is thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <p className="visually-hidden" role="status" aria-live="polite">
                {messages[messages.length - 1]?.final ? messages[messages.length - 1].text : ""}
              </p>

              <div className="cv-composer cv-minimal-composer">
                {pastePanel}
                {textModeActive ? (
                  <div className="cv-text-fallback" role="status">
                    <span>Voice is paused. Continue safely by text.</span>
                    {composer}
                  </div>
                ) : (
                  <details className="cv-text-entry">
                    <summary>Type instead</summary>
                    {composer}
                  </details>
                )}
                <details className="cv-more-actions">
                  <summary>Other options</summary>
                  {chipsRow}
                </details>
                {composerHint}
              </div>
            </section>

            {canShowCase && casePanel}
            {panelOpen && (
              <button
                className="cv-panel-scrim"
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setPanelOpen(false)}
              />
            )}
          </div>
        </main>

        {hiddenFile}
      </div>
    );
  }

  // ── Landing state: one-tap voice door ──────────────────────────────

  const voiceLandingTitle: Record<CivyaStatus, string> = lang === "es"
    ? {
        idle: "Cuénteme qué pasó.",
        connecting: "Un momento…",
        listening: "Adelante.",
        thinking: "Un momento…",
        speaking: "Civya está hablando.",
        error: "No pude conectar.",
      }
    : {
        idle: "Tell me what happened.",
        connecting: "One moment…",
        listening: "Go ahead.",
        thinking: "One moment…",
        speaking: "Civya is talking.",
        error: "I couldn’t connect.",
      };

  const voiceButtonLabel = voiceStatus === "connecting"
    ? (lang === "es" ? "Cancelar" : "Cancel")
    : voiceLive
      ? (lang === "es" ? "Finalizar" : "End")
      : voiceStatus === "error"
        ? (lang === "es" ? "Intentar de nuevo" : "Try again")
        : (lang === "es" ? "Empezar a hablar" : "Start talking");

  return (
    <div className="cv-page cv-guided-page cv-voice-door-page" lang={lang}>
      <div className="cv-container">
        {header}
      </div>

      <main className="cv-guided-main cv-container" id="main">
        <div className="cv-guided-shell">
          {entryStep === "voice" && (
            <section className="cv-mode-card cv-voice-home" aria-labelledby="voice-title">
              <h1 id="voice-title" className="cv-display-title">{voiceLandingTitle[voiceStatus]}</h1>
              {errorMsg && <p className="cv-inline-error" role="alert">{errorMsg}</p>}
              <button
                type="button"
                className="cv-voice-trigger"
                data-state={voiceStatus}
                onClick={() => (voiceLive ? stopVoice() : void startVoice())}
                aria-label={voiceLive ? "End voice conversation" : "Start voice conversation"}
                aria-describedby="voice-mic-note"
              >
                <span className="cv-voice-rings" aria-hidden="true"><span /><span /><span /></span>
                <IconMic />
                <span>{voiceButtonLabel}</span>
              </button>

              <p className="cv-voice-status" id="voice-mic-note" role="status">
                {connectionSlow
                  ? (lang === "es" ? "Aún esperando al navegador. Elija Permitir o use texto." : "Still waiting for your browser. Choose Allow, or use text instead.")
                  : voiceLive
                    ? (lang === "es" ? "Micrófono encendido. Puede finalizar cuando quiera." : "Microphone on. End anytime.")
                    : (lang === "es" ? "Su navegador pedirá usar el micrófono. Puede parar cuando quiera." : "Your browser will ask to use your microphone. Stop anytime.")}
              </p>

              <button type="button" className="cv-type-instead" onClick={() => {
                if (voiceLive) stopVoice();
                setEntryStep("text");
                window.setTimeout(() => taRef.current?.focus(), 0);
              }}>{lang === "es" ? "Escribir en su lugar" : "Type instead"}</button>
              <button
                type="button"
                className="cv-continue-saved"
                onClick={() => pauseForAccount({
                  reason: "resume_account",
                  message: fictionalWorkspace
                    ? "Use your account to continue saved fictional-preview progress from this or another device."
                    : "Use your account to continue saved progress from this or another device.",
                })}
              >
                {lang === "es" ? "Continuar progreso guardado" : "Continue saved progress"}
              </button>
              {authState === "guest" && (
                <TurnstileWidget
                  key={turnstileEpoch}
                  siteKey={turnstileSiteKey}
                  onToken={setTurnstileToken}
                />
              )}
            </section>
          )}

          {entryStep === "text" && (
            <section className="cv-mode-card cv-text-card cv-minimal-text-card" aria-labelledby="text-title">
              <button type="button" className="cv-back-button" onClick={() => setEntryStep("voice")} aria-label="Back to voice">←</button>
              <h1 id="text-title" className="cv-display-title">{lang === "es" ? "Escríbalo." : "Type it."}</h1>
              <p className="cv-mode-lede">{lang === "es" ? "Cuéntele a Civya qué pasó." : "Tell Civya what happened."}</p>
              <div className="cv-guided-composer">{composer}</div>
              {authState === "guest" && (
                <TurnstileWidget
                  key={turnstileEpoch}
                  siteKey={turnstileSiteKey}
                  onToken={setTurnstileToken}
                />
              )}
              {pastePanel}
              {composerHint}
              <div className="cv-text-alternatives">
                <button
                  type="button"
                  onClick={() =>
                    authState === "verified"
                      ? fileRef.current?.click()
                      : pauseForAccount({ reason: "document_upload" }, "upload")
                  }
                ><IconUpload /> Upload a notice</button>
                <button
                  type="button"
                  onClick={() =>
                    authState === "verified"
                      ? setPasteOpen((value) => !value)
                      : pauseForAccount({ reason: "document_upload" }, "paste")
                  }
                ><IconClipboard /> Paste notice text</button>
                <button type="button" onClick={() => void talkToPerson()}><IconHeadset /> Request human help</button>
              </div>
            </section>
          )}
        </div>
      </main>

      <footer className="cv-footer cv-guided-footer" id="about">
        <div className="cv-container">
          <p id="help">
            {fictionalWorkspace
              ? "Civya is automated and is not the Wayne County Treasurer. This fictional preview cannot change an official record or confirm a County outcome."
              : "Civya is automated and is not the Wayne County Treasurer. Civya cannot change an official record or confirm a County outcome; County and approved-provider records remain authoritative."}
          </p>
        </div>
      </footer>

      {hiddenFile}
    </div>
  );
}
