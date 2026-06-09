// AdminAssistantWidget — "PennPilot", the floating in-app assistant for
// the admin console. Mounted once by AppShell so it's available on every
// /admin page.
//
// Two jobs (matching the product brief):
//   1. Tech support — answers "how does the app work / where is the page
//      that does X" questions, grounded server-side in a complete map of
//      the admin surfaces.
//   2. Program manager — when a real gap surfaces, PennPilot offers to
//      email a structured feature suggestion to the super-admins (the
//      server-side `suggest_feature` tool, which always confirms first).
//
// Distinct from the customer-facing PennBot widgets:
//   * This one is admin-only, runs against /resupply-api/admin/assistant/chat
//     (requireAdmin), and never touches patient PHI.
//
// UX mirrors CustomerChatSection: streamed SSE replies with JSON
// fallback, sessionStorage persistence (clears on tab close — no
// transcript lingering on disk), suggested prompts, and a clear button.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Loader2,
  Lightbulb,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AdminAssistantApiError,
  streamAdminAssistantMessage,
  type AdminAssistantMessage,
} from "@/lib/admin-assistant-api";

const SESSION_STORAGE_KEY = "pennfit_admin_assistant_v1";
/** Max turns persisted locally — well above any realistic single session. */
const PERSIST_TURNS_CAP = 40;
/** Max turns sent to the model in one request (server caps at 14 too). */
const SEND_TURNS_CAP = 13;
/** Hard cap on a single user message. Mirrors the server schema. */
const MAX_USER_MESSAGE_CHARS = 2000;

const SUGGESTED_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: "How do I work a claim end to end?",
    prompt:
      "Walk me through processing an insurance claim from eligibility to payment.",
  },
  {
    label: "Where do I manage feature flags?",
    prompt: "Where do I turn features on or off?",
  },
  {
    label: "How do I send a bulk campaign?",
    prompt: "How do I send an outbound bulk SMS or email campaign?",
  },
  {
    label: "Suggest a feature",
    prompt:
      "I have an idea for something the app should do — can you help me write it up and send it to the team?",
  },
];

interface DisplayMessage extends AdminAssistantMessage {
  id: string;
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
  const stable = messages.filter((m) => !m.streaming).slice(-PERSIST_TURNS_CAP);
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stable));
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

// Matches an in-app admin path the bot mentions: `/admin`, optionally
// followed by `/segment` parts. Stops before trailing punctuation like
// `)`, `.` or `,` so a path in prose / parentheses links cleanly. The
// `:` is allowed so a route param placeholder (e.g. `/admin/patients/:id`)
// still highlights, even though it isn't directly navigable.
const ADMIN_PATH_RE = /\/admin(?:\/[A-Za-z0-9_:-]+)*/g;

export interface MessageSegment {
  type: "text" | "link";
  value: string;
}

/**
 * Split an assistant reply into plain-text and admin-path segments so
 * the UI can render each `/admin/...` path the bot mentions as a
 * one-click link. Pure + exported for unit testing. A path containing a
 * `:` route placeholder is treated as plain text (not a real
 * destination).
 */
export function splitAdminPaths(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  ADMIN_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ADMIN_PATH_RE.exec(text)) !== null) {
    const path = match[0];
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        value: text.slice(lastIndex, match.index),
      });
    }
    // A `:param` placeholder isn't a concrete destination — keep it as text.
    segments.push({ type: path.includes(":") ? "text" : "link", value: path });
    lastIndex = match.index + path.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

// Localized error boundary so a malformed streamed token can't take the
// whole admin console down — the surrounding pages keep working and the
// operator sees a small recovery button.
interface BoundaryState {
  hasError: boolean;
}
class AssistantErrorBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { hasError: false };
  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AdminAssistantWidget] caught a render error:", error, info);
  }
  private handleReset = () => {
    clearPersistedMessages();
    this.setState({ hasError: false });
  };
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-border bg-white p-4 text-sm shadow-lg admin-root"
        data-testid="admin-assistant-error"
      >
        <p className="mb-2 font-semibold">PennPilot hit an error</p>
        <Button size="sm" onClick={this.handleReset}>
          Reset assistant
        </Button>
      </div>
    );
  }
}

export function AdminAssistantWidget(): React.JSX.Element {
  return (
    <AssistantErrorBoundary>
      <AdminAssistantWidgetInner />
    </AssistantErrorBoundary>
  );
}

