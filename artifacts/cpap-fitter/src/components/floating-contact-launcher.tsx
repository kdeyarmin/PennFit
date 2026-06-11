// Floating support launcher.
//
// A small fixed-position bubble in the bottom-right that opens a
// popover with TWO tabs:
//   * Chat — PennBot, the LLM-backed support assistant. Answers
//     questions about masks, supplies, insurance, the replacement
//     schedule, returns, and how PennPaps works. Conversation is
//     persisted to sessionStorage so a route change or refresh
//     keeps the thread; closing the tab clears it. Replies stream
//     token-by-token via SSE for a live-typing feel. The bot is
//     grounded in the static knowledge base baked into the
//     server-side system prompt; it does NOT have access to any
//     patient record.
//   * Contact — phone, email, and the auth-gated "Message your CSR"
//     deep link to /account#messages. This is the original surface
//     and it stays available so customers who prefer a human always
//     have one click to one.
//
// We default to the Chat tab because it answers most questions
// without a phone call, but switching to Contact is one tap.
//
// Hidden on the admin SPA — admin shell has its own chrome and
// doesn't need a customer-facing support bubble.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";

import { SignedIn } from "@/lib/identity";
import { getCompanyContact, useCompanyContact } from "@/lib/contact";
import { streamChatMessage, type ChatMessage } from "@/lib/chat-api";
import {
  PENNBOT_OPEN_EVENT,
  clearAskFromUrl,
  readAskFromUrl,
  type PennBotOpenDetail,
} from "@/lib/chat-events";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

type Tab = "chat" | "contact";

const STORAGE_KEY = "pennbot.session.v1";
/**
 * Cap the number of turns we persist to sessionStorage so a long
 * session doesn't bloat browser storage on slow devices. The model
 * already only sees the last 11 turns of history (see `send` below);
 * keeping a few more on the client lets the user scroll back to
 * read older context without burning quota.
 */
const PERSIST_TURN_CAP = 30;

const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "Hi, I'm PennBot! Ask me anything CPAP — masks, supplies, insurance, replacement schedules, returns, or just getting started. What's on your mind?",
};

/**
 * Page-aware suggested prompts. The widget picks the bucket whose
 * `match` function returns true for the current Wouter location;
 * `default` is the fallback for everything else (home, etc.).
 */
const SUGGESTION_BUCKETS: Array<{
  match: (loc: string) => boolean;
  prompts: string[];
}> = [
  {
    match: (l) => l === "/masks" || l.startsWith("/masks/"),
    prompts: [
      "Which mask is best for side sleepers?",
      "What's the difference between nasal and pillow masks?",
      "Which masks work for mouth breathers?",
      "Which mask is quietest for a bed partner?",
    ],
  },
  {
    match: (l) => l === "/insurance",
    prompts: [
      "Which insurance plans do you accept?",
      "What does Medicare typically cover?",
      "What if I haven't met my deductible?",
      "How long does insurance verification take?",
    ],
  },
  {
    match: (l) => l === "/shop" || l.startsWith("/shop"),
    prompts: [
      "Do I need a prescription for filters or tubing?",
      "How fast does cash-pay shipping arrive?",
      "What does Subscribe & Save cover?",
      "What's your return policy?",
    ],
  },
  {
    match: (l) =>
      l === "/learn/replacement-schedule" || l.includes("replacement"),
    prompts: [
      "How often do I replace cushions?",
      "Why does my mask leak more lately?",
      "How often should I clean the tubing?",
      "Can I rinse reusable filters instead of replacing?",
    ],
  },
  {
    match: (l) => l === "/faq" || l.startsWith("/faq"),
    prompts: [
      "How do I switch to a different mask style?",
      "Why do I wake up with a dry mouth?",
      "What if I can't exhale against the pressure?",
      "How quickly does an order ship?",
    ],
  },
  {
    match: (l) => l.startsWith("/how-it-works") || l === "/consent",
    prompts: [
      "How does the virtual fitter work?",
      "Do you store my photo?",
      "What if my recommended mask doesn't fit?",
      "Do I need a prescription to order?",
    ],
  },
];

