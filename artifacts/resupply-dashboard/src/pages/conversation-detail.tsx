import { useState } from "react";
import { Link } from "wouter";
import {
  useGetConversation,
  useSendSmsReminder,
  useSendEmailReminder,
  usePlaceVoiceCall,
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

// Conversation viewer. Renders the chronological message timeline as
// channel-aware bubbles (operator/agent on the right, patient on the
// left). The action bar at the bottom wires the existing
// send-reminder + place-call mutations so an operator can act from
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
    <div className="space-y-6 max-w-4xl">
      <BackLink />
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

      <ActionBar
        patientId={data.patientId}
        episodeId={data.episodeId}
        onAfterAction={() => void refetch()}
      />
    </div>
  );
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
    <Card title="Operator actions" subtitle="All actions write to the audit log.">
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