function AdminAssistantWidgetInner(): React.JSX.Element {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>(() =>
    readPersistedMessages(),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    persistMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

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

      const wireHistory: AdminAssistantMessage[] = [...messages, userMsg]
        .map((m) => ({ role: m.role, content: m.content }))
        .filter((m) => m.content.trim().length > 0)
        .slice(-SEND_TURNS_CAP);

      setDraft("");
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setBusy(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const finalMeta = await streamAdminAssistantMessage(
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, streaming: false } : m,
          ),
        );
        if (finalMeta.unauthorized) {
          toast({
            title: "Please sign in again",
            description: "Your admin session expired.",
            variant: "destructive",
          });
        } else if (finalMeta.offline) {
          toast({
            title: "PennPilot is offline",
            description: "No AI provider is configured for this environment.",
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
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, streaming: false, content: m.content || "(Canceled)" }
                : m,
            ),
          );
        } else {
          const message =
            err instanceof AdminAssistantApiError
              ? err.message
              : "Something went wrong. Please try again.";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    streaming: false,
                    content:
                      "Sorry, I couldn't reach PennPilot. Please try again in a moment.",
                  }
                : m,
            ),
          );
          toast({
            title: "PennPilot request failed",
            description: message,
            variant: "destructive",
          });
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

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    clearPersistedMessages();
  }, []);

  const hasMessages = messages.length > 0;
  const greeting = useMemo(
    () =>
      "Hi, I'm PennPilot. Ask me how anything in the admin console works, or tell me an idea for something it should do and I'll write it up for the team.",
    [],
  );

  if (!open) {
    return (
      <div className="admin-root">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[hsl(var(--penn-navy))] px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
          aria-label="Open PennPilot assistant"
          data-testid="admin-assistant-launcher"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          Ask PennPilot
        </button>
      </div>
    );
  }

  return (
    <div className="admin-root">
      <div
        className="fixed bottom-5 right-5 z-50 flex h-[32rem] max-h-[80vh] w-[24rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-2xl"
        role="dialog"
        aria-label="PennPilot assistant"
        data-testid="admin-assistant-panel"
      >
        <header className="flex items-center justify-between gap-2 border-b border-border/60 bg-[hsl(var(--penn-navy))] px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5" aria-hidden="true" />
            <span className="font-semibold">PennPilot</span>
          </div>
          <div className="flex items-center gap-1">
            {hasMessages && (
              <button
                type="button"
                onClick={handleClear}
                disabled={busy}
                className="rounded-md p-1.5 hover:bg-white/15 disabled:opacity-50"
                aria-label="Clear conversation"
                data-testid="admin-assistant-clear"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 hover:bg-white/15"
              aria-label="Close PennPilot"
              data-testid="admin-assistant-close"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          ref={listRef}
          className="flex-1 space-y-3 overflow-y-auto bg-secondary/30 p-3"
          data-testid="admin-assistant-list"
        >
          {!hasMessages && (
            <div className="space-y-3">
              <div
                className="text-sm italic text-muted-foreground"
                data-testid="admin-assistant-greeting"
              >
                {greeting}
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => void sendMessage(s.prompt)}
                    disabled={busy}
                    className="rounded-full border border-border bg-white px-3 py-1 text-xs hover:bg-secondary/60 disabled:opacity-50"
                    data-testid="admin-assistant-suggestion"
                  >
                    <Lightbulb
                      className="mr-1 inline h-3 w-3"
                      aria-hidden="true"
                    />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 border-t border-border/60 bg-white p-3"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage(draft);
              }
            }}
            placeholder="Ask how something works…"
            rows={2}
            maxLength={MAX_USER_MESSAGE_CHARS}
            disabled={busy}
            data-testid="admin-assistant-input"
            aria-label="Message PennPilot"
            className="flex-1 resize-none"
          />
          <Button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            data-testid="admin-assistant-send"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  onNavigate,
}: {
  message: DisplayMessage;
  /** Called when the user clicks an in-app link (closes the panel). */
  onNavigate: () => void;
}): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid={
        isUser ? "admin-assistant-user-bubble" : "admin-assistant-bot-bubble"
      }
    >
      <div
        className={[
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
          isUser
            ? "bg-[hsl(var(--penn-navy))] text-white"
            : "border border-border/40 bg-white text-foreground",
        ].join(" ")}
      >
        {message.content ? (
          // Bot replies: turn any /admin/... path into a one-click link
          // so the operator lands on the page without hunting the nav.
          // User turns render as plain text (no links).
          isUser ? (
            message.content
          ) : (
            <BotMessageBody content={message.content} onNavigate={onNavigate} />
          )
        ) : message.streaming ? (
          <StreamingDots />
        ) : (
          ""
        )}
        {message.streaming && message.content.length > 0 && (
          <span className="ml-1 inline-block animate-pulse">▍</span>
        )}
      </div>
    </div>
  );
}

function BotMessageBody({
  content,
  onNavigate,
}: {
  content: string;
  onNavigate: () => void;
}): React.JSX.Element {
  const segments = splitAdminPaths(content);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "link" ? (
          <Link
            key={i}
            href={seg.value}
            onClick={onNavigate}
            className="font-medium text-[hsl(var(--penn-navy))] underline underline-offset-2 hover:opacity-80"
            data-testid="admin-assistant-link"
          >
            {seg.value}
          </Link>
        ) : (
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        ),
      )}
    </>
  );
}

function StreamingDots(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1"
      role="status"
      aria-live="polite"
      aria-label="Thinking"
    >
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]"
        aria-hidden="true"
      />
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]"
        aria-hidden="true"
      />
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
        aria-hidden="true"
      />
    </span>
  );
}
