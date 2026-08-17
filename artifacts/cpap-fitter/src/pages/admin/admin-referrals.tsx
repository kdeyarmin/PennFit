// /admin/referrals — inbound referrals from the provider portal.
//
// The queue's default view is what still needs the DME to do something,
// because a referral sitting unacknowledged is a patient waiting and a
// referring practice losing confidence. Everything else is a filter away.
//
// A referral arrives with the fitting already done and a mask already
// approved by the referring clinician, so the decision here is narrow:
// take it (optionally onto an existing chart) or send it back with a
// reason. Both are one click plus, in the decline case, a sentence the
// provider will actually read.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, MessageSquare, UserCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatDateTime } from "@/lib/admin/format";
import {
  acceptReferral,
  declineReferral,
  fetchInboundReferral,
  fetchInboundReferrals,
  fetchProviderLinks,
  INBOUND_STATUS_LABEL,
  replyToReferral,
  setReferralStatus,
  updateProviderLink,
  type InboundReferral,
  type ReferralStatus,
} from "@/lib/admin/referrals-api";

const QUERY_KEY = ["admin", "referrals"] as const;

const FILTERS: Array<{ key: string; label: string; status?: ReferralStatus }> =
  [
    { key: "open", label: "Needs action" },
    { key: "submitted", label: "New", status: "submitted" },
    { key: "accepted", label: "Accepted", status: "accepted" },
    { key: "in_progress", label: "In progress", status: "in_progress" },
    { key: "dispensed", label: "Dispensed", status: "dispensed" },
    { key: "declined", label: "Declined", status: "declined" },
  ];

