import { useState } from "react";
import { Link } from "wouter";
import {
  ApiError,
  useGetConversation,
  useSendSmsReminder,
  useSendEmailReminder,
  usePlaceVoiceCall,
  useReplyInConversation,
} from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  humanizeStatus,
} from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Button } from "../components/Button";
import { fullName, formatDateTime } from "../lib/format";
import { applyTemplate, templatesForChannel } from "../lib/reply-templates";
import { applyMacro, applyLegacyFirstName } from "../lib/macro-merge";
import { listMacros, type CsrMacro } from "../lib/csr-macros-api";
import { useQuery } from "@tanstack/react-query";
import { Patient360Panel } from "../components/Patient360Panel";
import { useDraftAutosave } from "../lib/use-draft-autosave";

// Conversation viewer. Renders the chronological message timeline as
// channel-aware bubbles (admin/agent on the right, patient on the
// left). The action bar at the bottom wires the existing
// send-reminder + place-call mutations so an admin can act from
// inside the thread.
//
// Mutations target the existing /sms/send-reminder, /email/send-reminder,
// and /voice/place-call endpoints with this conversation's
// patient/episode IDs. Success surfaces a small inline confirmation
// + invalidates the conversation query so the new outbound message
// shows up at the bottom on the next render.

export function ConversationDetailPage({ id }: { id: string }) {
  const { data, isPending, isError, error, refetch } = useGetConversation(id);

  if (isError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load conversation"
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <Card>
          <Spinner label="Loading conversation…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <BackLink />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6 min-w-0">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider mb-1" style={{ color: "#c9a24a" }}>
              Conversation
            </p>
            <h1 className="text-2xl font-semibold mb-1" style={{ color: "#0a1f44" }}>
              <Link
                href={`/patients/${data.patientId}`}
                className="underline decoration-dotted"
                style={{ color: "#0a1f44" }}
              >
                {fullName(data.patientFirstName, data.patientLastName)}
              </Link>
            </h1>
            <p className="text-xs" style={{ color: "#6b7280" }}>
              Started {formatDateTime(data.createdAt)} · Last message{" "}
              {formatDateTime(data.lastMessageAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={channelVariant(data.channel)}>
              {humanizeStatus(data.channel)}
            </Badge>
            <Badge variant={conversationStatusVariant(data.status)}>
              {humanizeStatus(data.status)}
            </Badge>
          </div>
        </div>
      </Card>

      <Card>
        {data.messages.length === 0 ? (
          <EmptyState
            title="No messages yet."
            hint="Use the action bar below to send the first reminder."
          />
        ) : (
          <ol className="flex flex-col gap-3">
            {data.messages.map((m) => {
              const isOutbound = m.direction === "outbound";
              return (
                <li
                  key={m.id}
                  className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
                >
                  <div className="max-w-[70%]">
                    <div
                      className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words border"
                      style={
                        isOutbound
                          ? {
                              backgroundColor: "#0a1f44",
                              color: "#ffffff",
                              borderColor: "#0a1f44",
                            }
                          : {
                              backgroundColor: "#ffffff",
                              color: "#0a1f44",
                              borderColor: "#e5e7eb",
                            }
                      }
                    >
                      {m.body}
                    </div>
                    <p
                      className="text-[10px] mt-1 px-1"
                      style={{ color: "#6b7280", textAlign: isOutbound ? "right" : "left" }}
                    >
                      {humanizeStatus(m.senderRole)} ·{" "}
                      {formatDateTime(m.sentAt ?? m.createdAt)}
                      {m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <ReplyComposer
        conversationId={data.id}
        channel={data.channel}
        status={data.status}
        patientFirstName={data.patientFirstName}
        onAfterSend={() => void refetch()}
      />

      <ActionBar
        patientId={data.patientId}
        episodeId={data.episodeId}
        onAfterAction={() => void refetch()}
      />
        </div>
        <aside className="space-y-4">
          <Patient360Panel patientId={data.patientId} />
        </aside>
      </div>
    </div>
  );
}

// In-thread reply composer. Posts to /conversations/{id}/reply, which
// reuses the patient's existing channel + thread (Twilio sender or
// SendGrid threading). Hidden / disabled when the conversation is
// closed (the API would 409 anyway) or when the channel is voice
// (text replies on a voice call don't make sense; admins should use
// "Place voice call" in the action bar below to call back).
function ReplyComposer({
  conversationId,
  channel,
  status,
  patientFirstName,
  onAfterSend,
}: {
  conversationId: string;
  channel: string;
  status: string;
  patientFirstName: string;
  onAfterSend: () => void;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const reply = useReplyInConversation();

  // Drafts persist across navigation/refresh per-conversation.
  // Hydrating from localStorage means a patient call mid-typing
  // (admin tabs to dial pad) doesn't lose context.
  const draft = useDraftAutosave(
    `reply-draft:${conversationId}`,
    body,
    (restored) => setBody(restored),
  );

  // DB-backed macros (preferred). Falls back to the hardcoded
  // templatesForChannel() list if the API call fails (preview mode,
  // network blip, or the table is empty in a fresh DB) so the
  // composer never loses its picker entirely.
  const macrosQuery = useQuery({
    queryKey: ["admin-csr-macros-picker"],
    queryFn: () => listMacros({ includeInactive: false }),
    staleTime: 60_000,
  });
  const dbMacros = macrosQuery.data?.macros ?? [];
  const filteredMacros: CsrMacro[] =
    channel === "sms" || channel === "email"
      ? dbMacros.filter((m) =>
          m.channels.includes(channel as "sms" | "email"),
        )
      : [];
  // Hardcoded fallback only when the DB list is empty AND the query
  // resolved (success with no rows OR error). While loading, show
  // nothing rather than flash legacy templates over the eventual list.
  const fallbackTemplates =
    !macrosQuery.isPending && filteredMacros.length === 0
      ? templatesForChannel(channel)
      : [];

  const isClosed = status === "closed";
  const isVoice = channel === "voice";
  const trimmed = body.trim();
  const tooLong = trimmed.length > 1600;
  const canSend = !isClosed && !isVoice && trimmed.length > 0 && !tooLong;

  if (isVoice) {
    return (
      <Card title="Reply">
        <p className="text-sm" style={{ color: "#6b7280" }}>
          Voice conversations don't support typed replies. Use{" "}
          <span className="font-semibold" style={{ color: "#0a1f44" }}>
            Place voice call
          </span>{" "}
          below to call the patient back.
        </p>
      </Card>
    );
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      const data = err.data as
        | { error?: string; message?: string }
        | undefined;
      // 503 messaging-not-configured is the most actionable case for
      // an operator — surface the deployer-facing hint as-is.
      if (err.status === 503) {
        return (
          data?.message ??
          "Reply is disabled — messaging is not configured on this server."
        );
      }
      if (err.status === 409) {
        return data?.message ?? "Cannot reply on this conversation.";
      }
      return data?.message ?? data?.error ?? "Couldn't send reply.";
    }
    return err instanceof Error ? err.message : "Couldn't send reply.";
  }

  async function onSend() {
    setError(null);
    setStatusMsg(null);
    if (!canSend) return;
    try {
      await reply.mutateAsync({ id: conversationId, data: { body: trimmed } });
      setBody("");
      // Drop the persisted draft now that we've sent it; otherwise
      // the next visit to this conversation would re-hydrate the
      // exact text we just sent and tempt a duplicate send.
      draft.clear();
      setStatusMsg("Reply sent.");
      onAfterSend();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function onInsertTemplate(templateId: string) {
    let rendered: string | null = null;
    // 1. DB-backed macro (id is the macro UUID).
    const macro = filteredMacros.find((m) => m.id === templateId);
    if (macro) {
      // Apply both substitution passes — {{namespace.key}} for the
      // new merge tokens AND legacy {firstName} for any historical
      // body authored before the migration.
      rendered = applyLegacyFirstName(
        applyMacro(macro.body, {
          patient: { firstName: patientFirstName },
        }),
        patientFirstName,
      );
    }
    // 2. Hardcoded fallback (id is the template id).
    if (!rendered) {
      const tpl = fallbackTemplates.find((t) => t.id === templateId);
      if (tpl) rendered = applyTemplate(tpl.body, patientFirstName);
    }
    if (!rendered) return;
    setBody((prev) => {
      const trimmedPrev = prev.trim();
      return trimmedPrev.length === 0
        ? rendered!
        : `${prev.trimEnd()}\n\n${rendered}`;
    });
    setStatusMsg(null);
    setError(null);
  }

  return (
    <Card
      title="Reply on this thread"
      subtitle={
        isClosed
          ? "This conversation is closed — start a new reminder from the patient page."
          : "Sends on the channel the patient is already using. Audited."
      }
    >
      {!isClosed &&
        (filteredMacros.length > 0 || fallbackTemplates.length > 0) && (
          <div className="mb-3 flex items-center gap-2">
            <label
              htmlFor="reply-template"
              className="text-xs font-semibold"
              style={{ color: "#6b7280" }}
            >
              Insert canned reply:
            </label>
            <select
              id="reply-template"
              value=""
              disabled={reply.isPending}
              onChange={(e) => {
                if (e.target.value) onInsertTemplate(e.target.value);
              }}
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: "#e5e7eb", color: "#0a1f44" }}
            >
              <option value="">Choose a reply…</option>
              {filteredMacros.length > 0 ? (
                Object.entries(groupByCategory(filteredMacros)).map(
                  ([category, items]) => (
                    <optgroup key={category} label={category}>
                      {items.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ),
                )
              ) : (
                fallbackTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))
              )}
            </select>
          </div>
        )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={isClosed || reply.isPending}
        placeholder={
          isClosed
            ? "Conversation is closed."
            : channel === "sms"
              ? "Type a reply (will be sent via SMS)…  ·  ⌘/Ctrl + Enter to send"
              : "Type a reply (will be sent via email)…  ·  ⌘/Ctrl + Enter to send"
        }
        rows={3}
        maxLength={1700}
        // Keyboard shortcut — Cmd/Ctrl+Enter to send. Mirrors Slack /
        // Linear / GitHub conventions. Plain Enter still inserts a
        // newline so the admin can keep formatting multi-paragraph
        // replies. We stop propagation so a parent shortcut listener
        // (none today, but defensively) can't double-fire.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (canSend) void onSend();
          }
        }}
        className="w-full rounded border px-3 py-2 text-sm font-sans resize-y"
        style={{ borderColor: "#e5e7eb", color: "#0a1f44" }}
        data-testid="conv-reply-textarea"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className="text-xs"
          style={{ color: tooLong ? "#b91c1c" : "#6b7280" }}
        >
          {trimmed.length} / 1600
          {channel === "sms" && trimmed.length > 160
            ? " · will send as multi-part SMS"
            : ""}
          {draft.restored && trimmed.length > 0 ? " · draft restored" : ""}
        </span>
        <Button
          onClick={() => void onSend()}
          isLoading={reply.isPending}
          disabled={!canSend || reply.isPending}
        >
          Send reply
        </Button>
      </div>
      {error && (
        <p
          className="mt-3 text-sm"
          style={{ color: "#b91c1c" }}
          role="alert"
        >
          {error}
        </p>
      )}
      {statusMsg && !error && (
        <p
          className="mt-3 text-sm"
          style={{ color: "#166534" }}
          role="status"
        >
          {statusMsg}
        </p>
      )}
    </Card>
  );
}

// Group macros by category for the picker. Uncategorized macros bucket
// to "General". Insertion order in each bucket follows the array order
// (already sorted by sortOrder + label from the API).
function groupByCategory(macros: CsrMacro[]): Record<string, CsrMacro[]> {
  const out: Record<string, CsrMacro[]> = {};
  for (const m of macros) {
    const cat = m.category?.trim() || "General";
    if (!out[cat]) out[cat] = [];
    out[cat]!.push(m);
  }
  return out;
}

function BackLink() {
  return (
    <Link
      href="/conversations"
      className="text-sm underline"
      style={{ color: "#0a1f44" }}
    >
      ← Back to conversations
    </Link>
  );
}

function ActionBar({
  patientId,
  episodeId,
  onAfterAction,
}: {
  patientId: string;
  episodeId: string;
  onAfterAction: () => void;
}) {
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const sms = useSendSmsReminder();
  const email = useSendEmailReminder();
  const voice = usePlaceVoiceCall();

  const isBusy = sms.isPending || email.isPending || voice.isPending;

  function fire(
    label: string,
    promise: Promise<unknown>,
  ) {
    setFeedback(null);
    promise
      .then(() => {
        setFeedback({ kind: "success", text: `${label} sent.` });
        onAfterAction();
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error && err.message ? err.message : "Request failed.";
        setFeedback({ kind: "error", text: `${label} failed: ${msg}` });
      });
  }

  return (
    <Card title="Admin actions" subtitle="All actions write to the audit log.">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          isLoading={sms.isPending}
          disabled={isBusy && !sms.isPending}
          onClick={() =>
            fire(
              "SMS reminder",
              sms.mutateAsync({ data: { patientId, episodeId } }),
            )
          }
        >
          Send SMS reminder
        </Button>
        <Button
          intent="secondary"
          isLoading={email.isPending}
          disabled={isBusy && !email.isPending}
          onClick={() =>
            fire(
              "Email reminder",
              email.mutateAsync({ data: { patientId, episodeId } }),
            )
          }
        >
          Send email reminder
        </Button>
        <Button
          intent="secondary"
          isLoading={voice.isPending}
          disabled={isBusy && !voice.isPending}
          onClick={() =>
            fire(
              "Voice call",
              voice.mutateAsync({ data: { patientId, episodeId } }),
            )
          }
        >
          Place voice call
        </Button>
      </div>
      {feedback && (
        <p
          className="mt-3 text-sm"
          style={{ color: feedback.kind === "success" ? "#166534" : "#991b1b" }}
          role="status"
        >
          {feedback.text}
        </p>
      )}
    </Card>
  );
}
