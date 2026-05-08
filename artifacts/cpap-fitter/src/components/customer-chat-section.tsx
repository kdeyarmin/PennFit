// CustomerChatSection — the signed-in account chatbot ("PennBot
// Account Assistant"). Lives on /account. Lets the patient ask
// questions about their own orders, subscriptions, supplies, and
// device, plus the top-100 customer-FAQ topics the knowledge base
// covers (returns, replacement schedule, account housekeeping, etc).
//
// Distinct from the floating PennBot widget (FloatingContactLauncher):
//   * That bot is public, unauthenticated, and lives on every page.
//   * THIS bot is auth-gated, runs against /shop/me/chat, and has
//     access to per-caller account context + DB-backed tools.
//
// UX:
//   * One long-running conversation per session.
//   * Streamed token-by-token replies (SSE) with JSON fallback.
//   * Suggested-prompt chips for the most common questions so a
//     patient who doesn't know what to ask still gets value.
//   * Message persistence in sessionStorage (survives in-app navs;
//     clears when the tab closes — no PHI lingering on disk).
//   * "Clear conversation" button to start fresh.
//   * Composer disabled while a response streams; visible loading
//     indicator while waiting for the first chunk.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  CustomerChatApiError,
  streamCustomerChatMessage,
  type CustomerChatMessage,
} from "@/lib/customer-chat-api";
import { useShopIdentity } from "@/lib/identity";

const SESSION_STORAGE_KEY = "pennpaps_account_chat_v1";
/** Max turns persisted locally — well above any realistic single-session use. */
const PERSIST_TURNS_CAP = 30;
/** Max turns we send to the model in one request (server caps at 12 too). */
const SEND_TURNS_CAP = 11;
/** Hard cap on a single user message. Mirrors the server schema. */
const MAX_USER_MESSAGE_CHARS = 1500;

const SUGGESTED_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Where is my last order?", prompt: "Where is my most recent order?" },
  {
    label: "When is my next subscription shipment?",
    prompt: "When is my next subscription shipment?",
  },
  {
    label: "What CPAP machine do I have on file?",
    prompt: "What CPAP device do you have on file for me?",
  },
  {
    label: "How do I update my shipping address?",
    prompt: "How do I update my shipping address?",
  },
  {
    label: "How often should I replace my mask cushion?",
    prompt: "How often should I replace my mask cushion?",
  },
  {
    label: "How do I cancel a subscription?",
    prompt: "How do I cancel a subscription?",
  },
  {
    label: "Can I return my mask if it doesn't fit?",
    prompt: "Can I return my mask if it doesn't fit?",
  },
  {
    label: "What was in my last order?",
    prompt: "What was in my last order?",
  },
];

interface DisplayMessage extends CustomerChatMessage {
  /** Local id for React keys; not sent to the server. */
  id: string;
  /** Indicates the assistant is still streaming. */
  streaming?: boolean;
}

function readPersistedMessages(): DisplayMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is DisplayMessage =>
          m &&
          typeof m === "object" &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          typeof m.id === "string",
      )
      .map((m) => ({ ...m, streaming: false }));
  } catch {
    return [];
  }
}

function persistMessages(messages: DisplayMessage[]): void {
  if (typeof window === "undefined") return;
  // Persist only finalized (non-streaming) turns so a refresh during
  // a stream doesn't replay a half-rendered assistant message.
  const stable = messages
    .filter((m) => !m.streaming)
    .slice(-PERSIST_TURNS_CAP);
  try {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(stable),
    );
  } catch {
    // sessionStorage full / disabled — ignore; chat still works in-memory.
  }
}