export function AdminReferralsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("open");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);

  const active = FILTERS.find((f) => f.key === filter);
  const referrals = useQuery({
    queryKey: [...QUERY_KEY, filter],
    queryFn: () =>
      fetchInboundReferrals(
        active?.status ? { status: active.status } : { open: true },
      ),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  const rows: InboundReferral[] = referrals.data?.referrals ?? [];

  return (
    <div className="admin-root space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox size={20} aria-hidden="true" />
            Referrals
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Patients sent to you by referring clinicians, with the mask fitting
            already done and a mask already approved. Accept one to bring it
            into your workflow, or send it back with a reason.
          </p>
        </div>
        <Button
          intent="secondary"
          onClick={() => setShowProviders((v) => !v)}
          aria-expanded={showProviders}
        >
          <UserCheck size={16} aria-hidden="true" />
          Referring providers
        </Button>
      </header>

      {showProviders ? <ProviderLinks /> : null}

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter referrals"
      >
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            intent={filter === f.key ? "primary" : "secondary"}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {referrals.isError ? (
        <ErrorPanel
          title="Couldn't load referrals"
          error={referrals.error}
          onRetry={() => void referrals.refetch()}
        />
      ) : null}
      {referrals.isLoading ? <Spinner /> : null}

      {!referrals.isLoading && rows.length === 0 ? (
        <Card>
          <p className="p-4 text-sm text-muted-foreground">
            {filter === "open"
              ? "Nothing waiting on you. New referrals from your linked providers land here."
              : "No referrals with that status."}
          </p>
        </Card>
      ) : null}

      <div className="space-y-3">
        {rows.map((r) => (
          <Card key={r.id}>
            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {r.patientName}
                    {r.patientDob ? (
                      <span className="ml-2 text-sm text-muted-foreground">
                        DOB {r.patientDob}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <Badge>{INBOUND_STATUS_LABEL[r.status]}</Badge>
                    <Badge>{r.therapyMode.toUpperCase()}</Badge>
                    {r.entryPoint !== "remote_link" ? (
                      <Badge>{r.entryPoint.replace(/_/g, " ")}</Badge>
                    ) : null}
                    {r.unreadForDme > 0 ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded border bg-blue-50 text-blue-900 border-blue-200">
                        {r.unreadForDme} new message
                        {r.unreadForDme === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Sent {formatDateTime(r.submittedAt)}
                  </p>
                  {r.status === "declined" && r.declinedReason ? (
                    <p className="text-sm mt-1.5">
                      Declined: {r.declinedReason}
                    </p>
                  ) : null}
                </div>
                <Button
                  intent="secondary"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  aria-expanded={expanded === r.id}
                >
                  {expanded === r.id ? "Hide" : "Open"}
                </Button>
              </div>

              {expanded === r.id ? (
                <ReferralPanel id={r.id} onChange={invalidate} />
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ReferralPanel({ id, onChange }: { id: string; onChange: () => void }) {
  const queryClient = useQueryClient();
  const key = [...QUERY_KEY, "detail", id] as const;
  const detail = useQuery({
    queryKey: key,
    queryFn: () => fetchInboundReferral(id),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    onChange();
  };

  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");

  const accept = useMutation({
    mutationFn: () => acceptReferral(id),
    onSuccess: refresh,
  });
  const decline = useMutation({
    mutationFn: () => declineReferral(id, reason),
    onSuccess: () => {
      setDeclining(false);
      setReason("");
      refresh();
    },
  });
  const advance = useMutation({
    mutationFn: (status: "in_progress" | "dispensed") =>
      setReferralStatus(id, status),
    onSuccess: refresh,
  });
  const message = useMutation({
    mutationFn: () => replyToReferral(id, reply.trim()),
    onSuccess: () => {
      setReply("");
      refresh();
    },
  });

  if (detail.isLoading) return <Spinner />;
  if (detail.isError || !detail.data) {
    return <ErrorPanel title="Couldn't load it" error={detail.error} />;
  }
  const d = detail.data;

  return (
    <div className="border-t pt-3 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3 text-sm">
        <div>
          <p className="font-medium mb-1">Patient</p>
          <p className="text-muted-foreground">
            {d.patient.email ?? "no email"}
            <br />
            {d.patient.phone ?? "no phone"}
          </p>
        </div>
        <div>
          <p className="font-medium mb-1">Insurance</p>
          <p className="text-muted-foreground">
            {d.insurance.payerName ?? "—"}
            <br />
            {d.insurance.memberId ?? ""}
          </p>
        </div>
        <div>
          <p className="font-medium mb-1">Referred by</p>
          <p className="text-muted-foreground">{d.createdByEmail ?? "—"}</p>
        </div>
      </div>

      {d.approval.approvedAt ? (
        <div className="rounded border p-3 text-sm">
          <p className="font-medium">
            Provider approved a mask
            {d.approval.isOverride
              ? " — different to what the fitting recommended"
              : ""}
          </p>
          {d.approval.note ? (
            <p className="text-muted-foreground mt-1">
              &ldquo;{d.approval.note}&rdquo;
            </p>
          ) : null}
          {d.signature.signedAt ? (
            <p className="text-xs text-muted-foreground mt-1">
              Order signed {formatDateTime(d.signature.signedAt)}
            </p>
          ) : null}
        </div>
      ) : null}

      {d.documents.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium mb-1">Paperwork</p>
          <ul className="space-y-1 text-muted-foreground">
            {d.documents.map((doc) => (
              <li key={doc.id}>
                {doc.fileName}{" "}
                <span className="text-xs">
                  ({doc.docType.replace(/_/g, " ")})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {d.status === "submitted" ? (
          <>
            <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
              Accept
            </Button>
            <Button intent="secondary" onClick={() => setDeclining((v) => !v)}>
              Decline
            </Button>
          </>
        ) : null}
        {d.status === "accepted" ? (
          <Button
            onClick={() => advance.mutate("in_progress")}
            disabled={advance.isPending}
          >
            Mark in progress
          </Button>
        ) : null}
        {d.status === "accepted" || d.status === "in_progress" ? (
          <Button
            intent="secondary"
            onClick={() => advance.mutate("dispensed")}
            disabled={advance.isPending}
          >
            Mark dispensed
          </Button>
        ) : null}
      </div>

      {accept.isError ? (
        <ErrorPanel title="Couldn't accept it" error={accept.error} />
      ) : null}
      {advance.isError ? (
        <ErrorPanel title="Couldn't update it" error={advance.error} />
      ) : null}

      {declining ? (
        <div className="space-y-2">
          <label className="text-sm font-medium block" htmlFor={`why-${id}`}>
            Why are you sending it back?
          </label>
          <p className="text-xs text-muted-foreground">
            This goes straight to the referring provider, so write it for them.
          </p>
          <textarea
            id={`why-${id}`}
            className="w-full text-sm border rounded p-2"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. we're out of network for this payer — try a supplier contracted with them"
          />
          {decline.isError ? (
            <ErrorPanel title="Couldn't decline it" error={decline.error} />
          ) : null}
          <div className="flex gap-2">
            <Button
              onClick={() => decline.mutate()}
              disabled={reason.trim().length < 10 || decline.isPending}
            >
              Send it back
            </Button>
            <Button intent="secondary" onClick={() => setDeclining(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <p className="text-sm font-medium flex items-center gap-1.5 mb-2">
          <MessageSquare size={14} aria-hidden="true" />
          Messages
        </p>
        {d.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Anything you send reaches the referring provider
            directly.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {d.messages.map((m) => (
              <li
                key={m.id}
                className={`rounded px-3 py-2 ${
                  m.authorKind === "staff" ? "bg-slate-100" : "bg-blue-50"
                }`}
              >
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {m.authorKind === "staff"
                    ? "Your team"
                    : "Referring provider"}{" "}
                  · {formatDateTime(m.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 text-sm border rounded px-2 h-9"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to the provider…"
            aria-label="Reply to the referring provider"
          />
          <Button
            onClick={() => message.mutate()}
            disabled={!reply.trim() || message.isPending}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which referring providers may send here.
 *
 * This is an access-control list, not a directory: a provider with no
 * active link cannot direct a referral at this organization at all. So
 * revoking is presented as what it is — cutting off inbound referrals —
 * rather than as a soft "hide from list".
 */
function ProviderLinks() {
  const queryClient = useQueryClient();
  const key = [...QUERY_KEY, "providers"] as const;
  const links = useQuery({ queryKey: key, queryFn: fetchProviderLinks });
  const update = useMutation({
    mutationFn: (input: {
      id: string;
      status: "active" | "suspended" | "revoked";
    }) => updateProviderLink(input.id, { status: input.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <Card>
      <div className="p-4">
        <h2 className="font-medium">Referring providers</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Only providers listed here as active can send you referrals. Revoking
          one stops any new referrals from them immediately; ones already in
          your queue are unaffected.
        </p>
        {links.isLoading ? <Spinner /> : null}
        {links.isError ? (
          <ErrorPanel title="Couldn't load providers" error={links.error} />
        ) : null}
        {links.data && links.data.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No referring providers linked yet.
          </p>
        ) : null}
        <ul className="space-y-2">
          {(links.data?.links ?? []).map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 border rounded px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">
                  {l.displayName ?? l.providerId}
                </p>
                <p className="text-xs text-muted-foreground">
                  {l.status} · linked {formatDateTime(l.invitedAt)}
                </p>
              </div>
              {l.status === "active" ? (
                <Button
                  intent="secondary"
                  onClick={() => update.mutate({ id: l.id, status: "revoked" })}
                  disabled={update.isPending}
                >
                  Stop referrals
                </Button>
              ) : (
                <Button
                  intent="secondary"
                  onClick={() => update.mutate({ id: l.id, status: "active" })}
                  disabled={update.isPending}
                >
                  Allow referrals
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default AdminReferralsPage;