const DEFAULT_PROMPTS = [
  "Which mask is best for side sleepers?",
  "How often do I replace my cushion?",
  "What does insurance typically cover?",
  "What is your return policy?",
];

/**
 * Message shown when the chat endpoint itself is unreachable (404 or
 * HTML SPA fallback — see chat-api.ts:isEndpointUnavailable). Phrased
 * as a clear "we're offline, here are the real ways to reach us"
 * rather than the more transient-sounding "connection issue".
 */
// Computed at call time so the contact details reflect the
// admin-saved company info once it loads.
function unavailableFallbackText(): string {
  const c = getCompanyContact();
  return `PennBot is offline right now. For help, call ${c.phoneDisplay} (${c.hours}) or email ${c.email} — our team will answer anything I would have.`;
}

interface UiMessage extends ChatMessage {
  /** Local-only id for React keying. */
  id: number;
  /** Server set this flag (offline / degraded / rate-limited), or the
      client classified the response (unavailable: endpoint reachable
      but returned 404 / HTML, distinct from "degraded" which is a
      transient upstream failure). */
  meta?: "offline" | "degraded" | "rate-limited" | "unavailable";
  /** True while the assistant bubble is still being streamed. */
  pending?: boolean;
  /** User has voted on this assistant turn — drives the
      thumbs UI and prevents double-counting in telemetry. */
  feedbackKind?: "up" | "down";
}

let nextMessageId = 1;
function makeMessage(
  role: ChatMessage["role"],
  content: string,
  meta?: UiMessage["meta"],
  pending?: boolean,
): UiMessage {
  return { id: nextMessageId++, role, content, meta, pending };
}

function loadStoredMessages(): UiMessage[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UiMessage[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    let max = 0;
    for (const m of parsed) max = Math.max(max, m.id);
    nextMessageId = max + 1;
    return parsed;
  } catch {
    return null;
  }
}

function persistMessages(messages: UiMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    if (messages.length <= 1) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    // Keep the original greeting (id 0) + the most recent
    // PERSIST_TURN_CAP turns. Older turns are dropped so storage
    // doesn't grow unbounded across a long session.
    const greeting = messages.find((m) => m.id === 0);
    const rest = messages.filter((m) => m.id !== 0);
    const trimmed = [
      ...(greeting ? [greeting] : []),
      ...rest.slice(-PERSIST_TURN_CAP),
    ];
    const sanitized = trimmed.map(({ pending: _pending, ...m }) => m);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Quota / private mode — drop silently. Persistence is
    // a UX nice-to-have, not a correctness requirement.
  }
}