function clearPersistedMessages(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function nextId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function CustomerChatSection(): React.JSX.Element | null {
  const { isSignedIn, isLoaded, displayName } = useShopIdentity();
  const { toast } = useToast();
  const [messages, setMessages] = useState<DisplayMessage[]>(() =>
    readPersistedMessages(),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Persist whenever the conversation changes.
  useEffect(() => {
    persistMessages(messages);
  }, [messages]);

  // Keep the latest message visible.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Cancel any in-flight stream on unmount so an abandoned tab
  // doesn't keep an open SSE connection alive.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const greeting = useMemo(() => {
    const name = displayName?.split(" ")[0] ?? null;
    return name
      ? `Hi ${name}, I'm PennBot. I can answer questions about your orders, subscriptions, device, and supplies. What can I help with?`
      : "Hi, I'm PennBot. I can answer questions about your orders, subscriptions, device, and supplies. What can I help with?";
  }, [displayName]);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (text.length === 0 || busy) return;
      if (text.length > MAX_USER_MESSAGE_CHARS) {
        toast({
          title: "Message too long",
          description: `Please keep messages under ${MAX_USER_MESSAGE_CHARS} characters.`,
          variant: "destructive",
        });
        return;
      }

      const userMsg: DisplayMessage = {
        id: nextId(),
        role: "user",
        content: text,
      };
      const assistantMsg: DisplayMessage = {
        id: nextId(),
        role: "assistant",
        content: "",
        streaming: true,
      };

      // Snapshot the wire-only form (role+content) BEFORE adding the
      // empty assistant placeholder, so the server only sees real turns.
      const wireHistory: CustomerChatMessage[] = [...messages, userMsg]
        .map((m) => ({ role: m.role, content: m.content }))
        .filter((m) => m.content.trim().length > 0)
        .slice(-SEND_TURNS_CAP);

      setDraft("");
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setBusy(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const finalMeta = await streamCustomerChatMessage(
          wireHistory,
          (chunk) => {
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.id === assistantMsg.id) {
                next[next.length - 1] = {
                  ...last,
                  content: last.content + chunk,
                };
              }
              return next;
            });
          },
          ctrl.signal,
        );
        // Finalize the streaming flag on the assistant turn.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, streaming: false } : m,
          ),
        );
        if (finalMeta.unauthorized) {
          toast({
            title: "Please sign in again",
            description:
              "Your session expired. Sign in to keep chatting about your account.",
            variant: "destructive",
          });
        } else if (finalMeta.offline) {
          toast({
            title: "Chat is offline",
            description:
              "Our chat assistant isn't available right now. Try again later or call (814) 471-0627.",
          });
        } else if (finalMeta.degraded) {
          toast({
            title: "Trouble connecting",
            description:
              "I had a hiccup answering. The reply you see is a fallback — please try again.",
          });
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          // User-initiated cancel — nothing to surface.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    streaming: false,
                    content: m.content || "(Canceled)",
                  }
                : m,
            ),
          );
        } else if (err instanceof CustomerChatApiError) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    streaming: false,
                    content:
                      "Sorry, I couldn't reach the chat service. Please try again, or call (814) 471-0627.",
                  }
                : m,
            ),
          );
          toast({
            title: "Chat request failed",
            description: err.message,
            variant: "destructive",
          });
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    streaming: false,
                    content:
                      "Sorry, something went wrong. Please try again, or call (814) 471-0627.",
                  }
                : m,
            ),
          );
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, messages, toast],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void sendMessage(draft);
    },
    [draft, sendMessage],
  );

  const handleSuggestion = useCallback(
    (prompt: string) => {
      void sendMessage(prompt);
    },
    [sendMessage],
  );

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    clearPersistedMessages();
  }, []);

  // Hide the section entirely until we know whether the user is
  // signed in (avoids a flash of "please sign in" while auth probes).
  if (!isLoaded) {
    return (
      <section className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading account assistant…
        </div>
      </section>
    );
  }

  // Belt-and-suspenders: the account page already gates behind
  // <SignedIn>, but render a graceful empty state if a future caller
  // mounts us elsewhere.
  if (!isSignedIn) return null;

  const hasMessages = messages.length > 0;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="customer-chat-section"
      aria-label="Account chat assistant"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Ask PennBot about your account</h2>
        </div>
        {hasMessages && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={busy}
            data-testid="customer-chat-clear"
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </header>
      <p className="text-sm text-muted-foreground flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Quick answers about your orders, subscriptions, device, and supplies.
          For prescriptions, refunds, or anything PennBot can&apos;t handle,
          send a message above or call (814) 471-0627.
        </span>
      </p>

      <div
        ref={listRef}
        className="max-h-96 overflow-y-auto rounded-xl border border-border/40 bg-white/60 p-3 space-y-3"
        data-testid="customer-chat-list"
      >
        {!hasMessages && (
          <div
            className="text-sm text-muted-foreground italic"
            data-testid="customer-chat-greeting"
          >
            {greeting}
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="customer-chat-suggestions">
        {SUGGESTED_PROMPTS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => handleSuggestion(s.prompt)}
            disabled={busy}
            className="text-xs rounded-full border border-border/60 bg-white/70 px-3 py-1 hover:bg-[hsl(var(--penn-navy))]/5 disabled:opacity-50 transition-colors"
            data-testid="customer-chat-suggestion"
          >
            <MessageCircleQuestion className="h-3 w-3 inline mr-1" />
            {s.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendMessage(draft);
            }
          }}
          placeholder="Type your question and press Enter..."
          rows={2}
          maxLength={MAX_USER_MESSAGE_CHARS}
          disabled={busy}
          data-testid="customer-chat-input"
          aria-label="Message PennBot"
          className="flex-1 resize-none"
        />
        <Button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          data-testid="customer-chat-send"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </section>
  );
}

interface ChatBubbleProps {
  message: DisplayMessage;
}

function ChatBubble({ message }: ChatBubbleProps): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid={isUser ? "customer-chat-user-bubble" : "customer-chat-bot-bubble"}
    >
      <div
        className={[
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          isUser
            ? "bg-[hsl(var(--penn-navy))] text-white"
            : "bg-white border border-border/40 text-foreground",
        ].join(" ")}
      >
        {message.content || (message.streaming ? <StreamingDots /> : "")}
        {message.streaming && message.content.length > 0 && (
          <span className="inline-block ml-1 animate-pulse">▍</span>
        )}
      </div>
    </div>
  );
}

function StreamingDots(): React.JSX.Element {
  // role="status" + aria-live="polite" announces the assistant's
  // "Thinking" state once when the dots mount, so screen-reader
  // users hear that a response is being generated rather than
  // sitting in silence after sending a message.
  return (
    <span
      className="inline-flex items-center gap-1"
      role="status"
      aria-live="polite"
      aria-label="Thinking"
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]"
        aria-hidden="true"
      />
      <span
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]"
        aria-hidden="true"
      />
      <span
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce"
        aria-hidden="true"
      />
    </span>
  );
}
