// AccountMessagesSection — in-account thread between the signed-in
// shopper and PennPaps customer service. Lives on /account.
//
// Shape: one thread per customer. The component fetches the thread
// once on mount, optimistically appends the customer's outgoing
// messages, polls every 30s while mounted to surface CSR replies
// without forcing a refresh, and pauses polling when the document
// is hidden (per the Page Visibility API) so a backgrounded tab
// doesn't burn cycles.
//
// We deliberately don't open a websocket / SSE for v1 — most threads
// are slow back-and-forth (CSR responds within hours), polling is
// dramatically simpler operationally, and the scale (one shopper
// per session) makes the load trivial.
//
// UX:
//   * Empty state on first visit — composer with a friendly prompt.
//   * Status pill ("Awaiting reply" / "Customer service replied")
//     so the shopper knows whose court the ball is in.
//   * Inline "Sending…" state on the composer; toast-on-error.
//   * Auto-scrolls to the newest message when new messages arrive.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AccountApiError,
  fetchShopMessages,
  markShopMessagesRead,
  postShopMessage,
  type AccountMessage,
  type AccountThread,
} from "@/lib/account-api";
import { useShopIdentity } from "@/lib/identity";
import { formatAppDateTime, formatAppTime, todayAppDateIso } from "@/lib/utils";

/** How often we re-fetch while the tab is visible. */
const POLL_INTERVAL_MS = 30_000;
/** Hard cap mirroring the server's IN_APP_MESSAGE_BODY_MAX. */
const BODY_MAX = 4000;

