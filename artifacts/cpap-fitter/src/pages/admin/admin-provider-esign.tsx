// /admin/provider-portal — employee console for the provider
// e-signature portal.
//
// Two tabs:
//   * Provider accounts — invite a provider into the portal, see their
//     status / MFA / last login, enable/disable access, and print the
//     full signature audit log for a provider.
//   * Documents — stage documents for signature, track each one through
//     the post-signature lifecycle (ready-to-print → returned-signed →
//     attached-to-chart → released), remind, void, and download the
//     per-document signature certificate.
//
// Gated server-side by requirePermission("provider_portal.manage").

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  FileText,
  Printer,
  Mail,
  ShieldCheck,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Select, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { EmptyState } from "@/components/admin/EmptyState";
import { AdminModal } from "@/components/admin/AdminModal";
import {
  listProviders,
  type ProviderListItem,
} from "@/lib/admin/providers-api";
import {
  listProviderAccounts,
  inviteProviderAccount,
  disableProviderAccount,
  enableProviderAccount,
  listSignatureRequests,
  createSignatureRequest,
  voidSignatureRequest,
  markReadyToPrint,
  markReturnedSigned,
  markAttachedToChart,
  releaseSignatureRequest,
  remindSignatureRequest,
  certificatePdfUrl,
  providerSignatureLogUrl,
  type SignatureRequest,
  type SubjectType,
} from "@/lib/admin/provider-esign-api";

const SUBJECT_OPTIONS: { value: SubjectType; label: string }[] = [
  { value: "prescription", label: "Prescription" },
  { value: "prescription_packet", label: "Prescription request" },
  { value: "order", label: "Order" },
  { value: "claim", label: "Insurance claim" },
  { value: "cmn", label: "Certificate of Medical Necessity (CMN)" },
  { value: "dwo", label: "Detailed Written Order (DWO)" },
  { value: "swo", label: "Standard Written Order (SWO)" },
  { value: "document", label: "Other document" },
];

function statusVariant(status: string) {
  switch (status) {
    case "pending":
      return "warning" as const;
    case "signed":
      return "success" as const;
    case "declined":
      return "danger" as const;
    default:
      return "muted" as const;
  }
}

