// Start a telehealth video visit — the ONE create dialog shared by
// every entry point: the /admin/video-visits page, the patient chart's
// action bar (patient locked in), and the universal header button
// (pick an existing patient OR type in someone who isn't in the
// system yet). The patient receives a secure join link by SMS/email;
// the link is also shown for copy/paste so staff can share it through
// any channel.

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Copy, Video } from "lucide-react";

import {
  getListPatientsQueryKey,
  useListPatients,
} from "@workspace/api-client-react/admin";

import { AdminModal } from "@/components/admin/AdminModal";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { useToast } from "@/hooks/use-toast";
import { fullName } from "@/lib/admin/format";
import {
  createVideoVisit,
  createVideoVisitUniversal,
  type CreateVideoVisitInput,
  type CreateVideoVisitResponse,
  type VideoVisitPurpose,
} from "@/lib/admin/video-visits-api";

export interface SelectedPatient {
  id: string;
  firstName: string;
  lastName: string;
}

/** Best-effort US-centric E.164 normalization for the guest phone
 *  field: "(814) 555-0123" → "+18145550123". Returns null when the
 *  digits don't form a plausible number. */
function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, "");
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith("1")) return `+${bare}`;
  return null;
}

export function StartVideoVisitModal({
  lockedPatient,
  onClose,
  onCreated,
}: {
  /** When set (patient chart context), the subject is fixed. */
  lockedPatient?: SelectedPatient | { id: string; name: string };
  onClose: () => void;
  /** Fires once per successful create (list refreshes, toasts). */
  onCreated?: (result: CreateVideoVisitResponse) => void;
}) {
  const { toast } = useToast();
  const [subjectTab, setSubjectTab] = useState<"patient" | "guest">("patient");
  const [patient, setPatient] = useState<SelectedPatient | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [purpose, setPurpose] = useState<VideoVisitPurpose>("setup");
  const [channel, setChannel] = useState<"email" | "sms" | "none">("sms");
  const [scheduledAt, setScheduledAt] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<CreateVideoVisitResponse | null>(null);

  const isGuest = !lockedPatient && subjectTab === "guest";

  const create = useMutation({
    mutationFn: async () => {
      const input: CreateVideoVisitInput = { purpose, channel };
      if (scheduledAt) {
        const d = new Date(scheduledAt);
        if (!Number.isNaN(d.getTime())) input.scheduledAt = d.toISOString();
      }
      if (notes.trim()) input.notes = notes.trim();

      if (lockedPatient) {
        return createVideoVisit(lockedPatient.id, input);
      }
      if (!isGuest) {
        if (!patient) throw new Error("Select a patient first.");
        return createVideoVisitUniversal({ ...input, patientId: patient.id });
      }
      const phone = guestPhone.trim() ? normalizePhoneE164(guestPhone) : null;
      if (guestPhone.trim() && !phone) {
        throw new Error(
          "That phone number doesn't look valid — use a 10-digit US number or full +1… format.",
        );
      }
      return createVideoVisitUniversal({
        ...input,
        guestName: guestName.trim(),
        ...(guestEmail.trim() ? { email: guestEmail.trim() } : {}),
        ...(phone ? { phoneE164: phone } : {}),
      });
    },
    onSuccess: (r) => {
      setResult(r);
      onCreated?.(r);
    },
    onError: (err) => {
      toast({
        title: "Couldn't create the visit",
        description:
          err instanceof Error && err.message
            ? err.message
            : "Check the contact info and try again.",
        variant: "destructive",
      });
    },
  });

  // Channel-aware so the UI can't submit a state the server rejects
  // (e.g. an SMS invite for a guest with only an email on the form).
  const canSubmit = lockedPatient
    ? true
    : isGuest
      ? guestName.trim().length > 0 &&
        (channel === "none" ||
          (channel === "sms"
            ? guestPhone.trim().length > 0
            : guestEmail.trim().length > 0))
      : patient !== null;

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.joinUrl);
      toast({ title: "Join link copied to clipboard" });
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: result.joinUrl,
      });
    }
  };

  if (result) {
    return (
      <AdminModal title="Video visit ready" onClose={onClose}>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <CheckCircle2
              className="mt-0.5 h-5 w-5 shrink-0"
              style={{ color: "hsl(152 70% 32%)" }}
            />
            <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
              {channel === "none"
                ? "Visit created — share the join link below through any channel."
                : result.delivered
                  ? `Invite sent by ${channel === "sms" ? "text message" : "email"}.`
                  : `Visit created, but the ${channel === "sms" ? "text" : "email"} invite couldn't be delivered${
                      result.deliveryError ? ` (${result.deliveryError})` : ""
                    } — copy the link below and share it directly.`}
            </p>
          </div>
          <div
            className="break-all rounded border px-3 py-2 text-xs"
            style={{
              borderColor: "hsl(var(--line-1))",
              color: "hsl(var(--ink-2))",
            }}
          >
            {result.joinUrl}
          </div>
          <div className="flex justify-end gap-2">
            <Button intent="secondary" onClick={() => void copyLink()}>
              <Copy className="h-4 w-4" />
              Copy link
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Join the call from the{" "}
            <a
              href="/admin/video-visits"
              className="underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              Video visits
            </a>{" "}
            page when they're ready.
          </p>
        </div>
      </AdminModal>
    );
  }

  return (
    <AdminModal
      title={
        <span className="flex items-center gap-2">
          <Video className="h-5 w-5" />
          Start a video visit
        </span>
      }
      description="They get a secure join link — no app or account needed, just a phone or computer with a camera."
      onClose={onClose}
    >
      <div className="space-y-4">
        {lockedPatient ? (
          <div>
            <Label htmlFor="video-visit-subject">Patient</Label>
            <div
              id="video-visit-subject"
              className="rounded border px-3 py-2 text-sm font-medium"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {"name" in lockedPatient
                ? lockedPatient.name
                : fullName(lockedPatient.firstName, lockedPatient.lastName)}
            </div>
          </div>
        ) : (
          <div>
            <div
              className="mb-2 inline-flex rounded-lg border p-0.5 text-xs font-semibold"
              style={{ borderColor: "hsl(var(--line-1))" }}
              role="tablist"
              aria-label="Who is this visit with?"
            >
              {(
                [
                  ["patient", "Existing patient"],
                  ["guest", "Not in the system yet"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={subjectTab === key}
                  onClick={() => setSubjectTab(key)}
                  className="rounded-md px-3 py-1.5 transition-colors"
                  style={
                    subjectTab === key
                      ? {
                          backgroundColor: "hsl(var(--penn-navy))",
                          color: "#fff",
                        }
                      : { color: "hsl(var(--ink-2))" }
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {subjectTab === "patient" ? (
              <PatientPicker value={patient} onChange={setPatient} />
            ) : (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="video-visit-guest-name">Their name</Label>
                  <Input
                    id="video-visit-guest-name"
                    value={guestName}
                    maxLength={120}
                    placeholder="e.g. Jordan Smith"
                    onChange={(e) => setGuestName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="video-visit-guest-phone">
                      Mobile phone
                    </Label>
                    <Input
                      id="video-visit-guest-phone"
                      type="tel"
                      value={guestPhone}
                      placeholder="(814) 555-0123"
                      onChange={(e) => setGuestPhone(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="video-visit-guest-email">Email</Label>
                    <Input
                      id="video-visit-guest-email"
                      type="email"
                      value={guestEmail}
                      maxLength={200}
                      placeholder="name@example.com"
                      onChange={(e) => setGuestEmail(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                  For someone who isn't a patient yet — a prospect, a referral,
                  or a family member helping with a setup. Provide at least one
                  way to reach them (or choose "copy the link").
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="video-visit-purpose">Purpose</Label>
            <Select
              id="video-visit-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as VideoVisitPurpose)}
              options={[
                { value: "setup", label: "Equipment setup" },
                { value: "troubleshooting", label: "Troubleshooting" },
                { value: "follow_up", label: "Follow-up" },
                { value: "other", label: "Other" },
              ]}
            />
          </div>
          <div>
            <Label htmlFor="video-visit-channel">Send invite by</Label>
            <Select
              id="video-visit-channel"
              value={channel}
              onChange={(e) =>
                setChannel(e.target.value as "email" | "sms" | "none")
              }
              options={[
                { value: "sms", label: "Text message (SMS)" },
                { value: "email", label: "Email" },
                { value: "none", label: "Don't send — copy the link" },
              ]}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="video-visit-when">
            Scheduled for (optional — leave blank to call now)
          </Label>
          <Input
            id="video-visit-when"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="video-visit-notes">Internal notes (optional)</Label>
          <Input
            id="video-visit-notes"
            value={notes}
            maxLength={2000}
            placeholder="e.g. Walk through humidifier setup"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button intent="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!canSubmit}
            isLoading={create.isPending}
          >
            Create visit
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

/** Quick-action button + modal, mirroring PatientPaymentLinkButton.
 *  With `patient` set it locks the chart's patient in; without it, the
 *  modal offers the existing-patient / not-in-the-system chooser. */
export function StartVideoVisitButton({
  patient,
  label = "Start video visit",
  intent = "secondary",
  size,
  onCreated,
}: {
  patient?: { id: string; name: string };
  label?: string;
  intent?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button intent={intent} size={size} onClick={() => setOpen(true)}>
        <Video className="h-4 w-4" />
        {label}
      </Button>
      {open && (
        <StartVideoVisitModal
          lockedPatient={patient}
          onClose={() => setOpen(false)}
          onCreated={() => onCreated?.()}
        />
      )}
    </>
  );
}

// ── Patient typeahead (same shape as the company-calendar picker) ──
function PatientPicker({
  value,
  onChange,
}: {
  value: SelectedPatient | null;
  onChange: (p: SelectedPatient | null) => void;
}) {
  const [search, setSearch] = useState("");
  const params = useMemo(
    () => ({ search: search.trim(), limit: 8 as const }),
    [search],
  );
  const enabled = search.trim().length >= 2;
  const q = useListPatients(params, {
    query: { enabled, queryKey: getListPatientsQueryKey(params) },
  });

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded border px-3 py-2 text-sm"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <span className="font-medium">
          {fullName(value.firstName, value.lastName)}
        </span>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => {
            onChange(null);
            setSearch("");
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const items = q.data?.items ?? [];
  return (
    <div>
      <Input
        id="video-visit-patient"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search patient by name…"
        aria-label="Search patient"
        autoFocus
      />
      {enabled && (
        <div
          className="mt-1 max-h-56 overflow-y-auto rounded border"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {q.isFetching && items.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">Searching…</div>
          ) : items.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">
              No matching patients.
            </div>
          ) : (
            items.map((pt) => (
              <button
                key={pt.id}
                type="button"
                onClick={() =>
                  onChange({
                    id: pt.id,
                    firstName: pt.firstName,
                    lastName: pt.lastName,
                  })
                }
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium">
                  {fullName(pt.firstName, pt.lastName)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {pt.pacwareId}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
