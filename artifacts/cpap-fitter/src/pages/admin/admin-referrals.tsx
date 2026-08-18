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
import { Download, Inbox, MessageSquare, UserCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatDateTime } from "@/lib/admin/format";
import {
  acceptReferral,
  createProviderLink,
  declineReferral,
  fetchInboundReferral,
  fetchInboundReferrals,
  fetchProviderLinks,
  inboundDocumentUrl,
  INBOUND_STATUS_LABEL,
  replyToReferral,
  setReferralStatus,
  updateProviderLink,
  type InboundReferral,
  type InboundReferralDetail,
  type ReferralStatus,
} from "@/lib/admin/referrals-api";
import {
  listProviders,
  type ProviderListItem,
} from "@/lib/admin/providers-api";
import { searchPatients } from "@/lib/admin/outreach-playbooks-api";

const QUERY_KEY = ["admin", "referrals"] as const;

const FILTERS: Array<{ key: string; label: string; status?: ReferralStatus }> =
  [
    { key: "open", label: "Needs action" },
    { key: "submitted", label: "New", status: "submitted" },
    { key: "accepted", label: "Accepted", status: "accepted" },
    { key: "in_progress", label: "In progress", status: "in_progress" },
    { key: "dispensed", label: "Dispensed", status: "dispensed" },
    { key: "declined", label: "Declined", status: "declined" },
    // A provider can withdraw a referral the DME is already working. That
    // drops it out of the open queue, so without this filter staff would
    // simply never learn it was withdrawn and could keep going toward
    // dispense.
    { key: "cancelled", label: "Withdrawn", status: "cancelled" },
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
  const [chartId, setChartId] = useState<string | null>(null);

  const accept = useMutation({
    // Accepting onto a chart is the whole point of matching: everything
    // downstream — orders, resupply, messaging — hangs off `patient_id`,
    // and a referral accepted unmatched has to be reconciled by hand
    // later. Optional, though: a genuinely new patient has no chart yet.
    mutationFn: () => acceptReferral(id, { patientId: chartId }),
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
            {d.approval.maskName ?? "Approved mask (not resolvable)"}
            {d.approval.sizeLabel ? ` · size ${d.approval.sizeLabel}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {d.approval.interfaceType
              ? `${d.approval.interfaceType.replace(/_/g, " ")} · `
              : ""}
            approved by the referring provider
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
          <ul className="space-y-1">
            {d.documents.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2">
                <a
                  href={inboundDocumentUrl(d.id, doc.id)}
                  className="inline-flex items-center gap-1.5 underline underline-offset-2"
                >
                  <Download size={14} aria-hidden="true" />
                  {doc.fileName}
                </a>
                <span className="text-xs text-muted-foreground">
                  ({doc.docType.replace(/_/g, " ")})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.status === "submitted" ? (
        <ChartMatch
          referral={d}
          selectedPatientId={chartId}
          onSelect={setChartId}
        />
      ) : d.patient.chartId ? (
        <p className="text-sm text-muted-foreground">
          Working on an existing chart.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {d.status === "submitted" ? (
          <>
            <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
              {chartId ? "Accept onto this chart" : "Accept"}
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

  const linkedIds = new Set(
    (links.data?.links ?? [])
      .filter((l) => l.status === "active")
      .map((l) => l.providerId),
  );

  return (
    <Card>
      <div className="p-4">
        <h2 className="font-medium">Referring providers</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Only providers listed here as active can send you referrals. Revoking
          one stops any new referrals from them immediately; ones already in
          your queue are unaffected.
        </p>

        <AuthorizeProviderForm
          linkedProviderIds={linkedIds}
          onAuthorized={() => {
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />

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

/**
 * Match an inbound referral to an existing chart before accepting it.
 *
 * The referral arrives with demographics typed by the referring practice
 * and no `patient_id` — the sender has no visibility of this tenant's
 * charts. Matching at accept time is what keeps a returning patient from
 * ending up with a second record: everything downstream (orders,
 * resupply, messaging) hangs off `patient_id`, so an unmatched accept is
 * reconciliation work later.
 *
 * Optional on purpose. A genuinely new patient has no chart to match, and
 * blocking accept on one would just teach staff to create a chart before
 * they have consent to.
 */
function ChartMatch({
  referral,
  selectedPatientId,
  onSelect,
}: {
  referral: InboundReferralDetail;
  selectedPatientId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [term, setTerm] = useState(referral.patient.lastName ?? "");
  const [submitted, setSubmitted] = useState("");

  const results = useQuery({
    queryKey: [...QUERY_KEY, "chart-search", submitted],
    queryFn: () => searchPatients(submitted),
    enabled: submitted.trim().length > 1,
  });

  const hits = results.data ?? [];
  const chosen = hits.find((p) => p.id === selectedPatientId) ?? null;

  return (
    <div className="rounded border p-3 text-sm space-y-2">
      <p className="font-medium">Match to a chart (optional)</p>
      <p className="text-xs text-muted-foreground">
        {referral.patient.firstName} {referral.patient.lastName}
        {referral.patient.dob ? `, DOB ${referral.patient.dob}` : ""} — search
        your charts to link them, or accept without matching and link later.
      </p>

      {selectedPatientId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">
            {chosen
              ? `${chosen.firstName} ${chosen.lastName}`
              : "Chart selected"}
          </Badge>
          <Button intent="ghost" onClick={() => onSelect(null)}>
            Clear
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(term.trim());
          }}
        >
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Name, phone, or PacWare ID"
            aria-label="Search charts"
            className="flex-1 min-w-[12rem] rounded border px-3 py-1.5 text-sm"
          />
          <Button intent="secondary" type="submit">
            Search
          </Button>
        </form>
      )}

      {results.isError ? (
        <ErrorPanel title="Chart search failed" error={results.error} />
      ) : null}
      {!selectedPatientId && submitted && !results.isLoading ? (
        hits.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No chart matches. Accept without matching and a chart can be linked
            once one exists.
          </p>
        ) : (
          <ul className="space-y-1">
            {hits.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className="w-full rounded border px-3 py-1.5 text-left hover:bg-muted"
                >
                  {p.firstName} {p.lastName}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * Authorize a provider from the practice registry to refer here.
 *
 * This is the ONLY way a link gets created, and a link is what stands
 * between the global provider directory and unsolicited PHI in this
 * queue — so it is a deliberate search-then-authorize, not a free-text
 * field. Search runs against `/admin/providers`, the same registry the
 * Providers page manages; a clinician who isn't in it yet has to be added
 * there first (with an NPI), which is the point: you can't grant referral
 * rights to someone you haven't identified.
 */
function AuthorizeProviderForm({
  linkedProviderIds,
  onAuthorized,
}: {
  linkedProviderIds: Set<string>;
  onAuthorized: () => void;
}) {
  const [term, setTerm] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const results = useQuery({
    queryKey: [...QUERY_KEY, "provider-directory", submitted],
    queryFn: () => listProviders(submitted, { limit: 8 }),
    enabled: submitted.trim().length > 0,
  });

  const authorize = useMutation({
    mutationFn: (p: ProviderListItem) =>
      createProviderLink({ providerId: p.id, displayName: p.legalName }),
    onSuccess: (_data, p) => {
      setJustAdded(p.legalName);
      onAuthorized();
    },
  });

  const found = results.data?.providers ?? [];

  return (
    <div className="mb-4 rounded border bg-muted/30 p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setJustAdded(null);
          setSubmitted(term.trim());
        }}
      >
        <div className="flex-1 min-w-[16rem]">
          <label
            htmlFor="referral-provider-search"
            className="block text-sm font-medium mb-1"
          >
            Authorize a provider to refer here
          </label>
          <input
            id="referral-provider-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Provider name or 10-digit NPI"
            className="w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <Button type="submit" disabled={term.trim().length === 0}>
          Search
        </Button>
      </form>

      {authorize.isError ? (
        <ErrorPanel
          title="Couldn't authorize that provider"
          error={authorize.error}
        />
      ) : null}
      {justAdded ? (
        <p className="mt-2 text-sm text-emerald-700">
          {justAdded} can now send you referrals.
        </p>
      ) : null}

      {results.isLoading ? <Spinner /> : null}
      {results.isError ? (
        <ErrorPanel title="Provider search failed" error={results.error} />
      ) : null}
      {submitted && !results.isLoading && found.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No provider in your registry matches that. Add them under Providers
          first — a referral link needs a verified NPI.
        </p>
      ) : null}

      {found.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {found.map((p) => {
            const already = linkedProviderIds.has(p.id);
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{p.legalName}</p>
                  <p className="text-xs text-muted-foreground">
                    NPI {p.npi}
                    {p.practiceName ? ` · ${p.practiceName}` : ""}
                  </p>
                </div>
                {already ? (
                  <Badge variant="success">Already authorized</Badge>
                ) : (
                  <Button
                    intent="secondary"
                    onClick={() => authorize.mutate(p)}
                    disabled={authorize.isPending}
                  >
                    Allow referrals
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export default AdminReferralsPage;