function fmt(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Reusable provider search + select used by the invite + create modals. */
function ProviderPicker({
  selected,
  onSelect,
}: {
  selected: ProviderListItem | null;
  onSelect: (p: ProviderListItem | null) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["admin", "provider-picker", search],
    queryFn: () => listProviders(search, { limit: 8, offset: 0 }),
    enabled: search.trim().length >= 2 && !selected,
  });
  if (selected) {
    return (
      <div
        className="flex items-center justify-between rounded-md border px-3 py-2"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <div>
          <p
            className="text-sm font-medium"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {selected.legalName}
          </p>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            NPI {selected.npi}
            {selected.email ? ` · ${selected.email}` : ""}
          </p>
        </div>
        <Button intent="ghost" size="sm" onClick={() => onSelect(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-2 h-4 w-4"
          style={{ color: "hsl(var(--ink-3))" }}
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search providers by name or NPI…"
          className="pl-8"
        />
      </div>
      {search.trim().length >= 2 ? (
        <div
          className="mt-2 max-h-48 overflow-y-auto rounded-md border"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {query.isPending ? (
            <p
              className="px-3 py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Searching…
            </p>
          ) : query.data && query.data.providers.length > 0 ? (
            query.data.providers.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect(p)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/5"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {p.legalName}{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  · NPI {p.npi}
                </span>
              </button>
            ))
          ) : (
            <p
              className="px-3 py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              No matches.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderListItem | null>(null);
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{
    emailSent: boolean;
    inviteLink: string;
  } | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      inviteProviderAccount({
        providerId: provider!.id,
        email: email.trim() || undefined,
      }),
    onSuccess: (r) => {
      setResult({ emailSent: r.emailSent, inviteLink: r.inviteLink });
      void qc.invalidateQueries({ queryKey: ["admin", "provider-accounts"] });
    },
  });
  return (
    <AdminModal title="Invite a provider" onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
            {result.emailSent
              ? "Invitation email sent. The provider will set a password, then enroll in two-factor on first sign-in."
              : "Account created, but the email could not be sent. Share this set-password link with the provider directly:"}
          </p>
          {!result.emailSent && result.inviteLink ? (
            <code
              className="block break-all rounded-md border p-2 text-xs"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {result.inviteLink}
            </code>
          ) : null}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <Label htmlFor="prov">Provider</Label>
            <ProviderPicker selected={provider} onSelect={setProvider} />
          </div>
          <div>
            <Label htmlFor="email">Email (optional override)</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={
                provider?.email ?? "Uses the provider's email on file"
              }
            />
          </div>
          {mut.isError ? (
            <p className="text-xs text-red-600">
              Could not send the invitation. Check the provider has an email.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button intent="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => mut.mutate()}
              isLoading={mut.isPending}
              disabled={!provider}
            >
              Send invitation
            </Button>
          </div>
        </div>
      )}
    </AdminModal>
  );
}

function CreateRequestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderListItem | null>(null);
  const [subjectType, setSubjectType] = useState<SubjectType>("prescription");
  const [title, setTitle] = useState("");
  const [patientName, setPatientName] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      createSignatureRequest({
        providerId: provider!.id,
        subjectType,
        title: title.trim(),
        patientName: patientName.trim() || undefined,
        subjectId: subjectId.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "signature-requests"] });
      onClose();
    },
  });
  return (
    <AdminModal title="New signature request" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="prov2">Provider</Label>
          <ProviderPicker selected={provider} onSelect={setProvider} />
        </div>
        <div>
          <Label htmlFor="subjectType">Document type</Label>
          <Select
            id="subjectType"
            value={subjectType}
            onChange={(e) => setSubjectType(e.target.value as SubjectType)}
            options={SUBJECT_OPTIONS}
          />
        </div>
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. CPAP resupply order — mask + tubing"
          />
        </div>
        <div>
          <Label htmlFor="patient">Patient name (optional)</Label>
          <Input
            id="patient"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="subjectId">Linked record ID (optional)</Label>
          <Input
            id="subjectId"
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            placeholder="Order / claim / prescription ID for reference"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button intent="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            isLoading={mut.isPending}
            disabled={!provider || title.trim().length < 2}
          >
            Create &amp; send to provider
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

function ReleaseModal({
  request,
  onClose,
}: {
  request: SignatureRequest;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"claim" | "item">(
    request.subjectType === "claim" ? "claim" : "item",
  );
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      releaseSignatureRequest(request.id, {
        releaseKind: kind,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "signature-requests"] });
      onClose();
    },
  });
  return (
    <AdminModal title="Release signed document" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Mark this signed document as released so the team can submit the claim
          or fulfill the item.
        </p>
        <div>
          <Label htmlFor="kind">Release as</Label>
          <Select
            id="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "claim" | "item")}
            options={[
              {
                value: "claim",
                label: "Release the claim (clear for billing)",
              },
              {
                value: "item",
                label: "Release the item (clear for fulfillment)",
              },
            ]}
          />
        </div>
        <div>
          <Label htmlFor="note">Note (optional)</Label>
          <Input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button intent="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} isLoading={mut.isPending}>
            Release
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

function AccountsTab() {
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const query = useQuery({
    queryKey: ["admin", "provider-accounts"],
    queryFn: listProviderAccounts,
  });
  const disable = useMutation({
    mutationFn: disableProviderAccount,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["admin", "provider-accounts"] }),
  });
  const enable = useMutation({
    mutationFn: enableProviderAccount,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["admin", "provider-accounts"] }),
  });

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setInviting(true)}>
          <Plus className="h-4 w-4" /> Invite provider
        </Button>
      </div>
      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.accounts.length === 0 ? (
        <Card>
          <EmptyState
            title="No providers have portal access yet."
            hint="Invite a provider to let them e-sign their patients' documents."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">2FA</th>
                  <th className="px-4 py-2 font-medium">Last sign-in</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.accounts.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td className="px-4 py-2.5">
                      <p
                        className="font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {a.providerName ?? "—"}
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {a.providerNpi ? `NPI ${a.providerNpi} · ` : ""}
                        {a.email}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          a.status === "active"
                            ? "success"
                            : a.status === "disabled"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {a.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {a.mfaEnrolled ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                          <ShieldCheck className="h-3.5 w-3.5" /> On
                        </span>
                      ) : (
                        <span
                          className="text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          Not set up
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-2.5 text-xs"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {fmt(a.lastLoginAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          intent="ghost"
                          size="sm"
                          onClick={() =>
                            window.open(
                              providerSignatureLogUrl(a.providerId),
                              "_blank",
                            )
                          }
                        >
                          <Printer className="h-3.5 w-3.5" /> Log
                        </Button>
                        {a.status === "disabled" ? (
                          <Button
                            intent="ghost"
                            size="sm"
                            onClick={() => enable.mutate(a.id)}
                          >
                            Enable
                          </Button>
                        ) : (
                          <Button
                            intent="ghost"
                            size="sm"
                            onClick={() => disable.mutate(a.id)}
                          >
                            Disable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {inviting ? <InviteModal onClose={() => setInviting(false)} /> : null}
    </>
  );
}

function DocumentsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<SignatureRequest | null>(null);
  const query = useQuery({
    queryKey: ["admin", "signature-requests", status],
    queryFn: () =>
      listSignatureRequests({ status: status === "all" ? undefined : status }),
  });

  const onSuccess = () =>
    qc.invalidateQueries({ queryKey: ["admin", "signature-requests"] });

  const voidM = useMutation({ mutationFn: voidSignatureRequest, onSuccess });
  const readyM = useMutation({ mutationFn: markReadyToPrint, onSuccess });
  const returnedM = useMutation({ mutationFn: markReturnedSigned, onSuccess });
  const attachM = useMutation({ mutationFn: markAttachedToChart, onSuccess });
  const remindM = useMutation({
    mutationFn: remindSignatureRequest,
    onSuccess,
  });

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="w-48">
          <Label htmlFor="statusFilter">Status</Label>
          <Select
            id="statusFilter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: "all", label: "All" },
              { value: "pending", label: "Awaiting signature" },
              { value: "signed", label: "Signed" },
              { value: "declined", label: "Declined" },
              { value: "void", label: "Void" },
            ]}
          />
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New request
        </Button>
      </div>

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.requests.length === 0 ? (
        <Card>
          <EmptyState
            title="No signature requests match this filter."
            hint="Create one to send a document to a provider for e-signature."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="px-4 py-2 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Lifecycle</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.requests.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t align-top"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td className="px-4 py-2.5">
                      <p
                        className="font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {r.title}
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {r.subjectType}
                        {r.patientName ? ` · ${r.patientName}` : ""} ·{" "}
                        {fmt(r.createdAt)}
                      </p>
                    </td>
                    <td
                      className="px-4 py-2.5 text-xs"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {r.providerName ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={statusVariant(r.status)}>
                        {r.status}
                      </Badge>
                    </td>
                    <td
                      className="px-4 py-2.5 text-xs"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {r.status === "signed" ? (
                        <div className="space-y-0.5">
                          <div>Signed {fmt(r.signedAt)}</div>
                          {r.readyToPrintAt ? (
                            <div>✓ Ready to print</div>
                          ) : null}
                          {r.returnedSignedAt ? (
                            <div>✓ Returned signed</div>
                          ) : null}
                          {r.attachedToChartAt ? (
                            <div>✓ Attached to chart</div>
                          ) : null}
                          {r.releasedAt ? (
                            <div>✓ Released ({r.releaseKind})</div>
                          ) : null}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap justify-end gap-1">
                        {r.status === "pending" ? (
                          <>
                            <Button
                              intent="ghost"
                              size="sm"
                              onClick={() => remindM.mutate(r.id)}
                            >
                              <Mail className="h-3.5 w-3.5" /> Remind
                            </Button>
                            <Button
                              intent="ghost"
                              size="sm"
                              onClick={() => voidM.mutate(r.id)}
                            >
                              Void
                            </Button>
                          </>
                        ) : null}
                        {r.status === "signed" ? (
                          <>
                            <Button
                              intent="ghost"
                              size="sm"
                              onClick={() =>
                                window.open(certificatePdfUrl(r.id), "_blank")
                              }
                            >
                              <FileText className="h-3.5 w-3.5" /> Certificate
                            </Button>
                            {!r.readyToPrintAt ? (
                              <Button
                                intent="ghost"
                                size="sm"
                                onClick={() => readyM.mutate(r.id)}
                              >
                                Ready to print
                              </Button>
                            ) : null}
                            {!r.returnedSignedAt ? (
                              <Button
                                intent="ghost"
                                size="sm"
                                onClick={() => returnedM.mutate(r.id)}
                              >
                                Returned signed
                              </Button>
                            ) : null}
                            {!r.attachedToChartAt ? (
                              <Button
                                intent="ghost"
                                size="sm"
                                onClick={() => attachM.mutate(r.id)}
                              >
                                Attach to chart
                              </Button>
                            ) : null}
                            {!r.releasedAt ? (
                              <Button
                                intent="secondary"
                                size="sm"
                                onClick={() => setReleasing(r)}
                              >
                                Release
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {creating ? (
        <CreateRequestModal onClose={() => setCreating(false)} />
      ) : null}
      {releasing ? (
        <ReleaseModal request={releasing} onClose={() => setReleasing(null)} />
      ) : null}
    </>
  );
}

export function AdminProviderEsignPage() {
  const [tab, setTab] = useState<"accounts" | "documents">("documents");
  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Provider e-signature portal
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Stage documents for providers to e-sign, track signed items through
          release, and print the Medicare/insurer-ready signature audit log.
        </p>
      </header>

      <div
        className="inline-flex rounded-lg border p-1"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        {(["documents", "accounts"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="rounded-md px-3.5 py-1.5 text-sm font-medium capitalize"
            style={
              tab === t
                ? { backgroundColor: "hsl(var(--penn-navy))", color: "#fff" }
                : { color: "hsl(var(--ink-2))" }
            }
          >
            {t === "documents" ? "Documents" : "Provider accounts"}
          </button>
        ))}
      </div>

      {tab === "documents" ? <DocumentsTab /> : <AccountsTab />}
    </div>
  );
}
