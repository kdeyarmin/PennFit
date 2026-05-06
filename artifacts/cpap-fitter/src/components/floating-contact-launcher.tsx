// Floating support launcher.
//
// A small fixed-position bubble in the bottom-right that opens a
// popover with TWO tabs:
//   * Chat — PennBot, the LLM-backed support assistant. Answers
//     questions about masks, supplies, insurance, the replacement
//     schedule, returns, and how PennPaps works. Stateless — the
//     conversation lives in component state and is discarded on close.
//     The bot is grounded in the static knowledge base baked into the
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

import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowRight,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { SignedIn } from "@/lib/identity";
import {
  SUPPORT_EMAIL,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
} from "@/lib/contact";
import {
  postChatMessage,
  type ChatMessage,
  type ChatResponse,
} from "@/lib/chat-api";
import { cn } from "@/lib/utils";

type Tab = "chat" | "contact";

/**
 * Suggested prompts shown above the input on first open. Tapping one
 * sends it as the user's message — saves typing for the most-common
 * questions and showcases what the bot knows.
 */
const SUGGESTED_PROMPTS = [
  "Which mask is best for side sleepers?",
  "How often do I replace my cushion?",
  "What does insurance typically cover?",
  "What is your return policy?",
];

const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "Hi! I'm PennBot. Ask me about CPAP masks, supplies, insurance coverage, replacement schedules, returns, or how to order from PennPaps. For account-specific questions, I'll point you to our team.",
};

interface UiMessage extends ChatMessage {
  /** Local-only id for React keying. */
  id: number;
  /** Server set this flag (offline / degraded / rate-limited). */
  meta?: "offline" | "degraded" | "rate-limited";
}

let nextMessageId = 1;
function makeMessage(
  role: ChatMessage["role"],
  content: string,
  meta?: UiMessage["meta"],
): UiMessage {
  return { id: nextMessageId++, role, content, meta };
}

export function FloatingContactLauncher() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");

  const [messages, setMessages] = useState<UiMessage[]>([
    { ...GREETING, id: 0 },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inFlightRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [location]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages]);

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

  if (location.startsWith("/admin")) return null;

  async function send(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;

    const userMsg = makeMessage("user", trimmed);
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    inFlightRef.current?.abort();
    const ctrl = new AbortController();
    inFlightRef.current = ctrl;

    const history: ChatMessage[] = nextMessages
      .filter((m) => m.id !== 0)
      .slice(-11)
      .map(({ role, content }) => ({ role, content }));

    let result: ChatResponse;
    try {
      result = await postChatMessage(history, ctrl.signal);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setSending(false);
        return;
      }
      setMessages((prev) => [
        ...prev,
        makeMessage(
          "assistant",
          "Something went wrong reaching the chat service. You can try again, or call (814) 471-0627 (Mon-Fri 9-5 ET).",
          "degraded",
        ),
      ]);
      setSending(false);
      return;
    }

    const meta = result.rateLimited
      ? "rate-limited"
      : result.offline
        ? "offline"
        : result.degraded
          ? "degraded"
          : undefined;
    setMessages((prev) => [
      ...prev,
      makeMessage("assistant", result.reply, meta),
    ]);
    setSending(false);
  }

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

  return (
    <div
      className="fixed bottom-20 right-4 z-50 md:bottom-4 print:hidden"
      data-testid="floating-contact"
    >
      {open && (
        <div
          className="mb-3 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background shadow-xl overflow-hidden flex flex-col"
          role="dialog"
          aria-label="PennPaps support"
          data-testid="floating-contact-popover"
          style={{ height: "min(32rem, calc(100vh - 8rem))" }}
        >
          <div className="px-4 py-3 bg-[hsl(var(--penn-navy))] text-white flex items-center justify-between shrink-0">
            <div>
              <div className="text-sm font-semibold">PennPaps support</div>
              <div className="text-[11px] opacity-80">{SUPPORT_HOURS}</div>
            </div>
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
                className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-secondary/20"
                data-testid="floating-contact-messages"
              >
                {messages.map((m) => (
                  <ChatBubble key={m.id} message={m} />
                ))}
                {sending && (
                  <div
                    className="flex items-center gap-2 text-xs text-muted-foreground px-1"
                    aria-live="polite"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    PennBot is typing…
                  </div>
                )}
              </div>

              {messages.length <= 1 && !sending && (
                <div
                  className="px-3 py-2 border-t border-border/60 flex flex-wrap gap-1.5 shrink-0"
                  data-testid="floating-contact-suggestions"
                >
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => void send(p)}
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
                <button
                  type="submit"
                  disabled={sending || input.trim().length === 0}
                  aria-label="Send"
                  data-testid="floating-contact-send"
                  className="h-9 w-9 rounded-md bg-[hsl(var(--penn-navy))] text-white flex items-center justify-center hover:bg-[hsl(var(--penn-navy-deep))] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
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
                href={`tel:${SUPPORT_PHONE_E164}`}
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
                    {SUPPORT_PHONE_DISPLAY}
                  </span>
                </span>
              </a>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
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
                    {SUPPORT_EMAIL}
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
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-14 w-14 rounded-full shadow-lg bg-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-navy-deep))] text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-gold))] focus-visible:ring-offset-2"
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

function ChatBubble({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
      data-testid={isUser ? "chat-bubble-user" : "chat-bubble-assistant"}
    >
      <div
        className={cn(
          "rounded-2xl px-3 py-2 text-sm leading-relaxed max-w-[88%] whitespace-pre-wrap break-words",
          isUser
            ? "bg-[hsl(var(--penn-navy))] text-white rounded-br-sm"
            : "bg-background border border-border text-foreground rounded-bl-sm",
        )}
      >
        {message.content}
        {message.meta === "offline" && (
          <span className="block mt-1 text-[10px] uppercase tracking-wide opacity-70">
            chat offline
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
      </div>
    </div>
  );
}
