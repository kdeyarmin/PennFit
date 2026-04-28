import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ApiError,
  useGetPatient,
  useGetPatientTimeline,
  useUpdatePatient,
  type PatientDetail,
  type PatientTimelineEvent,
} from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  episodeStatusVariant,
  fulfillmentStatusVariant,
  humanizeStatus,
  patientStatusVariant,
} from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Button } from "../components/Button";
import { Input, Label, Select } from "../components/Input";
import { fullName, formatDate, formatDateTime } from "../lib/format";

type Tab =
  | "timeline"
  | "episodes"
  | "conversations"
  | "fulfillments"
  | "prescriptions";

export function PatientDetailPage({ id }: { id: string }) {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("timeline");
  const { data, isPending, isError, error, refetch } = useGetPatient(id);

  if (isError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load patient"
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <Card>
          <Spinner label="Loading patient…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <BackLink />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-semibold mb-1"
              style={{ color: "#0a1f44" }}
            >
              {fullName(data.firstName, data.lastName)}
            </h1>
            <p className="text-xs" style={{ color: "#6b7280" }}>
              PACware ID #{data.pacwareId} · Patient created {formatDate(data.createdAt)}
            </p>
          </div>
          <Badge variant={patientStatusVariant(data.status)}>
            {humanizeStatus(data.status)}
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "#c9a24a" }}
            >
              Channels on file
            </p>
            <div className="flex gap-2">
              {data.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
              {data.hasEmail && <Badge variant="neutral">Email</Badge>}
              {!data.hasPhone && !data.hasEmail && (
                <Badge variant="muted">No contact methods on file</Badge>
              )}
            </div>
          </div>
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "#c9a24a" }}
            >
              Last updated
            </p>
            <p style={{ color: "#0a1f44" }}>{formatDateTime(data.updatedAt)}</p>
          </div>
        </div>
      </Card>

      <SettingsCard patient={data} onSaved={() => void refetch()} />

      <div
        className="flex gap-1 border-b"
        style={{ borderColor: "#e5e7eb" }}
        role="tablist"
      >
        <TabButton active={tab === "timeline"} onClick={() => setTab("timeline")}>
          Timeline
        </TabButton>
        <TabButton active={tab === "episodes"} onClick={() => setTab("episodes")}>
          Episodes ({data.episodes.length})
        </TabButton>
        <TabButton
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
        >
          Conversations ({data.conversations.length})
        </TabButton>
        <TabButton
          active={tab === "fulfillments"}
          onClick={() => setTab("fulfillments")}
        >
          Fulfillments ({data.fulfillments.length})
        </TabButton>
        <TabButton
          active={tab === "prescriptions"}
          onClick={() => setTab("prescriptions")}
        >
          Prescriptions ({data.prescriptions.length})
        </TabButton>
      </div>

      <Card>
        {tab === "timeline" && (
          <TimelineTab
            patientId={id}
            onConversationClick={(cid) => setLocation(`/conversations/${cid}`)}
          />
        )}
        {tab === "episodes" && <EpisodesTab episodes={data.episodes} />}
        {tab === "conversations" && (
          <ConversationsTab
            conversations={data.conversations}
            onRowClick={(cid) => setLocation(`/conversations/${cid}`)}
          />
        )}
        {tab === "fulfillments" && (
          <FulfillmentsTab fulfillments={data.fulfillments} />
        )}
        {tab === "prescriptions" && (
          <PrescriptionsTab prescriptions={data.prescriptions} />
        )}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/patients"
      className="text-sm underline"
      style={{ color: "#0a1f44" }}
    >
      ← Back to patients
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
      style={{
        color: active ? "#0a1f44" : "#6b7280",
        borderColor: active ? "#c9a24a" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

type Episode = {
  id: string;
  prescriptionId: string;
  itemSku: string;
  status: string;
  dueAt: string;
  expiresAt?: string | null;
  createdAt: string;
};

function EpisodesTab({ episodes }: { episodes: Episode[] }) {
  const cols: Column<Episode>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={episodeStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    { key: "due", header: "Due", render: (r) => formatDate(r.dueAt) },
    { key: "exp", header: "Expires", render: (r) => formatDate(r.expiresAt) },
  ];
  return (
    <Table
      columns={cols}
      rows={episodes}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No episodes for this patient yet." />}
    />
  );
}

type Conversation = {
  id: string;
  episodeId: string;
  channel: string;
  status: string;
  lastMessageAt?: string | null;
  createdAt: string;
};

function ConversationsTab({
  conversations,
  onRowClick,
}: {
  conversations: Conversation[];
  onRowClick: (id: string) => void;
}) {
  const cols: Column<Conversation>[] = [
    {
      key: "channel",
      header: "Channel",
      render: (r) => (
        <Badge variant={channelVariant(r.channel)}>
          {humanizeStatus(r.channel)}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={conversationStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "last",
      header: "Last message",
      render: (r) => formatDateTime(r.lastMessageAt),
    },
    {
      key: "open",
      header: "",
      render: () => (
        <span className="text-xs underline" style={{ color: "#0a1f44" }}>
          Open →
        </span>
      ),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={conversations}
      rowKey={(r) => r.id}
      onRowClick={(r) => onRowClick(r.id)}
      emptyState={
        <EmptyState
          title="No recent conversations."
          hint="Up to 10 most recent are shown here."
        />
      }
    />
  );
}

type Fulfillment = {
  id: string;
  episodeId: string;
  itemSku: string;
  quantity: string;
  status: string;
  pacwareOrderRef?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
};

function FulfillmentsTab({ fulfillments }: { fulfillments: Fulfillment[] }) {
  const cols: Column<Fulfillment>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    { key: "qty", header: "Qty", render: (r) => r.quantity },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={fulfillmentStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "ref",
      header: "PACware ref",
      render: (r) => r.pacwareOrderRef ?? "—",
    },
    {
      key: "ship",
      header: "Shipped",
      render: (r) => formatDate(r.shippedAt),
    },
    {
      key: "deliv",
      header: "Delivered",
      render: (r) => formatDate(r.deliveredAt),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={fulfillments}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No fulfillment activity yet." />}
    />
  );
}

type Prescription = {
  id: string;
  itemSku: string;
  cadenceDays: number;
  validFrom: string;
  validUntil?: string | null;
  status: string;
  createdAt: string;
};

function PrescriptionsTab({ prescriptions }: { prescriptions: Prescription[] }) {
  const cols: Column<Prescription>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => `${r.cadenceDays} days`,
    },
    { key: "from", header: "Valid from", render: (r) => formatDate(r.validFrom) },
    {
      key: "until",
      header: "Valid until",
      render: (r) => formatDate(r.validUntil),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={r.status === "active" ? "success" : "muted"}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={prescriptions}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No prescriptions on file." />}
    />
  );
}


// ----------------------
// Settings panel
// ----------------------
//
// Three operator-managed fields that override the defaults used by
// the eligibility engine:
//   - insurancePayer: free-text payer name (e.g. "Aetna"). Used as a
//     match key by frequency_rules; blank means "no payer recorded"
//     and rules with a payer constraint will not apply.
//   - cadenceOverrideDays: hard override of the days between
//     reminders. Wins over rules and the prescription cadence.
//   - channelPreference: hard override of the outbound channel.
//     Wins over rules and the SMS-then-email fallback.
//
// "Save" sends ONLY the fields the operator actually changed (the
// PATCH endpoint treats omitted keys as "leave alone" and explicit
// `null` as "clear"). "Reset to default" clears all three overrides
// in a single PATCH so the eligibility engine falls all the way
// back to rules / prescription defaults.

type ChannelChoice = "" | "sms" | "email" | "voice";

function SettingsCard({
  patient,
  onSaved,
}: {
  patient: PatientDetail;
  onSaved: () => void;
}) {
  // Local form state. We re-seed from the server snapshot whenever
  // the patient row refetches (e.g. after a successful save) so the
  // "dirty" indicator clears.
  const [insurancePayer, setInsurancePayer] = useState(
    patient.insurancePayer ?? "",
  );
  const [cadence, setCadence] = useState(
    patient.cadenceOverrideDays != null
      ? String(patient.cadenceOverrideDays)
      : "",
  );
  const [channel, setChannel] = useState<ChannelChoice>(
    (patient.channelPreference ?? "") as ChannelChoice,
  );
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const mutation = useUpdatePatient();
  const isPending = mutation.isPending;

  useEffect(() => {
    setInsurancePayer(patient.insurancePayer ?? "");
    setCadence(
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "",
    );
    setChannel((patient.channelPreference ?? "") as ChannelChoice);
    setError(null);
  }, [
    patient.insurancePayer,
    patient.cadenceOverrideDays,
    patient.channelPreference,
  ]);

  function buildPatch(): {
    body: Record<string, string | number | null>;
    error: string | null;
  } {
    const body: Record<string, string | number | null> = {};
    // insurance: empty string clears, anything else is a set.
    const insTrim = insurancePayer.trim();
    const insOnServer = patient.insurancePayer ?? "";
    if (insTrim !== insOnServer) {
      body.insurancePayer = insTrim === "" ? null : insTrim;
    }
    // cadence: empty clears, otherwise integer in [1,365].
    const cadOnServer =
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "";
    if (cadence.trim() !== cadOnServer) {
      if (cadence.trim() === "") {
        body.cadenceOverrideDays = null;
      } else {
        const n = Number(cadence);
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          return {
            body: {},
            error: "Cadence override must be a whole number between 1 and 365.",
          };
        }
        body.cadenceOverrideDays = n;
      }
    }
    // channel: empty clears, otherwise enum.
    const chOnServer = patient.channelPreference ?? "";
    if (channel !== chOnServer) {
      body.channelPreference = channel === "" ? null : channel;
    }
    return { body, error: null };
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      // ConsoleValidationError surface
      const data = err.data as
        | { error?: string; message?: string }
        | undefined;
      return data?.message ?? data?.error ?? "Couldn't save changes.";
    }
    return err instanceof Error ? err.message : "Couldn't save changes.";
  }

  async function onSave() {
    setError(null);
    setStatusMsg(null);
    const { body, error: validationError } = buildPatch();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (Object.keys(body).length === 0) {
      setStatusMsg("No changes to save.");
      return;
    }
    try {
      const res = await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg(
        res.changed.length === 0
          ? "No fields changed."
          : `Saved ${res.changed.length} field${res.changed.length === 1 ? "" : "s"}.`,
      );
      onSaved();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function onReset() {
    setError(null);
    setStatusMsg(null);
    const body: Record<string, string | number | null> = {};
    if (patient.insurancePayer != null) body.insurancePayer = null;
    if (patient.cadenceOverrideDays != null) body.cadenceOverrideDays = null;
    if (patient.channelPreference != null) body.channelPreference = null;
    if (Object.keys(body).length === 0) {
      setStatusMsg("Nothing to reset — already on defaults.");
      return;
    }
    try {
      await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg("Reset to defaults — eligibility engine will use rules.");
      onSaved();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const hasOverride =
    patient.insurancePayer != null ||
    patient.cadenceOverrideDays != null ||
    patient.channelPreference != null;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2
            className="text-sm uppercase tracking-wider font-semibold mb-1"
            style={{ color: "#c9a24a" }}
          >
            Reminder settings
          </h2>
          <p className="text-xs" style={{ color: "#6b7280" }}>
            Per-patient overrides win over global rules and the
            prescription cadence. Leave a field blank to fall back to
            the rules engine.
          </p>
        </div>
        {hasOverride && (
          <Badge variant="info">Custom override active</Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label htmlFor="patient-insurance">Insurance payer</Label>
          <Input
            id="patient-insurance"
            value={insurancePayer}
            placeholder="e.g. Aetna"
            maxLength={120}
            onChange={(e) => setInsurancePayer(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
            Free-text — match key for rules.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-cadence">Cadence override (days)</Label>
          <Input
            id="patient-cadence"
            type="number"
            min={1}
            max={365}
            value={cadence}
            placeholder="—"
            onChange={(e) => setCadence(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
            Whole days, 1–365.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-channel">Channel preference</Label>
          <Select
            id="patient-channel"
            value={channel}
            options={[
              { value: "sms", label: "SMS" },
              { value: "email", label: "Email" },
              { value: "voice", label: "Voice (manual)" },
            ]}
            emptyOptionLabel="Use default"
            onChange={(e) => setChannel(e.target.value as ChannelChoice)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
            Voice is operator-initiated only.
          </p>
        </div>
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
          style={{ color: "#0a1f44" }}
          role="status"
        >
          {statusMsg}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button onClick={() => void onSave()} isLoading={isPending}>
          Save changes
        </Button>
        <Button
          intent="secondary"
          onClick={() => void onReset()}
          disabled={isPending || !hasOverride}
        >
          Reset to default
        </Button>
      </div>
    </Card>
  );
}

// ----------------------
// Timeline tab
// ----------------------
//
// Renders the merged event feed from GET /patients/:id/timeline.
// Events are already sorted server-side (newest first) and include
// optional cross-references for deep-linking — currently we only
// link conversation events back into the conversation detail page.

function TimelineTab({
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
  const isLinkable =
    event.kind === "message" && event.conversationId != null;
  return (
    <li
      className="border-l-2 pl-3 py-1"
      style={{ borderColor: "#c9a24a" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={variant}>{label}</Badge>
          <span
            className="text-sm font-semibold"
            style={{ color: "#0a1f44" }}
          >
            {event.title}
          </span>
        </div>
        <span className="text-xs whitespace-nowrap" style={{ color: "#6b7280" }}>
          {formatDateTime(event.at)}
        </span>
      </div>
      {event.detail && (
        <p
          className="mt-1 text-sm whitespace-pre-wrap"
          style={{ color: "#374151" }}
        >
          {event.detail}
        </p>
      )}
      {isLinkable && event.conversationId && (
        <button
          type="button"
          onClick={() => onConversationClick(event.conversationId!)}
          className="mt-1 text-xs underline"
          style={{ color: "#0a1f44" }}
        >
          Open conversation →
        </button>
      )}
    </li>
  );
}
