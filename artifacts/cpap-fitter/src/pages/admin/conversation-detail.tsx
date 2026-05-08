import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ApiError,
  type ConversationMessageAttachment,
  useGetConversation,
  useSendSmsReminder,
  useSendEmailReminder,
  usePlaceVoiceCall,
  useReplyInConversation,
} from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  humanizeStatus,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { fullName, formatDateTime } from "@/lib/admin/format";
import {
  applyTemplate,
  templatesForChannel,
} from "@/lib/admin/reply-templates";
import { applyMacro, applyLegacyFirstName } from "@/lib/admin/macro-merge";
import { listMacros, type CsrMacro } from "@/lib/admin/csr-macros-api";
import { useQuery } from "@tanstack/react-query";
import { Patient360Panel } from "@/components/admin/Patient360Panel";
import { Customer360Panel } from "@/components/admin/Customer360Panel";
import { ConversationAssignmentBar } from "@/components/admin/ConversationAssignmentBar";
import { useDraftAutosave } from "@/lib/admin/use-draft-autosave";
import { setConversationStatus } from "@/lib/admin/conversation-assignment-api";

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
                <p
                  className="text-xs uppercase tracking-wider mb-1"
                  style={{ color: "hsl(var(--penn-gold-deep))" }}
                >
                  {data.channel === "in_app"
                    ? "In-account conversation"
                    : "Conversation"}
                </p>
                <h1
                  className="text-2xl font-semibold mb-1"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {data.channel === "in_app" && data.customerId ? (
                    /*
                      In-app threads: header links to the
                      customer-360 page where the CSR can see saved
                      device + physician info + lifetime stats. No
                      patient context to show — a shop customer is a
                      different identity space than a resupply
                      patient.
                    */
                    <Link
                      href={`/admin/shop/customers/${encodeURIComponent(data.customerId)}`}
                      className="underline decoration-dotted"
                      style={{ color: "hsl(var(--ink-1))" }}
                      data-testid="conv-detail-customer-link"
                    >
                      {data.customerDisplayName ??
                        data.customerEmail ??
                        "Shop customer"}
                    </Link>
                  ) : data.patientId ? (
                    <Link
                      href={`/patients/${data.patientId}`}
                      className="underline decoration-dotted"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {fullName(data.patientFirstName, data.patientLastName)}
                    </Link>
                  ) : (
                    /*
                      Defensive: a row with neither subject set would
                      indicate a CHECK-constraint violation upstream.
                      Render a placeholder so the UI doesn't crash.
                    */
                    "Unknown subject"
                  )}
                </h1>
                {data.channel === "in_app" && data.customerEmail && (
                  <p
                    className="text-xs mb-1"
                    style={{ color: "hsl(var(--ink-3))" }}
                    data-testid="conv-detail-customer-email"
                  >
                    {data.customerEmail}
                  </p>
                )}
                <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
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
                {/*
                  Resolved / reopen toggle — Phase 8. In-app threads
                  only (server enforces 409 otherwise; we hide the
                  button to avoid teasing CSRs with an action that
                  won't work). The button calls setConversationStatus
                  and triggers a refetch so the badge updates without
                  a full reload.
                */}
                {data.channel === "in_app" && (
                  <ConversationStatusButton
                    conversationId={data.id}
                    currentStatus={data.status}
                    onChanged={() => void refetch()}
                  />
                )}
              </div>
            </div>
            <ConversationAssignmentBar
              conversationId={data.id}
              assignedAdminUserId={
                (data as { assignedAdminUserId?: string | null })
                  .assignedAdminUserId ?? null
              }
              priority={
                ((data as { priority?: string }).priority ?? "normal") as
                  | "low"
                  | "normal"
                  | "high"
                  | "urgent"
              }
              slaDueAt={(data as { slaDueAt?: string | null }).slaDueAt ?? null}
              escalatedAt={
                (data as { escalatedAt?: string | null }).escalatedAt ?? null
              }
              escalationReason={
                (data as { escalationReason?: string | null })
                  .escalationReason ?? null
              }
              status={data.status}
              onChange={() => void refetch()}
            />
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
                                  color: "hsl(var(--ink-1))",
                                  borderColor: "hsl(var(--line-1))",
                                }
                          }
                        >
                          {m.body}
                        </div>
                        {m.attachments && m.attachments.length > 0 && (
                          <MessageAttachments
                            conversationId={data.id}
                            messageId={m.id}
                            attachments={m.attachments}
                            isOutbound={isOutbound}
                          />
                        )}
                        <p
                          className="text-[10px] mt-1 px-1"
                          style={{
                            color: "hsl(var(--ink-3))",
                            textAlign: isOutbound ? "right" : "left",
                          }}
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

          {/*
            ActionBar is patient-flow only — it fires SMS / email /
            voice reminders against the conversation's patient_id +
            episode_id. In-app threads have neither, so the bar is
            hidden. CSRs use the in-app reply composer above for
            outbound messages.
          */}
          {data.channel !== "in_app" && data.patientId && data.episodeId && (
            <ActionBar
              patientId={data.patientId}
              episodeId={data.episodeId}
              onAfterAction={() => void refetch()}
            />
          )}
        </div>
        <aside className="space-y-4">
          {/*
            For patient-flow threads: Patient360Panel pulls timeline +
            episodes. For in-app threads (Phase 11): Customer360Panel
            pulls device + latest order + recent internal notes inline
            so the CSR can answer most questions without leaving this
            page.
          */}
          {data.channel === "in_app" && data.customerId ? (
            <Customer360Panel
              customerId={data.customerId}
              displayName={data.customerDisplayName ?? null}
              email={data.customerEmail ?? null}
            />
          ) : data.patientId ? (
            <Patient360Panel patientId={data.patientId} />
          ) : null}
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
      ? dbMacros.filter((m) => m.channels.includes(channel as "sms" | "email"))
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
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Voice conversations don't support typed replies. Use{" "}
          <span
            className="font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Place voice call
          </span>{" "}
          below to call the patient back.
        </p>
      </Card>
    );
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      const data = err.data as { error?: string; message?: string } | undefined;
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
              style={{ color: "hsl(var(--ink-3))" }}
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
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--ink-1))",
              }}
            >
              <option value="">Choose a reply…</option>
              {filteredMacros.length > 0
                ? Object.entries(groupByCategory(filteredMacros)).map(
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
                : fallbackTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
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
        style={{
          borderColor: "hsl(var(--line-1))",
          color: "hsl(var(--ink-1))",
        }}
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
          {draft.savedAt && trimmed.length > 0
            ? ` · saved locally ${formatDraftSavedAt(draft.savedAt)}`
            : ""}
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
        <p className="mt-3 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {error}
        </p>
      )}
      {statusMsg && !error && (
        <p className="mt-3 text-sm" style={{ color: "#166534" }} role="status">
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

// Inline attachment renderer for a single message bubble.
//
// Image MIME types render as a thumbnail grid; clicking opens a
// fullscreen lightbox with the original-size image. The thumbnail
// uses the same authenticated GET endpoint as the lightbox — the
// browser caches the bytes for ~5 min (per Cache-Control set by the
// download route) so opening the lightbox is a no-op fetch.
//
// Non-image attachments (PDFs and the rare other allowed types)
// render as a labeled chip — clicking opens the file in a new tab,
// where the inline Content-Disposition lets the browser preview
// it (PDFs) or fall back to download.
function MessageAttachments({
  conversationId,
  messageId,
  attachments,
  isOutbound,
}: {
  conversationId: string;
  messageId: string;
  attachments: ConversationMessageAttachment[];
  isOutbound: boolean;
}) {
  const [lightbox, setLightbox] =
    useState<ConversationMessageAttachment | null>(null);

  function urlFor(a: ConversationMessageAttachment): string {
    return `/resupply-api/conversations/${conversationId}/messages/${messageId}/attachments/${a.id}`;
  }

  const images = attachments.filter((a) =>
    a.contentType.toLowerCase().startsWith("image/"),
  );
  const others = attachments.filter(
    (a) => !a.contentType.toLowerCase().startsWith("image/"),
  );

  return (
    <div
      className="mt-2 flex flex-col gap-2"
      style={{ alignItems: isOutbound ? "flex-end" : "flex-start" }}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setLightbox(a)}
              className="block rounded border overflow-hidden bg-white"
              style={{
                borderColor: "hsl(var(--line-1))",
                width: 120,
                height: 120,
              }}
              title={a.filename ?? "Attachment"}
              data-testid={`attachment-thumb-${a.id}`}
            >
              <img
                src={urlFor(a)}
                alt={a.filename ?? "Attachment"}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {others.map((a) => (
        <a
          key={a.id}
          href={urlFor(a)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "#ffffff",
            color: "hsl(var(--ink-1))",
            maxWidth: "100%",
          }}
          data-testid={`attachment-chip-${a.id}`}
        >
          <span
            className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            style={{
              backgroundColor: "hsl(var(--line-1))",
              color: "hsl(var(--ink-2))",
            }}
          >
            {a.contentType.split("/")[1] ?? "file"}
          </span>
          <span className="truncate" style={{ maxWidth: 240 }}>
            {a.filename ?? "Attachment"}
          </span>
          <span style={{ color: "hsl(var(--ink-3))" }}>
            {formatBytes(a.sizeBytes)}
          </span>
        </a>
      ))}
      {lightbox && (
        // Plain fixed-position overlay rather than a Dialog component
        // because the admin app doesn't ship one yet and importing
        // Radix here just for this would balloon the bundle. Click on
        // backdrop OR Escape closes; the image itself swallows the
        // click so we don't dismiss while panning.
        <LightboxOverlay
          attachment={lightbox}
          src={urlFor(lightbox)}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function LightboxOverlay({
  attachment,
  src,
  onClose,
}: {
  attachment: ConversationMessageAttachment;
  src: string;
  onClose: () => void;
}) {
  // Escape key to dismiss. Bound on document so focus inside the
  // lightbox isn't required — anywhere on the page works. Cleanup
  // on unmount is required so a future page navigation that mounts
  // its own keydown handler doesn't see ours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename ?? "Attachment"}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.85)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        cursor: "zoom-out",
      }}
      data-testid="attachment-lightbox"
    >
      <img
        src={src}
        alt={attachment.filename ?? "Attachment"}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          cursor: "default",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          backgroundColor: "rgba(0,0,0,0.6)",
          color: "#ffffff",
          border: "1px solid rgba(255,255,255,0.3)",
          borderRadius: 6,
          padding: "6px 12px",
          fontSize: 14,
          cursor: "pointer",
        }}
        aria-label="Close attachment preview"
      >
        Close
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function BackLink() {
  return (
    <Link
      href="/admin/conversations"
      className="text-sm underline"
      style={{ color: "hsl(var(--ink-1))" }}
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

  function fire(label: string, promise: Promise<unknown>) {
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

/**
 * Phase 8 — small inline status toggle for in-app conversations.
 *
 * Shows "Mark resolved" when the thread is open / awaiting_*; shows
 * "Reopen" when the thread is closed. Posts to /conversations/:id/status
 * and surfaces a brief inline error on failure. The parent re-fetches
 * via onChanged so the badge updates immediately.
 *
 * Why no server-side restriction on which transitions: the route
 * accepts any of the four enum values so a CSR can manually correct
 * a misclassification (e.g. "I closed too early; reopen as
 * awaiting_admin"). The UI exposes only the two common transitions;
 * the underlying flexibility is there if we ever add a manual-
 * override dropdown.
 */
function ConversationStatusButton({
  conversationId,
  currentStatus,
  onChanged,
}: {
  conversationId: string;
  currentStatus: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClosed = currentStatus === "closed";
  const next = isClosed ? "awaiting_admin" : "closed";
  const label = isClosed ? "Reopen" : "Mark resolved";

  const onClick = (): void => {
    setBusy(true);
    setError(null);
    void setConversationStatus(conversationId, next)
      .then(() => {
        onChanged();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        intent={isClosed ? "primary" : "secondary"}
        size="sm"
        onClick={onClick}
        disabled={busy}
        data-testid="conv-status-toggle"
      >
        {busy ? "Saving…" : label}
      </Button>
      {error && (
        <span
          role="alert"
          className="text-xs"
          style={{ color: "#991b1b" }}
          data-testid="conv-status-error"
        >
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Compact relative-time formatter for the draft autosave hint
 * ("just now" / "5m ago" / "2h ago" / "3d ago"). We don't reuse the
 * other admin pages' formatRelative variants because they each take
 * a different signature; keeping this local avoids a refactor.
 */
function formatDraftSavedAt(savedAt: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - savedAt.getTime()) / 1000));
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
