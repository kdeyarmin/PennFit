// Patient-detail "Timeline" tab — extracted from patient-detail.tsx.
//
// Renders the merged event feed from GET /patients/:id/timeline.
// Events are already sorted server-side (newest first) and include
// optional cross-references for deep-linking — currently we only
// link conversation events back into the conversation detail page.
//
// Helpers timelineKindLabel + TimelineRow are scoped to this file —
// they're not used anywhere else.

import {
  useGetPatientTimeline,
  type PatientTimelineEvent,
} from "@workspace/api-client-react/admin";
import { Badge, humanizeStatus } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { formatDateTime } from "@/lib/admin/format";

export function TimelineTab({
  patientId,
  onConversationClick,
}: {
  patientId: string;
  onConversationClick: (id: string) => void;
}) {
  const { data, isPending, isError, error, refetch } =
    useGetPatientTimeline(patientId);

  if (isError) {
    return (
      <ErrorPanel
        error={error}
        onRetry={() => void refetch()}
        title="Couldn't load timeline"
      />
    );
  }
  if (isPending || !data) {
    return <Spinner label="Loading timeline…" />;
  }
  if (data.events.length === 0) {
    return (
      <EmptyState
        title="Nothing has happened yet."
        hint="Timeline events appear once this patient has prescriptions, episodes, fulfillments, or conversations."
      />
    );
  }
  return (
    <ol className="space-y-3" role="list">
      {data.events.map((ev, i) => (
        <TimelineRow
          key={`${ev.kind}-${ev.at}-${i}`}
          event={ev}
          onConversationClick={onConversationClick}
        />
      ))}
    </ol>
  );
}

function timelineKindLabel(kind: PatientTimelineEvent["kind"]): {
  label: string;
  variant: Parameters<typeof Badge>[0]["variant"];
} {
  switch (kind) {
    case "patient_created":
      return { label: "Patient created", variant: "neutral" };
    case "prescription_created":
      return { label: "Prescription", variant: "info" };
    case "episode_created":
      return { label: "Episode", variant: "info" };
    case "message":
      return { label: "Message", variant: "neutral" };
    case "fulfillment_queued":
      return { label: "Fulfillment queued", variant: "muted" };
    case "fulfillment_submitted":
      return { label: "Fulfillment submitted", variant: "info" };
    case "fulfillment_shipped":
      return { label: "Fulfillment shipped", variant: "success" };
    case "fulfillment_delivered":
      return { label: "Fulfillment delivered", variant: "success" };
    default:
      return { label: humanizeStatus(kind), variant: "muted" };
  }
}

function TimelineRow({
  event,
  onConversationClick,
}: {
  event: PatientTimelineEvent;
  onConversationClick: (id: string) => void;
}) {
  const { label, variant } = timelineKindLabel(event.kind);
  const isLinkable = event.kind === "message" && event.conversationId != null;
  return (
    <li className="border-l-2 pl-3 py-1" style={{ borderColor: "#c9a24a" }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={variant}>{label}</Badge>
          <span
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {event.title}
          </span>
        </div>
        <span
          className="text-xs whitespace-nowrap"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {formatDateTime(event.at)}
        </span>
      </div>
      {event.detail && (
        <p
          className="mt-1 text-sm whitespace-pre-wrap"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {event.detail}
        </p>
      )}
      {isLinkable && event.conversationId && (
        <button
          type="button"
          onClick={() => onConversationClick(event.conversationId!)}
          className="mt-1 text-xs underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open conversation →
        </button>
      )}
    </li>
  );
}
