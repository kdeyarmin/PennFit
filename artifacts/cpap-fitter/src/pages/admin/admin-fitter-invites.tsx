// /admin/fitter-invites — staff AI mask-fitter invite worklist.
//
// Send a prospect/patient a link to run the AI mask fitter; track who
// has opened/completed; review the returned measurements + answers +
// recommendation; and attach a completed fitting to a patient chart
// (an existing one, or a freshly-built one for a new prospect).
//
// Auto-attach already linked the obvious cases (recipient email/phone
// matched a single chart on completion). This page resolves the rest.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ScanFace } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { FitterInviteButton } from "@/components/admin/FitterInviteButton";
import { formatDateTime } from "@/lib/admin/format";
import { useDashboardIdentity } from "@/lib/admin/identity";
import {
  attachFitterInvite,
  claimFitterInvite,
  listFitterInvites,
  releaseFitterInvite,
  resendFitterInvite,
  revokeFitterInvite,
  type FitterInviteRow,
  type FitterInviteStatus,
} from "@/lib/admin/fitter-invites-api";

const QUERY_KEY = ["admin", "fitter-invites"] as const;

type FilterValue = FitterInviteStatus | "all" | "holding";

const STATUS_FILTERS: { value: FilterValue; label: string }[] = [
  { value: "holding", label: "Holding area" },
  { value: "all", label: "All" },
  { value: "sent", label: "Sent" },
  { value: "opened", label: "Opened" },
  { value: "completed", label: "Completed" },
  { value: "attached", label: "Attached" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

const STATUS_VARIANT: Record<
  FitterInviteStatus,
  "neutral" | "info" | "success" | "warning" | "danger" | "muted"
> = {
  sent: "info",
  opened: "warning",
  completed: "success",
  attached: "neutral",
  revoked: "muted",
  expired: "muted",
};

export function AdminFitterInvitesPage() {
  // Lead with the holding area — the prospects waiting to be claimed +
  // assigned are the work; the full invite list is secondary.
  const [status, setStatus] = useState<FilterValue>("holding");
  const identity = useDashboardIdentity();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [...QUERY_KEY, status],
    queryFn: () => listFitterInvites(status),
    staleTime: 15_000,
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: QUERY_KEY });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-fitter-invites-page"
    >
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ScanFace className="h-6 w-6" />
            Fitter invites
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Invite a prospect or patient to the AI mask fitter. Completed
            fittings auto-attach when the email/phone matches a chart; the rest
            land in the <strong>holding area</strong> — claim one, then assign
            it to an existing chart or build a new one.
          </p>
        </div>
        <FitterInviteButton
          prospectMode
          buttonLabel="New invite"
          onSent={refresh}
        />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            intent={status === f.value ? "primary" : "secondary"}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading invites…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            {status === "holding"
              ? "Holding area is empty — no completed fittings waiting to be assigned. 🎉"
              : "No fitter invites yet."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {query.data.map((invite) => (
            <InviteCard
              key={invite.id}
              invite={invite}
              currentUserId={identity.userId}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InviteCard({
  invite,
  currentUserId,
  onChanged,
}: {
  invite: FitterInviteRow;
  currentUserId: string | null;
  onChanged: () => void;
}) {
  const resend = useMutation({
    mutationFn: () => resendFitterInvite(invite.id),
    onSuccess: onChanged,
  });
  const revoke = useMutation({
    mutationFn: () => revokeFitterInvite(invite.id),
    onSuccess: onChanged,
  });

  const isCompleted =
    invite.status === "completed" || invite.status === "attached";
  // Holding area = a completed fitting with no chart yet.
  const inHolding = invite.status === "completed" && !invite.patient_id;
  const recipient =
    invite.recipient_name ||
    invite.recipient_email ||
    invite.recipient_phone_e164 ||
    "Unknown recipient";

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={STATUS_VARIANT[invite.status]}>
              {invite.status}
            </Badge>
            <Badge variant="muted">{invite.channel}</Badge>
            {invite.auto_matched && <Badge variant="info">auto-matched</Badge>}
            <span
              className="font-medium"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {recipient}
            </span>
          </div>
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {invite.recipient_email && <span>{invite.recipient_email} · </span>}
            {invite.recipient_phone_e164 && (
              <span>{invite.recipient_phone_e164} · </span>
            )}
            sent {invite.sent_at ? formatDateTime(invite.sent_at) : "—"}
            {invite.completed_at
              ? ` · completed ${formatDateTime(invite.completed_at)}`
              : ""}
          </div>
          {invite.patient_id && (
            <Link
              href={`/admin/patients/${encodeURIComponent(invite.patient_id)}`}
              className="text-xs underline decoration-dotted font-mono"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              chart {invite.patient_id}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2">
          {invite.status !== "revoked" && invite.status !== "expired" && (
            <Button
              size="sm"
              intent="secondary"
              isLoading={resend.isPending}
              onClick={() => resend.mutate()}
            >
              Resend
            </Button>
          )}
          {/* Revoke only outstanding invites — a completed/attached
              fitting holds captured measurements and must stay in the
              worklists. */}
          {(invite.status === "sent" ||
            invite.status === "opened" ||
            invite.status === "expired") && (
            <Button
              size="sm"
              intent="secondary"
              isLoading={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Revoke
            </Button>
          )}
        </div>
      </div>

      {isCompleted && (
        <div
          className="mt-3 pt-3 border-t space-y-3"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <RecommendationSummary invite={invite} />
          {inHolding && (
            <HoldingControls
              invite={invite}
              currentUserId={currentUserId}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </Card>
  );
}

// Holding-area resolution: claim ownership first, then assign. A
// fitting claimed by someone else shows who has it; anyone can release
// to take it over (collaboration, not a hard lock).
function HoldingControls({
  invite,
  currentUserId,
  onChanged,
}: {
  invite: FitterInviteRow;
  currentUserId: string | null;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const claim = useMutation({
    mutationFn: () => claimFitterInvite(invite.id),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: unknown) => {
      const data = (err as { data?: { message?: string; error?: string } })
        .data;
      setError(data?.message ?? data?.error ?? "Could not claim.");
    },
  });
  const release = useMutation({
    mutationFn: () => releaseFitterInvite(invite.id),
    onSuccess: onChanged,
  });

  const claimedBy = invite.claimed_by_user_id;
  const claimedByMe =
    claimedBy !== null && currentUserId !== null && claimedBy === currentUserId;
  const claimedByOther = claimedBy !== null && !claimedByMe;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="warning">unassigned</Badge>
        {claimedByMe && <Badge variant="info">claimed by you</Badge>}
        {claimedByOther && (
          <Badge variant="muted">
            claimed by {invite.claimed_by_email ?? "another staff member"}
          </Badge>
        )}
        {!claimedBy && (
          <Button
            size="sm"
            isLoading={claim.isPending}
            onClick={() => claim.mutate()}
          >
            Claim
          </Button>
        )}
        {claimedBy && (
          <Button
            size="sm"
            intent="secondary"
            isLoading={release.isPending}
            onClick={() => release.mutate()}
          >
            Release
          </Button>
        )}
      </div>

      {!claimedBy && (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Claim this fitting to assign it to a chart or build a new one.
        </p>
      )}
      {claimedByOther && (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Release it to take over, or leave it for{" "}
          {invite.claimed_by_email ?? "the current owner"}.
        </p>
      )}
      {claimedByMe && <AttachControls invite={invite} onChanged={onChanged} />}

      {error && (
        <p className="text-sm" style={{ color: "#991b1b" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function RecommendationSummary({ invite }: { invite: FitterInviteRow }) {
  const m = invite.measurements;
  return (
    <div className="space-y-2">
      {invite.recommended_mask_name && (
        <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
          Recommended:{" "}
          <span className="font-medium">{invite.recommended_mask_name}</span>
          {invite.recommended_mask_type
            ? ` (${invite.recommended_mask_type})`
            : ""}
        </p>
      )}
      {m && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <Measure label="Nose W" value={m.noseWidth} />
          <Measure label="Nose H" value={m.noseHeight} />
          <Measure label="Nose→chin" value={m.noseToChin} />
          <Measure label="Mouth W" value={m.mouthWidth} />
          <Measure label="Face W" value={m.faceWidthAtCheekbones} />
        </div>
      )}
    </div>
  );
}

function Measure({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded border px-2 py-1"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div style={{ color: "hsl(var(--ink-3))" }}>{label}</div>
      <div className="font-mono" style={{ color: "hsl(var(--ink-1))" }}>
        {typeof value === "number" ? `${value.toFixed(1)} mm` : "—"}
      </div>
    </div>
  );
}

function AttachControls({
  invite,
  onChanged,
}: {
  invite: FitterInviteRow;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<null | "existing" | "new">(null);
  const [patientId, setPatientId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: () => {
      if (mode === "existing") {
        return attachFitterInvite(invite.id, { patientId: patientId.trim() });
      }
      return attachFitterInvite(invite.id, {
        createPatient: {
          legalFirstName: firstName.trim(),
          legalLastName: lastName.trim(),
          dateOfBirth: dob,
        },
      });
    },
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: unknown) => {
      const data = (err as { data?: { message?: string; error?: string } })
        .data;
      setError(data?.message ?? data?.error ?? "Could not attach.");
    },
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          intent={mode === "existing" ? "primary" : "secondary"}
          onClick={() => setMode("existing")}
        >
          Attach to existing
        </Button>
        <Button
          size="sm"
          intent={mode === "new" ? "primary" : "secondary"}
          onClick={() => setMode("new")}
        >
          Build new chart
        </Button>
      </div>

      {mode === "existing" && (
        <div className="flex items-end gap-2 flex-wrap">
          <div className="space-y-1 grow">
            <Label htmlFor={`pid-${invite.id}`}>Patient ID (UUID)</Label>
            <Input
              id={`pid-${invite.id}`}
              placeholder="Paste the patient's chart ID"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            isLoading={attach.isPending}
            disabled={!patientId.trim()}
            onClick={() => attach.mutate()}
          >
            Attach
          </Button>
        </div>
      )}

      {mode === "new" && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Builds a chart from this fitting and enrolls the patient in the
            first-90-day onboarding program.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`fn-${invite.id}`}>First name</Label>
              <Input
                id={`fn-${invite.id}`}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`ln-${invite.id}`}>Last name</Label>
              <Input
                id={`ln-${invite.id}`}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`dob-${invite.id}`}>Date of birth</Label>
              <Input
                id={`dob-${invite.id}`}
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
              />
            </div>
          </div>
          <Button
            size="sm"
            isLoading={attach.isPending}
            disabled={!firstName.trim() || !lastName.trim() || !dob}
            onClick={() => attach.mutate()}
          >
            Build chart &amp; attach
          </Button>
        </div>
      )}

      {error && (
        <p className="text-sm" style={{ color: "#991b1b" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