export function AccountMessagesSection() {
  const { displayName } = useShopIdentity();
  const { toast } = useToast();
  const [thread, setThread] = useState<AccountThread | null>(null);
  const [messages, setMessages] = useState<AccountMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [unreadFromCsr, setUnreadFromCsr] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Single shared loader so the initial fetch + the polling timer +
  // the post-send refresh all share one code path.
  const reload = useCallback(async () => {
    try {
      const r = await fetchShopMessages();
      setThread(r.thread);
      setMessages(r.messages);
      setUnreadFromCsr(r.unreadFromCsr);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Mark-read effect — runs whenever the loaded thread shows
  // unread CSR replies. Idempotent on the server side, so firing
  // it on every change is safe. We don't await — a slow mark-read
  // shouldn't keep the UI blocking.
  useEffect(() => {
    if (unreadFromCsr === 0) return;
    void markShopMessagesRead()
      .then(() => {
        // Local cleanup so the badge clears immediately; the next
        // poll will re-confirm against the server.
        setUnreadFromCsr(0);
        // Best-effort: tell the global header badge (if mounted) to
        // refetch. Custom event is the cheapest cross-component
        // signal — no shared store needed for this one signal.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("pennpaps:messages:read"));
        }
      })
      .catch(() => {
        // Silent: the badge will still clear on the next poll once
        // the server-side mark-read eventually succeeds, OR the
        // customer's still-unread badge persists honestly.
      });
  }, [unreadFromCsr]);

  // Initial fetch.
  useEffect(() => {
    let active = true;
    void (async () => {
      await reload();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [reload]);

  // Polling. Pause when the document is hidden so a backgrounded
  // tab doesn't poll every 30s forever — the next visibility-change
  // event triggers an immediate refresh so a returning shopper sees
  // fresh CSR replies right away.
  useEffect(() => {
    let intervalId: number | null = null;
    function start() {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void reload();
      }, POLL_INTERVAL_MS);
    }
    function stop() {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    }
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        void reload();
        start();
      }
    }
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);

  // Auto-scroll to the bottom on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSending(true);
    // Optimistic append — gives instant feedback even if the
    // network round-trip is slow. We use a temporary id; the
    // subsequent reload() replaces the optimistic row with the
    // server-issued one.
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        direction: "inbound",
        senderRole: "customer",
        body: trimmed,
        createdAt: new Date().toISOString(),
        deliveryStatus: null,
      },
    ]);
    setDraft("");
    try {
      await postShopMessage(trimmed);
      // Refresh once to pick up the server-issued ids + any new
      // CSR replies that arrived between our last poll and now.
      await reload();
    } catch (err) {
      // Roll the optimistic row back so the customer can edit / retry.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(trimmed);
      toast({
        title: "Couldn't send your message",
        description: formatError(err),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <section className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading your messages…
        </div>
      </section>
    );
  }

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-messages-section"
      aria-label="Messages with PennPaps customer service"
    >
      <header className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Messages with PennPaps</h2>
        {thread && <ThreadStatusPill status={thread.status} />}
      </header>
      <p className="text-sm text-muted-foreground">
        {thread
          ? "Need help with an order, prescription, or insurance? Reply here and our customer-service team will get back to you."
          : "Have a question about your CPAP supplies, an order, or your insurance? Send us a message — usually answered within one business day."}
      </p>

      {loadError && (
        <p
          className="text-xs text-rose-700"
          role="alert"
          data-testid="account-messages-error"
        >
          {loadError}
        </p>
      )}

      {messages.length > 0 && (
        <div
          ref={listRef}
          className="max-h-96 overflow-y-auto rounded-xl border border-border/40 bg-white/60 p-3 space-y-2"
          data-testid="account-messages-list"
        >
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              ownerLabel={displayName ?? "You"}
            />
          ))}
        </div>
      )}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        sending={sending}
        disabled={thread?.status === "closed"}
      />
      {thread?.status === "closed" ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="account-messages-closed-hint"
        >
          This conversation is closed. Sending a new message starts a fresh
          thread.
        </p>
      ) : (
        <p
          className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5"
          data-testid="account-messages-privacy"
        >
          <ShieldCheck className="w-3 h-3" /> Messages are stored privately on
          your account and visible only to PennPaps customer service.
        </p>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  ownerLabel,
}: {
  message: AccountMessage;
  ownerLabel: string;
}) {
  const fromMe = message.direction === "inbound";
  const senderLabel = fromMe
    ? ownerLabel
    : message.senderRole === "system"
      ? "PennPaps"
      : "PennPaps customer service";
  const stamp = new Date(message.createdAt);
  return (
    <div
      className={`flex flex-col gap-1 ${fromMe ? "items-end" : "items-start"}`}
      data-testid={`account-message-${message.id}`}
    >
      <div
        className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words max-w-[85%] ${
          fromMe
            ? "bg-[hsl(var(--penn-navy))] text-white"
            : "bg-secondary/60 text-foreground"
        }`}
      >
        {message.body}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {senderLabel} · {formatTime(stamp)}
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  sending,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
}) {
  const trimmed = value.trim();
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sending && trimmed.length > 0) {
          onSend();
        }
      }}
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={BODY_MAX}
        placeholder={
          disabled
            ? "Send a new message to start a fresh conversation…"
            : "Write a message to PennPaps customer service…"
        }
        className="flex-1 resize-y"
        data-testid="account-message-composer"
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter sends — keeps the textarea Enter-key
          // available for line breaks.
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key === "Enter" &&
            !sending &&
            trimmed.length > 0
          ) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <Button
        type="submit"
        disabled={sending || trimmed.length === 0}
        data-testid="account-message-send"
        className="shrink-0"
      >
        {sending ? (
          <>
            <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            Sending…
          </>
        ) : (
          <>
            <Send className="w-4 h-4 mr-1.5" />
            Send
          </>
        )}
      </Button>
    </form>
  );
}

function ThreadStatusPill({ status }: { status: AccountThread["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}
      data-testid={`account-messages-status-${status}`}
    >
      {meta.label}
    </span>
  );
}

const STATUS_META: Record<
  AccountThread["status"],
  { label: string; className: string }
> = {
  open: {
    label: "Open",
    className: "bg-slate-100 text-slate-700",
  },
  awaiting_admin: {
    label: "Awaiting reply",
    className: "bg-amber-50 text-amber-800 border border-amber-200",
  },
  awaiting_patient: {
    label: "Customer service replied",
    className: "bg-emerald-50 text-emerald-800 border border-emerald-200",
  },
  closed: {
    label: "Closed",
    className: "bg-slate-100 text-slate-500",
  },
};

function formatTime(d: Date): string {
  if (todayAppDateIso(d) === todayAppDateIso()) {
    return formatAppTime(d, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return formatAppDateTime(d, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatError(err: unknown): string {
  if (err instanceof AccountApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
