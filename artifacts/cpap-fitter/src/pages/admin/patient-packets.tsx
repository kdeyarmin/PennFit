import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListPatients,
  getListPatientsQueryKey,
  usePatientPacketTemplates,
  useAllPatientPackets,
  usePatientPacket,
  useSendPatientPacket,
  useSendPacketToContact,
  useResendPatientPacket,
  useVoidPatientPacket,
  getAllPatientPacketsQueryKey,
  getPatientPacketQueryKey,
  patientPacketPdfUrl,
  type PatientPacketSummary,
  type PatientPacketStatus,
  type PatientPacketTemplate,
} from "@workspace/api-client-react/admin";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Input, Label, Select } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { useDocumentTitle } from "@/hooks/use-document-title";

type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const STATUS_VARIANT: Record<PatientPacketStatus, BadgeVariant> = {
  draft: "muted",
  sent: "info",
  viewed: "info",
  completed: "success",
  voided: "danger",
  expired: "warning",
};

const STATUS_LABEL: Record<PatientPacketStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Opened",
  completed: "Signed",
  voided: "Voided",
  expired: "Expired",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function AdminPatientPacketsPage() {
  useDocumentTitle("Document packets");
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showSend, setShowSend] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const packetsQuery = useAllPatientPackets(statusFilter || undefined);
  const packets = packetsQuery.data?.packets ?? [];

  const refreshList = () =>
    qc.invalidateQueries({
      queryKey: getAllPatientPacketsQueryKey(statusFilter || undefined),
    });

  return (
    <div className="admin-root">
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-xl font-bold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Document packets
            </h1>
            <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              Send new-patient document packets for electronic signature and
              track who has signed.
            </p>
          </div>
          <Button onClick={() => setShowSend((s) => !s)}>
            {showSend ? "Close" : "Send new packet"}
          </Button>
        </div>

        {showSend && (
          <SendPacketPanel
            onSent={() => {
              void refreshList();
            }}
            onClose={() => setShowSend(false)}
          />
        )}

        {selectedId && (
          <PacketDetailPanel
            packetId={selectedId}
            onClose={() => setSelectedId(null)}
            onChanged={() => void refreshList()}
          />
        )}

        <Card
          title="Recent packets"
          action={
            <div className="flex items-center gap-2">
              <Label htmlFor="statusFilter">
                <span className="sr-only">Filter by status</span>
              </Label>
              <Select
                id="statusFilter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                emptyOptionLabel="All statuses"
                options={[
                  { value: "sent", label: "Sent" },
                  { value: "viewed", label: "Opened" },
                  { value: "completed", label: "Signed" },
                  { value: "voided", label: "Voided" },
                  { value: "expired", label: "Expired" },
                ]}
              />
            </div>
          }
        >
          {packetsQuery.isPending ? (
            <div className="p-6">
              <Spinner label="Loading packets…" />
            </div>
          ) : packetsQuery.isError ? (
            <div className="p-4">
              <ErrorPanel error={packetsQuery.error} />
            </div>
          ) : packets.length === 0 ? (
            <EmptyState
              title="No packets yet"
              hint="Send a new patient document packet to get started."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    <th className="px-5 py-2 font-medium">Recipient</th>
                    <th className="px-5 py-2 font-medium">Packet</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                    <th className="px-5 py-2 font-medium">Sent</th>
                    <th className="px-5 py-2 font-medium">Signed</th>
                    <th className="px-5 py-2 font-medium text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {packets.map((p: PatientPacketSummary) => (
                    <tr
                      key={p.id}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td className="px-5 py-3">
                        <div
                          className="font-medium"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {p.recipient_name}
                        </div>
                        {p.recipient_email && (
                          <div
                            className="text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {p.recipient_email}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {p.title}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={STATUS_VARIANT[p.status]}>
                          {STATUS_LABEL[p.status]}
                        </Badge>
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {fmtDate(p.sent_at)}
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {fmtDate(p.completed_at)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        {p.status === "completed" && (
                          <a
                            href={patientPacketPdfUrl(p.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold mr-3"
                            style={{ color: "hsl(var(--penn-navy))" }}
                          >
                            PDF
                          </a>
                        )}
                        <Button
                          intent="ghost"
                          size="sm"
                          onClick={() => setSelectedId(p.id)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Send packet panel ─────────────────────────────────────────────
function SendPacketPanel({
  onSent,
  onClose,
}: {
  onSent: () => void;
  onClose: () => void;
}) {
  const templatesQuery = usePatientPacketTemplates();
  const templates = templatesQuery.data?.templates ?? [];

  // "patient" = pick an existing patient; "contact" = type an email /
  // phone with no patient selected (auto-files to a chart if it matches).
  const [mode, setMode] = useState<"patient" | "contact">("patient");
  const [search, setSearch] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<{
    id: string;
    name: string;
    hasEmail: boolean;
    hasPhone: boolean;
  } | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [useEmail, setUseEmail] = useState(true);
  const [useSms, setUseSms] = useState(true);
  const [title, setTitle] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [result, setResult] = useState<{
    link: string;
    emailSent: boolean;
    smsSent: boolean;
    // Populated only for contact sends, to report chart linkage.
    contact?: {
      matchedId: string | null;
      matchedName: string | null;
      ambiguous: boolean;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patientSearchParams = { search: search.trim(), limit: 8 };
  const patientsQuery = useListPatients(patientSearchParams, {
    query: {
      enabled: mode === "patient" && search.trim().length >= 2,
      queryKey: getListPatientsQueryKey(patientSearchParams),
    },
  });

  const send = useSendPatientPacket();
  const sendContact = useSendPacketToContact();

  // Seed the selection with the default-included documents once the
  // template catalog loads (react-query's data ref is stable, so this
  // runs once).
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    const list = templatesQuery.data?.templates;
    if (!seeded && list && list.length > 0) {
      const init: Record<string, boolean> = {};
      for (const t of list) init[t.key] = t.defaultIncluded;
      setSelectedKeys(init);
      setSeeded(true);
    }
  }, [templatesQuery.data, seeded]);

  const chosen = templates.filter((t) => selectedKeys[t.key]);

  const toggleKey = (key: string) =>
    setSelectedKeys({ ...selectedKeys, [key]: !selectedKeys[key] });

  const handleSend = async () => {
    setError(null);
    setResult(null);
    if (chosen.length === 0) {
      setError("Select at least one document.");
      return;
    }
    try {
      if (mode === "patient") {
        if (!selectedPatient) {
          setError("Select a patient first.");
          return;
        }
        const channels: ("email" | "sms")[] = [];
        if (useEmail) channels.push("email");
        if (useSms) channels.push("sms");
        if (channels.length === 0) {
          setError("Choose at least one delivery channel (email or text).");
          return;
        }
        const res = await send.mutateAsync({
          patientId: selectedPatient.id,
          data: {
            documentKeys: chosen.map((t) => t.key),
            title: title.trim() || undefined,
            recipientEmail: recipientEmail.trim() || undefined,
            recipientPhone: recipientPhone.trim() || undefined,
            channels,
          },
        });
        setResult({
          link: res.signingLink,
          emailSent: res.emailSent,
          smsSent: res.smsSent,
        });
      } else {
        const email = contactEmail.trim();
        const phone = contactPhone.trim();
        if (!email && !phone) {
          setError("Enter an email address or a phone number.");
          return;
        }
        // Channels follow whatever the operator typed: email it when
        // there's an email, text it when there's a number.
        const channels: ("email" | "sms")[] = [];
        if (email) channels.push("email");
        if (phone) channels.push("sms");
        const res = await sendContact.mutateAsync({
          email: email || undefined,
          phone: phone || undefined,
          recipientName: contactName.trim() || undefined,
          documentKeys: chosen.map((t) => t.key),
          title: title.trim() || undefined,
          channels,
        });
        setResult({
          link: res.signingLink,
          emailSent: res.emailSent,
          smsSent: res.smsSent,
          contact: {
            matchedId: res.matchedPatientId,
            matchedName: res.matchedPatientName,
            ambiguous: res.matchAmbiguous,
          },
        });
      }
      onSent();
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to send packet.");
    }
  };

  return (
    <Card
      title="Send a new patient packet"
      subtitle="Send to a patient on file, or straight to an email or phone number."
    >
      <div className="p-5 space-y-5">
        {result ? (
          <div className="space-y-3">
            <div
              className="rounded-md p-3 text-sm"
              style={{
                backgroundColor: "hsl(142 70% 45% / 0.10)",
                color: "hsl(142 60% 25%)",
              }}
            >
              Packet created.{" "}
              {result.emailSent && result.smsSent
                ? "Emailed and texted the signing link."
                : result.emailSent
                  ? "Emailed the signing link."
                  : result.smsSent
                    ? "Texted the signing link."
                    : "No message was sent — share the secure link below directly."}
            </div>
            {result.contact &&
              (result.contact.matchedId ? (
                <div
                  className="rounded-md p-3 text-sm"
                  style={{
                    backgroundColor: "hsl(142 70% 45% / 0.10)",
                    color: "hsl(142 60% 25%)",
                  }}
                >
                  Filed to{" "}
                  <strong>{result.contact.matchedName ?? "the patient"}</strong>
                  ’s chart — the signed documents will appear there.
                </div>
              ) : result.contact.ambiguous ? (
                <div
                  className="rounded-md p-3 text-sm"
                  style={{
                    backgroundColor: "hsl(38 92% 50% / 0.12)",
                    color: "hsl(30 70% 30%)",
                  }}
                >
                  More than one patient matches this contact, so it wasn’t filed
                  to a chart automatically. Open the right patient and attach it
                  by hand if needed.
                </div>
              ) : (
                <div
                  className="rounded-md p-3 text-sm"
                  style={{
                    backgroundColor: "hsl(215 16% 47% / 0.12)",
                    color: "hsl(215 25% 27%)",
                  }}
                >
                  No matching patient on file — this packet isn’t linked to a
                  chart.
                </div>
              ))}
            <div>
              <Label htmlFor="signlink">Secure signing link</Label>
              <div className="flex gap-2">
                <Input id="signlink" readOnly value={result.link} />
                <Button
                  intent="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(result.link);
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setResult(null);
                  setSelectedPatient(null);
                  setSearch("");
                  setTitle("");
                  setRecipientEmail("");
                  setRecipientPhone("");
                  setContactName("");
                  setContactEmail("");
                  setContactPhone("");
                }}
              >
                Send another
              </Button>
              <Button intent="ghost" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Recipient mode */}
            <div>
              <div
                id="recipientModeLabel"
                className="block text-xs font-semibold mb-1"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                Send to
              </div>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-labelledby="recipientModeLabel"
              >
                {(
                  [
                    ["patient", "A patient on file"],
                    ["contact", "An email or phone"],
                  ] as const
                ).map(([value, label]) => {
                  const active = mode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setMode(value);
                        setError(null);
                      }}
                      className="rounded-md border px-3 py-1.5 text-sm font-medium"
                      style={{
                        borderColor: active
                          ? "hsl(var(--penn-navy))"
                          : "hsl(var(--line-2))",
                        backgroundColor: active
                          ? "hsl(var(--penn-navy) / 0.08)"
                          : "white",
                        color: active
                          ? "hsl(var(--penn-navy-deep))"
                          : "hsl(var(--ink-3))",
                      }}
                    >
                      {active ? "✓ " : ""}
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {mode === "patient" ? (
              /* Patient picker */
              <div>
                <Label htmlFor="patientSearch">Patient</Label>
                {selectedPatient ? (
                  <div
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                    style={{ borderColor: "hsl(var(--line-2))" }}
                  >
                    <span style={{ color: "hsl(var(--ink-1))" }}>
                      {selectedPatient.name}
                      {!selectedPatient.hasEmail && (
                        <span
                          className="ml-2 text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          (no email on file)
                        </span>
                      )}
                    </span>
                    <Button
                      intent="ghost"
                      size="sm"
                      onClick={() => setSelectedPatient(null)}
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <>
                    <Input
                      id="patientSearch"
                      placeholder="Search by name or Pacware ID…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search.trim().length >= 2 && (
                      <div
                        className="mt-1 rounded-md border divide-y max-h-56 overflow-y-auto"
                        style={{ borderColor: "hsl(var(--line-1))" }}
                      >
                        {patientsQuery.isPending ? (
                          <div
                            className="px-3 py-2 text-sm"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            Searching…
                          </div>
                        ) : (patientsQuery.data?.items ?? []).length === 0 ? (
                          <div
                            className="px-3 py-2 text-sm"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            No matches.
                          </div>
                        ) : (
                          (patientsQuery.data?.items ?? []).map((pt) => (
                            <button
                              key={pt.id}
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                              style={{ color: "hsl(var(--ink-1))" }}
                              onClick={() => {
                                setSelectedPatient({
                                  id: pt.id,
                                  name: `${pt.firstName} ${pt.lastName}`.trim(),
                                  hasEmail: pt.hasEmail,
                                  hasPhone: pt.hasPhone,
                                });
                                // Default each channel on when the patient
                                // has a contact point of that kind on file.
                                setUseEmail(pt.hasEmail);
                                setUseSms(pt.hasPhone);
                              }}
                            >
                              {pt.firstName} {pt.lastName}
                              <span
                                className="ml-2 text-xs"
                                style={{ color: "hsl(var(--ink-3))" }}
                              >
                                {pt.pacwareId}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              /* Contact (email / phone) inputs */
              <div className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="contactName">Name (optional)</Label>
                    <Input
                      id="contactName"
                      placeholder="e.g. Jordan Smith"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="contactEmail">Email</Label>
                    <Input
                      id="contactEmail"
                      type="email"
                      placeholder="name@example.com"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="contactPhone">Mobile number</Label>
                    <Input
                      id="contactPhone"
                      type="tel"
                      placeholder="(215) 555-1234"
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                  We’ll send the signing link to whichever you enter. If the
                  email or number matches a patient on file, the signed
                  documents are filed to their chart automatically.
                </p>
              </div>
            )}

            {/* Document selection */}
            <div>
              <Label htmlFor="docs">Documents</Label>
              {templatesQuery.isPending ? (
                <Spinner label="Loading documents…" />
              ) : (
                <div className="space-y-2">
                  {templates.map((t: PatientPacketTemplate) => (
                    <label
                      key={t.key}
                      className="flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={t.required || Boolean(selectedKeys[t.key])}
                        disabled={t.required}
                        onChange={() => toggleKey(t.key)}
                      />
                      <span>
                        <span
                          className="font-medium text-sm"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {t.title}
                        </span>{" "}
                        {t.required ? (
                          <Badge variant="info">Required</Badge>
                        ) : !t.requiresSignature ? (
                          <Badge variant="muted">Informational</Badge>
                        ) : null}
                        <span
                          className="block text-xs mt-0.5"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {t.summary}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Title (both modes) */}
            <div>
              <Label htmlFor="packetTitle">Title (optional)</Label>
              <Input
                id="packetTitle"
                placeholder="New Patient Document Packet"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {mode === "patient" && (
              <>
                {/* Delivery channels */}
                <div>
                  <Label htmlFor="channels">Send the signing link via</Label>
                  <div className="flex flex-wrap gap-2" id="channels">
                    <button
                      type="button"
                      onClick={() => setUseEmail((v) => !v)}
                      className="rounded-md border px-3 py-1.5 text-sm font-medium"
                      style={{
                        borderColor: useEmail
                          ? "hsl(var(--penn-navy))"
                          : "hsl(var(--line-2))",
                        backgroundColor: useEmail
                          ? "hsl(var(--penn-navy) / 0.08)"
                          : "white",
                        color: useEmail
                          ? "hsl(var(--penn-navy-deep))"
                          : "hsl(var(--ink-3))",
                      }}
                    >
                      {useEmail ? "✓ " : ""}Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseSms((v) => !v)}
                      className="rounded-md border px-3 py-1.5 text-sm font-medium"
                      style={{
                        borderColor: useSms
                          ? "hsl(var(--penn-navy))"
                          : "hsl(var(--line-2))",
                        backgroundColor: useSms
                          ? "hsl(var(--penn-navy) / 0.08)"
                          : "white",
                        color: useSms
                          ? "hsl(var(--penn-navy-deep))"
                          : "hsl(var(--ink-3))",
                      }}
                    >
                      {useSms ? "✓ " : ""}Text message
                    </button>
                  </div>
                  {selectedPatient && !selectedPatient.hasEmail && useEmail && (
                    <p
                      className="mt-1 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      No email on file — enter one below to deliver by email.
                    </p>
                  )}
                  {selectedPatient && !selectedPatient.hasPhone && useSms && (
                    <p
                      className="mt-1 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      No phone on file — enter one below to deliver by text.
                    </p>
                  )}
                </div>

                {/* Optional contact overrides */}
                {(useEmail || useSms) && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {useEmail && (
                      <div>
                        <Label htmlFor="recipientEmail">
                          Send to email (optional)
                        </Label>
                        <Input
                          id="recipientEmail"
                          type="email"
                          placeholder="Defaults to email on file"
                          value={recipientEmail}
                          onChange={(e) => setRecipientEmail(e.target.value)}
                        />
                      </div>
                    )}
                    {useSms && (
                      <div>
                        <Label htmlFor="recipientPhone">
                          Send to phone (optional)
                        </Label>
                        <Input
                          id="recipientPhone"
                          type="tel"
                          placeholder="Defaults to phone on file (+1…)"
                          value={recipientPhone}
                          onChange={(e) => setRecipientPhone(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {error && (
              <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleSend}
                isLoading={send.isPending || sendContact.isPending}
                disabled={
                  chosen.length === 0 ||
                  (mode === "patient"
                    ? !selectedPatient
                    : !contactEmail.trim() && !contactPhone.trim())
                }
              >
                Send packet
              </Button>
              <Button intent="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ── Packet detail panel ───────────────────────────────────────────
function PacketDetailPanel({
  packetId,
  onClose,
  onChanged,
}: {
  packetId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const detailQuery = usePatientPacket(packetId);
  const resend = useResendPatientPacket();
  const voidPacket = useVoidPatientPacket();
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getPatientPacketQueryKey(packetId) });
    onChanged();
  };

  if (detailQuery.isPending) {
    return (
      <Card
        title="Packet detail"
        action={
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="p-6">
          <Spinner label="Loading…" />
        </div>
      </Card>
    );
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Card
        title="Packet detail"
        action={
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="p-4">
          <ErrorPanel error={detailQuery.error} />
        </div>
      </Card>
    );
  }

  const { packet, documents, signature, signingLink } = detailQuery.data;
  const closed = packet.status === "completed" || packet.status === "voided";

  return (
    <Card
      title={packet.title}
      subtitle={`For ${packet.recipient_name}`}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[packet.status as PatientPacketStatus]}>
            {STATUS_LABEL[packet.status as PatientPacketStatus]}
          </Badge>
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="p-5 space-y-5">
        {/* Signing link */}
        {signingLink && (
          <div>
            <Label htmlFor="detailLink">Secure signing link</Label>
            <div className="flex gap-2">
              <Input id="detailLink" readOnly value={signingLink} />
              <Button
                intent="secondary"
                onClick={() => void navigator.clipboard?.writeText(signingLink)}
              >
                Copy
              </Button>
            </div>
          </div>
        )}

        {/* Documents */}
        <div>
          <h3
            className="text-sm font-semibold mb-2"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            Documents ({documents.length})
          </h3>
          <ul className="space-y-1.5">
            {documents.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <span style={{ color: "hsl(var(--ink-1))" }}>{d.title}</span>
                <Badge variant={d.acknowledged ? "success" : "muted"}>
                  {d.acknowledged ? "Acknowledged" : "Pending"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>

        {/* Signature */}
        {signature && (
          <div
            className="rounded-md border p-3 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <h3
              className="font-semibold mb-1"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              Electronic signature
            </h3>
            <p style={{ color: "hsl(var(--ink-2))" }}>
              Signed by <strong>{signature.signer_name}</strong> (
              {signature.signer_relationship.replace(/_/g, " ")}) on{" "}
              {fmtDate(signature.signed_at)}.
            </p>
            <p className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              ESIGN consent: {signature.consent_esign ? "Yes" : "No"}
              {signature.signer_ip ? ` · IP ${signature.signer_ip}` : ""}
            </p>
          </div>
        )}

        {actionMsg && (
          <div className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            {actionMsg}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {packet.status === "completed" && (
            <a
              href={patientPacketPdfUrl(packet.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button intent="secondary">Download signed PDF</Button>
            </a>
          )}
          {!closed && (
            <Button
              intent="secondary"
              isLoading={resend.isPending}
              onClick={async () => {
                setActionMsg(null);
                try {
                  const res = await resend.mutateAsync({ packetId });
                  setActionMsg(
                    res.emailSent
                      ? "A fresh signing link was emailed to the patient."
                      : "A fresh link was issued. Copy it above to share.",
                  );
                  refresh();
                } catch (err) {
                  setActionMsg(describeError(err).detail ?? "Resend failed.");
                }
              }}
            >
              Resend link
            </Button>
          )}
          {packet.status !== "completed" && packet.status !== "voided" && (
            <Button
              intent="ghost"
              isLoading={voidPacket.isPending}
              onClick={async () => {
                setActionMsg(null);
                try {
                  await voidPacket.mutateAsync({ packetId });
                  setActionMsg("Packet voided.");
                  refresh();
                } catch (err) {
                  setActionMsg(describeError(err).detail ?? "Void failed.");
                }
              }}
            >
              Void packet
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default AdminPatientPacketsPage;