export function FloatingContactLauncher() {
  const contact = useCompanyContact();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");

  const [messages, setMessages] = useState<UiMessage[]>(() => {
    const stored = loadStoredMessages();
    return stored ?? [{ ...GREETING, id: 0 }];
  });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inFlightRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const suggestions = useMemo(() => {
    for (const bucket of SUGGESTION_BUCKETS) {
      if (bucket.match(location)) return bucket.prompts;
    }
    return DEFAULT_PROMPTS;
  }, [location]);

  useEffect(() => {
    setOpen(false);
  }, [location]);

  // Auto-scroll only follows new content when the user is anchored
  // to the bottom. If the user has scrolled up to read history, we
  // leave their position alone so streaming chunks don't yank them
  // back to the bottom mid-read. We always snap to the bottom on
  // initial open, regardless of last position.
  const userAnchoredToBottomRef = useRef(true);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // 64 px slop so a near-bottom position still counts as anchored
    // (e.g. between paragraph paint and next chunk).
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userAnchoredToBottomRef.current = distanceFromBottom < 64;
  }
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    if (userAnchoredToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, messages]);
  useEffect(() => {
    if (open) {
      // Reset to anchored on each open so the panel starts at bottom
      // and follows the conversation by default.
      userAnchoredToBottomRef.current = true;
    }
  }, [open]);

  useEffect(() => {
    persistMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (!open || tab !== "chat") return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, tab]);

  useEffect(() => {
    return () => {
      inFlightRef.current?.abort();
    };
  }, []);

  // Anonymous funnel telemetry — fire once each time the panel opens.
  // No PHI, no message content; we only record that PennBot was opened
  // and the route the user was on. This lets the team see whether the
  // chatbot is being used and which pages drive engagement.
  //
  // Gate on the false->true transition of `open`: depending on `location`
  // without this guard re-fired chat_opened on every navigation while the
  // panel stayed open, inflating the funnel count.
  const wasChatOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasChatOpenRef.current) {
      track("chat_opened", { path: location });
    }
    wasChatOpenRef.current = open;
  }, [open, location]);

  // Site-wide keyboard shortcuts:
  //   `?` (Shift + /) opens the chat from anywhere.
  //   `Esc` closes the panel.
  // Both ignore keypresses fired while the user is typing in another
  // input — we don't want to swallow typed `?` or steal Esc from
  // dialogs.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isInput =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "?" && !open && !isInput) {
        e.preventDefault();
        setOpen(true);
        setTab("chat");
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Return focus to the trigger when the dialog closes — without this,
  // closing the panel via Esc / X / route change leaves keyboard
  // focus on `<body>`, which is disorienting for screen-reader and
  // keyboard-only users.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  // Lightweight focus trap. While the dialog is open, Tab and
  // Shift+Tab cycle through focusable descendants. We don't use a
  // full library — the dialog is small and the simple-cycle behavior
  // is the only thing we need.
  useEffect(() => {
    if (!open) return undefined;
    const container = dialogRef.current;
    if (!container) return undefined;

    function handler(e: KeyboardEvent) {
      if (e.key !== "Tab" || !container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("hidden"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }, [open]);

  const stop = useCallback(() => {
    inFlightRef.current?.abort();
  }, []);

  const send = useCallback(
    async (
      text: string,
      opts: { suggested?: boolean; replaceSinceLastUser?: boolean } = {},
    ) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || sending) return;

      // For a retry, drop the failed assistant turn (and the preceding
      // user message we're about to re-send) before appending the new
      // user/placeholder pair, so the conversation history we forward
      // to the model doesn't include the canned fallback text.
      let baseMessages = messages;
      if (opts.replaceSinceLastUser) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === "user") {
            baseMessages = messages.slice(0, i);
            break;
          }
        }
      }

      const userMsg = makeMessage("user", trimmed);
      const placeholder = makeMessage("assistant", "", undefined, true);
      const nextMessages = [...baseMessages, userMsg, placeholder];
      setMessages(nextMessages);
      setInput("");
      setSending(true);

      track("chat_sent", {
        path: location,
        chars: trimmed.length,
        suggested: opts.suggested,
      });
      const startedAt = Date.now();

      inFlightRef.current?.abort();
      const ctrl = new AbortController();
      inFlightRef.current = ctrl;

      const history: ChatMessage[] = nextMessages
        .filter((m) => m.id !== 0 && !m.pending)
        .slice(-11)
        .map(({ role, content }) => ({ role, content }));

      const onChunk = (chunk: string) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholder.id ? { ...m, content: m.content + chunk } : m,
          ),
        );
      };

      try {
        const result = await streamChatMessage(history, onChunk, ctrl.signal);
        const meta = result.rateLimited
          ? "rate-limited"
          : result.unavailable
            ? "unavailable"
            : result.offline
              ? "offline"
              : result.degraded
                ? "degraded"
                : undefined;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== placeholder.id) return m;
            // When the endpoint is unavailable, no chunks arrived — the
            // server-side prerendered offline copy never reached us
            // because the API isn't responding. Substitute a clear
            // "PennBot is offline" message with both phone and email
            // so the patient can act on a real path.
            if (meta === "unavailable" && m.content.length === 0) {
              return {
                ...m,
                pending: false,
                meta,
                content: unavailableFallbackText(),
              };
            }
            return { ...m, pending: false, meta };
          }),
        );
        track("chat_replied", {
          path: location,
          meta,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          // The user clicked Stop. Keep whatever fragments arrived so
          // they can read them, drop the placeholder if no chunks
          // came in, and mark the bubble as no longer pending so the
          // typing indicator hides.
          setMessages((prev) => {
            const placeholderRow = prev.find((m) => m.id === placeholder.id);
            if (!placeholderRow || placeholderRow.content.length === 0) {
              return prev.filter((m) => m.id !== placeholder.id);
            }
            return prev.map((m) =>
              m.id === placeholder.id ? { ...m, pending: false } : m,
            );
          });
          return;
        }
        // Visible to anyone debugging in the browser console; the
        // user-facing canned message intentionally stays opaque so we
        // don't leak server detail.
        console.warn("[pennbot] chat request failed", err);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== placeholder.id) return m;
            // If chunks arrived before the failure, keep the partial
            // reply and just mark it degraded so the user doesn't lose
            // a half-typed answer to a connection blip.
            if (m.content.length > 0) {
              return { ...m, pending: false, meta: "degraded" };
            }
            return {
              ...m,
              pending: false,
              meta: "degraded",
              content: `Something went wrong reaching the chat service. You can try again, or call ${contact.phoneDisplay} (${contact.hours}) or email ${contact.email}.`,
            };
          }),
        );
        track("chat_replied", {
          path: location,
          meta: "degraded",
          durationMs: Date.now() - startedAt,
        });
      } finally {
        setSending(false);
      }
    },
    [
      messages,
      sending,
      location,
      contact.email,
      contact.hours,
      contact.phoneDisplay,
    ],
  );

  const retryLastTurn = useCallback(() => {
    let lastUserText: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUserText = messages[i]!.content;
        break;
      }
    }
    if (lastUserText === null) return;
    void send(lastUserText, { replaceSinceLastUser: true });
  }, [messages, send]);

  /**
   * Record a thumbs-up / thumbs-down vote on an assistant message.
   * Stamps the message in local state so the UI can reflect the
   * choice, and fires a `chat_feedback` telemetry event so the team
   * can spot bad answers. No content leaves the page — only the
   * route + the kind. Voting on the same message again is a no-op.
   */
  const voteOnMessage = useCallback(
    (messageId: number, kind: "up" | "down") => {
      let logged = false;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          if (m.feedbackKind) return m;
          logged = true;
          return { ...m, feedbackKind: kind };
        }),
      );
      if (logged) {
        track("chat_feedback", { path: location, kind });
      }
    },
    [location],
  );

  const resetConversation = useCallback(() => {
    inFlightRef.current?.abort();
    setMessages([{ ...GREETING, id: 0 }]);
    setInput("");
    setSending(false);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore — best-effort cleanup
      }
    }
  }, []);

  // One-shot URL deep-link: if the page was loaded with ?ask=...
  // (or #ask=... in the hash), open PennBot with that as the user's
  // first message and strip the param from the URL so a refresh
  // doesn't re-fire it. Lets marketing emails and shareable links
  // open the chat with a question pre-loaded.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ask = readAskFromUrl();
    if (ask) {
      clearAskFromUrl();
      // Defer one tick so the launcher subscribes to its open event
      // before we dispatch.
      const t = setTimeout(() => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(PENNBOT_OPEN_EVENT, {
              detail: { prefill: ask, autoSend: true },
            }),
          );
        }
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  // Subscribe to the global "open PennBot" event so any in-page CTA
  // (an "Ask PennBot" button on the Insurance page, a help icon next
  // to a FAQ entry, etc.) can pop the launcher with a contextual
  // prefill. Re-bound when `send` changes so the autoSend path uses
  // the latest closure.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function handler(e: Event) {
      const detail =
        (e as CustomEvent<PennBotOpenDetail>).detail ??
        ({} as PennBotOpenDetail);
      setOpen(true);
      setTab(detail.contactTab ? "contact" : "chat");
      if (detail.prefill) {
        if (detail.autoSend) {
          void send(detail.prefill);
        } else {
          setInput(detail.prefill);
          setTimeout(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            // Select the prefill so a long question doesn't read as uneditable placeholder text.
            el.select();
          }, 50);
        }
      }
    }
    window.addEventListener(PENNBOT_OPEN_EVENT, handler);
    return () => window.removeEventListener(PENNBOT_OPEN_EVENT, handler);
  }, [send]);

  if (location.startsWith("/admin")) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const isFreshConversation = messages.length <= 1;

  return (
    <div data-testid="floating-contact" className="print:hidden">
      {open && (
        <>
          {/*
            Scrim behind the popover. Without it, the bottom-right card
            sits on top of the footer's right column ("Legal & Privacy",
            "Staff sign-in") and any chip with a transparent edge can
            visually collide with the link list underneath. The scrim
            dims the page so the dialog clearly owns the foreground and
            doubles as a click-to-dismiss target — standard modal UX.
          */}
          <div
            onClick={() => setOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/50"
            data-testid="floating-contact-scrim"
          />
          <div
            ref={dialogRef}
            className={cn(
              "border border-border bg-background shadow-xl overflow-hidden flex flex-col z-50",
              // Mobile: cover the viewport so older eyes don't have to
              // squint into a 22rem panel on a phone.
              "fixed inset-0",
              // Desktop: original floating card pinned bottom-right.
              "md:inset-auto md:fixed md:bottom-4 md:right-4 md:w-[22rem] md:max-w-[calc(100vw-2rem)] md:rounded-xl md:h-[min(32rem,calc(100vh-8rem))]",
            )}
            role="dialog"
            aria-modal="true"
            aria-label="PennPaps support"
            data-testid="floating-contact-popover"
          >
            <div className="px-4 py-3 bg-[hsl(var(--penn-navy))] text-white flex items-center justify-between shrink-0">
              <div>
                <div className="text-sm font-semibold">PennPaps support</div>
                <div className="text-[11px] opacity-80">{contact.hours}</div>
              </div>
              <div className="flex items-center gap-1">
                {tab === "chat" && !isFreshConversation && (
                  <button
                    type="button"
                    onClick={resetConversation}
                    className="rounded-md hover:bg-white/10 px-2 py-1 text-[11px] uppercase tracking-wide opacity-80 hover:opacity-100"
                    aria-label="Start a new conversation"
                    data-testid="floating-contact-reset"
                  >
                    New chat
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md hover:bg-white/10 p-1"
                  aria-label="Close"
                  data-testid="floating-contact-close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div
              role="tablist"
              aria-label="Support channels"
              className="flex border-b border-border shrink-0"
            >
              <TabButton
                active={tab === "chat"}
                onClick={() => setTab("chat")}
                testId="floating-contact-tab-chat"
              >
                <Sparkles className="h-3.5 w-3.5" /> Ask PennBot
              </TabButton>
              <TabButton
                active={tab === "contact"}
                onClick={() => setTab("contact")}
                testId="floating-contact-tab-contact"
              >
                <Phone className="h-3.5 w-3.5" /> Contact
              </TabButton>
            </div>

            {tab === "chat" ? (
              <div
                role="tabpanel"
                aria-label="Ask PennBot"
                className="flex-1 flex flex-col min-h-0"
              >
                <div
                  ref={scrollRef}
                  onScroll={handleScroll}
                  className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-secondary/20"
                  data-testid="floating-contact-messages"
                  aria-live="polite"
                  aria-busy={sending}
                >
                  {messages.map((m) => (
                    <ChatBubble
                      key={m.id}
                      message={m}
                      onRetry={
                        m.id === messages.at(-1)?.id ? retryLastTurn : undefined
                      }
                      onSwitchToContact={
                        m.id === messages.at(-1)?.id
                          ? () => setTab("contact")
                          : undefined
                      }
                      onVote={voteOnMessage}
                    />
                  ))}
                </div>

                {isFreshConversation && !sending && (
                  <div
                    className="px-3 py-2 border-t border-border/60 flex flex-wrap gap-1.5 shrink-0"
                    data-testid="floating-contact-suggestions"
                  >
                    {suggestions.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => void send(p, { suggested: true })}
                        className="text-[11px] leading-tight px-2 py-1 rounded-full border border-border bg-background hover:border-[hsl(var(--penn-navy))]/60 hover:text-[hsl(var(--penn-navy))] transition-colors"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}

                <form
                  onSubmit={onSubmit}
                  className="border-t border-border p-2 flex items-end gap-2 shrink-0"
                >
                  <label htmlFor="floating-contact-input" className="sr-only">
                    Type a question for PennBot
                  </label>
                  <textarea
                    id="floating-contact-input"
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onInputKeyDown}
                    placeholder="Ask about masks, supplies, insurance…"
                    rows={1}
                    maxLength={1500}
                    disabled={sending}
                    data-testid="floating-contact-input"
                    className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy))]/30 disabled:opacity-60 max-h-24"
                  />
                  {sending ? (
                    <button
                      type="button"
                      onClick={stop}
                      aria-label="Stop generating"
                      data-testid="floating-contact-stop"
                      className="h-9 w-9 rounded-md bg-[hsl(var(--penn-navy))] text-white flex items-center justify-center hover:bg-[hsl(var(--penn-navy-deep))] transition-colors"
                    >
                      <Square className="h-3.5 w-3.5" fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={input.trim().length === 0}
                      aria-label="Send"
                      data-testid="floating-contact-send"
                      className="h-9 w-9 rounded-md bg-[hsl(var(--penn-navy))] text-white flex items-center justify-center hover:bg-[hsl(var(--penn-navy-deep))] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </form>
                <p className="text-[10px] text-muted-foreground px-3 pb-2 leading-tight shrink-0">
                  PennBot is an AI assistant. For clinical or account-specific
                  questions, please call us.
                </p>
              </div>
            ) : (
              <div
                role="tabpanel"
                aria-label="Contact options"
                className="flex-1 overflow-y-auto p-2"
              >
                <a
                  href={`tel:${contact.phoneE164}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
                  data-testid="floating-contact-phone"
                >
                  <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center">
                    <Phone className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      Call us
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {contact.phoneDisplay}
                    </span>
                  </span>
                </a>
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
                  data-testid="floating-contact-email"
                >
                  <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center">
                    <Mail className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      Email
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {contact.email}
                    </span>
                  </span>
                </a>
                <SignedIn>
                  <Link
                    href="/account#messages"
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
                    data-testid="floating-contact-thread"
                  >
                    <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-gold)/0.20)] flex items-center justify-center">
                      <MessageCircle className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        Message your CSR
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Replies show up in your account
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </SignedIn>
              </div>
            )}
          </div>
        </>
      )}

      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-20 right-4 z-50 md:bottom-4",
          "h-14 w-14 rounded-full shadow-lg bg-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-navy-deep))] text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-gold))] focus-visible:ring-offset-2",
          // On mobile, the panel covers the screen and includes its
          // own X button — hide the bubble so it doesn't float over.
          // Keep it visible on desktop so the user can drag focus
          // back to it (and it doubles as the toggle).
          open && "max-md:hidden",
        )}
        aria-label={open ? "Close support menu" : "Open support menu"}
        aria-expanded={open}
        data-testid="floating-contact-toggle"
      >
        {open ? (
          <X className="h-6 w-6" />
        ) : (
          <MessageCircle className="h-6 w-6" />
        )}
      </button>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}

function TabButton({ active, onClick, testId, children }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex-1 inline-flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
        active
          ? "text-[hsl(var(--penn-navy))] border-b-2 border-[hsl(var(--penn-navy))]"
          : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Renders a single line of an assistant reply with markdown-lite:
 *   - `[label](/path)` → <Link href="/path">label</Link>
 *   - `**bold**`        → <strong>
 *   - `*italic*`        → <em> (asterisks must hug non-whitespace, so
 *                         "5 * 3" doesn't accidentally render as italic)
 *   - bare `/path`      → <Link>, via linkifyPaths on plain segments.
 *
 * One pass with a single alternation regex; bold is tried before italic
 * so `**foo**` doesn't get partial-matched by the italic rule.
 */
const INLINE_TOKEN_PATTERN =
  /\[([^\]\n]+?)\]\((\/[a-z][a-z0-9-/]*)\)|(\*\*([^*\n]+?)\*\*)|\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g;

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      out.push(
        ...linkifyPaths(
          text.slice(lastIndex, start),
          `${keyPrefix}-pre-${key++}`,
        ),
      );
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      out.push(
        <Link
          key={`${keyPrefix}-md-${key++}`}
          href={match[2]}
          className="underline underline-offset-2 hover:text-[hsl(var(--penn-navy))]"
        >
          {match[1]}
        </Link>,
      );
    } else if (match[4] !== undefined) {
      out.push(<strong key={`${keyPrefix}-md-${key++}`}>{match[4]}</strong>);
    } else if (match[5] !== undefined) {
      out.push(<em key={`${keyPrefix}-md-${key++}`}>{match[5]}</em>);
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    out.push(
      ...linkifyPaths(text.slice(lastIndex), `${keyPrefix}-tail-${key}`),
    );
  }
  return out;
}

function linkifyPaths(text: string, keyPrefix: string): ReactNode[] {
  const pathPattern =
    /(\s|^)(\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*)(?=$|[\s.,;:!?)])/gi;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(pathPattern)) {
    const matchStart = match.index ?? 0;
    const leading = match[1] ?? "";
    const path = match[2] ?? "";
    const linkStart = matchStart + leading.length;
    if (linkStart > lastIndex) {
      out.push(text.slice(lastIndex, linkStart));
    }
    out.push(
      <Link
        key={`${keyPrefix}-link-${key++}`}
        href={path}
        className="underline underline-offset-2 hover:text-[hsl(var(--penn-navy))]"
      >
        {path}
      </Link>,
    );
    lastIndex = linkStart + path.length;
  }
  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }
  return out;
}

/**
 * Splits an assistant reply into a structured block tree with one
 * lightweight feature beyond inline formatting: lines starting with
 * "- " or "* " are gathered into <ul><li>… items so PennBot's
 * occasional bullet lists scan cleanly. Everything else is rendered
 * as paragraph text.
 */
function renderAssistantBody(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let listBuffer: string[] = [];
  let paragraphBuffer: string[] = [];
  let blockKey = 0;

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    const joined = paragraphBuffer.join("\n");
    out.push(
      <p key={`p-${blockKey++}`} className="whitespace-pre-wrap">
        {renderInlineMarkdown(joined, `p${blockKey}`)}
      </p>,
    );
    paragraphBuffer = [];
  }

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    out.push(
      <ul
        key={`ul-${blockKey++}`}
        className="list-disc list-inside space-y-0.5 my-1"
      >
        {items.map((item, i) => (
          <li key={i}>{renderInlineMarkdown(item, `li${blockKey}-${i}`)}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  }

  for (const rawLine of lines) {
    const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(rawLine);
    if (bulletMatch) {
      flushParagraph();
      listBuffer.push(bulletMatch[1]!);
      continue;
    }
    flushList();
    paragraphBuffer.push(rawLine);
  }
  flushList();
  flushParagraph();
  return out;
}

function ChatBubble({
  message,
  onRetry,
  onSwitchToContact,
  onVote,
}: {
  message: UiMessage;
  onRetry?: () => void;
  onSwitchToContact?: () => void;
  onVote?: (id: number, kind: "up" | "down") => void;
}) {
  const isUser = message.role === "user";
  const showTypingIndicator = message.pending && message.content.length === 0;
  const [copied, setCopied] = useState(false);

  async function copyContent() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard can be blocked by permissions or
      // in non-secure contexts; the user always has Cmd+C as fallback.
    }
  }

  const showRetry =
    !isUser &&
    onRetry &&
    !message.pending &&
    (message.meta === "degraded" ||
      message.meta === "offline" ||
      message.meta === "rate-limited" ||
      message.meta === "unavailable");

  return (
    <div
      className={cn("group flex", isUser ? "justify-end" : "justify-start")}
      data-testid={isUser ? "chat-bubble-user" : "chat-bubble-assistant"}
    >
      <div className="relative max-w-[88%]">
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm leading-relaxed break-words",
            isUser
              ? "bg-[hsl(var(--penn-navy))] text-white rounded-br-sm whitespace-pre-wrap"
              : "bg-background border border-border text-foreground rounded-bl-sm space-y-1",
          )}
        >
          {showTypingIndicator ? (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>PennBot is typing…</span>
            </span>
          ) : isUser ? (
            message.content
          ) : (
            renderAssistantBody(message.content)
          )}
          {message.meta === "offline" && (
            <span className="block mt-1 text-[10px] uppercase tracking-wide opacity-70">
              chat offline
            </span>
          )}
          {message.meta === "unavailable" && (
            <span className="block mt-1 text-[10px] uppercase tracking-wide opacity-70">
              chat unavailable
            </span>
          )}
          {message.meta === "degraded" && (
            <span className="block mt-1 text-[10px] uppercase tracking-wide opacity-70">
              connection issue
            </span>
          )}
          {message.meta === "rate-limited" && (
            <span className="block mt-1 text-[10px] uppercase tracking-wide opacity-70">
              slow down
            </span>
          )}
          {showRetry && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={onRetry}
                data-testid="floating-contact-retry"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[hsl(var(--penn-navy))] hover:underline"
              >
                <RotateCcw className="h-3 w-3" />
                Try again
              </button>
              {onSwitchToContact && (
                <button
                  type="button"
                  onClick={onSwitchToContact}
                  data-testid="floating-contact-switch-contact"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-[hsl(var(--penn-navy))] hover:underline"
                >
                  <Phone className="h-3 w-3" />
                  Talk to a person
                </button>
              )}
            </div>
          )}
        </div>
        {!isUser && !showTypingIndicator && message.content.length > 0 && (
          <div
            className={cn(
              "absolute -bottom-3 right-1 flex items-center gap-1 transition-opacity",
              // Once a vote is recorded we keep the chosen icon
              // visible so the user knows their feedback registered.
              message.feedbackKind
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
            )}
          >
            {onVote && (
              <>
                <button
                  type="button"
                  onClick={() => onVote(message.id, "up")}
                  disabled={!!message.feedbackKind}
                  aria-pressed={message.feedbackKind === "up"}
                  aria-label="Helpful answer"
                  data-testid="floating-contact-thumb-up"
                  className={cn(
                    "h-6 w-6 rounded-md bg-background border border-border flex items-center justify-center transition-colors",
                    message.feedbackKind === "up"
                      ? "text-[hsl(var(--penn-navy))] border-[hsl(var(--penn-navy))]/40"
                      : "text-muted-foreground hover:text-[hsl(var(--penn-navy))] disabled:opacity-40",
                  )}
                >
                  <ThumbsUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onVote(message.id, "down")}
                  disabled={!!message.feedbackKind}
                  aria-pressed={message.feedbackKind === "down"}
                  aria-label="Not helpful"
                  data-testid="floating-contact-thumb-down"
                  className={cn(
                    "h-6 w-6 rounded-md bg-background border border-border flex items-center justify-center transition-colors",
                    message.feedbackKind === "down"
                      ? "text-rose-600 border-rose-300"
                      : "text-muted-foreground hover:text-rose-600 disabled:opacity-40",
                  )}
                >
                  <ThumbsDown className="h-3 w-3" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={copyContent}
              aria-label={copied ? "Copied" : "Copy reply"}
              data-testid="floating-contact-copy"
              className="h-6 w-6 rounded-md bg-background border border-border text-muted-foreground hover:text-[hsl(var(--penn-navy))] flex items-center justify-center"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
