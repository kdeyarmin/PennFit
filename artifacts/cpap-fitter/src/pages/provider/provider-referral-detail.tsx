// /provider/referrals/:id — one referral, from fitting through to the DME.
//
// The page is a sequence, not a form: send the fitting, read what came
// back, approve a mask, sign the order, send it. Each step only offers
// what is actually available at that point, because a referring clinician
// dipping in between patients should be able to see the one thing to do
// next without reconstructing where they got to.
//
// THE THREE ENTRY POINTS live in `FittingStep`. They are the same signed
// link; what differs is only how it reaches the patient — emailed/texted,
// opened on a device in the room, or scanned off a QR code. In-office and
// kiosk need no contact details at all, which is what makes them the
// answer for a patient sitting in front of you with no email on file.

import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileSignature,
  MessageSquare,
  Monitor,
  Paperclip,
  QrCode as QrCodeIcon,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";

import { QrCode } from "@/components/QrCode";
import {
  ACCEPTED_DOC_MIME,
  approveMask,
  cancelReferral,
  DOC_TYPE_LABEL,
  getFitting,
  getReferral,
  REFERRAL_STATUS_LABEL,
  referralDocumentUrl,
  removeReferralDocument,
  requestSignature,
  sendFitting,
  sendReferralMessage,
  submitReferral,
  updateReferral,
  uploadReferralDocument,
  type EntryPoint,
  type ReferralDetail,
  type ReferralDocType,
  type ReferralFitting,
} from "@/lib/provider/referral-api";
import {
  Button,
  Card,
  ErrorNote,
  ProviderShell,
  Spinner,
  formatDateTime,
} from "./provider-ui";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

const labelClass = "block text-sm font-medium text-slate-700";

export function ProviderReferralDetail({
  id,
  providerName,
}: {
  id: string;
  providerName?: string | null;
}) {
  const queryClient = useQueryClient();
  const key = ["provider", "referral", id] as const;

  const referral = useQuery({ queryKey: key, queryFn: () => getReferral(id) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({
      queryKey: ["provider", "referrals"],
    });
  };

  if (referral.isPending) {
    return (
      <ProviderShell providerName={providerName}>
        <Spinner label="Loading referral…" />
      </ProviderShell>
    );
  }
  if (referral.isError || !referral.data) {
    return (
      <ProviderShell providerName={providerName}>
        <ErrorNote>
          Couldn&apos;t load this referral. It may have been withdrawn.
        </ErrorNote>
      </ProviderShell>
    );
  }

  const r = referral.data;
  const closed =
    r.status === "cancelled" ||
    r.status === "declined" ||
    r.status === "dispensed";

  return (
    <ProviderShell providerName={providerName}>
      <Link
        href="/provider/referrals"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All referrals
      </Link>

      <header className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">
          {r.patient.firstName} {r.patient.lastName}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {r.dmeName ?? "DME"} · {REFERRAL_STATUS_LABEL[r.status]}
          {r.patient.dob ? ` · DOB ${r.patient.dob}` : ""}
        </p>
        {r.status === "declined" && r.declinedReason ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3.5 py-2.5 text-sm text-rose-900">
            <strong>Declined.</strong> {r.declinedReason}
          </p>
        ) : null}
      </header>

      {!closed ? (
        <>
          <FittingStep referral={r} onChange={invalidate} />
          <ApprovalStep referral={r} onChange={invalidate} />
          <SignAndSendStep referral={r} onChange={invalidate} />
        </>
      ) : null}

      {!closed ? <ChartDetails referral={r} onChange={invalidate} /> : null}
      <Documents referral={r} onChange={invalidate} />
      <Thread referral={r} onChange={invalidate} />
      <Timeline referral={r} />

      {!closed ? (
        <div className="mt-8 border-t border-slate-200 pt-5">
          <WithdrawButton id={r.id} onDone={invalidate} />
        </div>
      ) : null}
    </ProviderShell>
  );
}

// ── Step 1: the fitting ──────────────────────────────────────────────

const ENTRY_POINTS: Array<{
  value: EntryPoint;
  label: string;
  blurb: string;
  icon: typeof Send;
}> = [
  {
    value: "remote_link",
    label: "Send a link",
    blurb:
      "Email or text the patient. They do the fitting at home on their own phone.",
    icon: Send,
  },
  {
    value: "in_office",
    label: "Scan now",
    blurb:
      "Open the fitter on a device here in the room. Needs no contact details.",
    icon: Monitor,
  },
  {
    value: "kiosk_qr",
    label: "QR code",
    blurb:
      "Show a code for the patient to scan with their own phone, right now.",
    icon: QrCodeIcon,
  },
];

function FittingStep({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const [entryPoint, setEntryPoint] = useState<EntryPoint>("remote_link");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [result, setResult] = useState<{
    url: string;
    entryPoint: EntryPoint;
    delivered: boolean;
    deliveryReason: string | null;
  } | null>(null);

  const fitting = useQuery({
    queryKey: ["provider", "referral", referral.id, "fitting"],
    queryFn: () => getFitting(referral.id),
    // Only poll while genuinely waiting on the patient — a completed or
    // not-yet-sent fitting has nothing to poll for.
    refetchInterval: referral.status === "awaiting_fitting" ? 15_000 : false,
    enabled: Boolean(referral.fitting.inviteId),
  });

  const send = useMutation({
    mutationFn: () =>
      sendFitting(
        referral.id,
        entryPoint,
        entryPoint === "remote_link" ? channel : undefined,
      ),
    onSuccess: (res) => {
      setResult({
        url: res.fittingUrl,
        entryPoint: res.entryPoint,
        delivered: res.delivered,
        deliveryReason: res.deliveryReason,
      });
      onChange();
    },
  });

  const done = fitting.data?.status === "complete";

  return (
    <Card className="mb-4 p-5">
      <StepHeading n={1} title="Mask fitting" done={done} />

      {done ? (
        <FittingResult fitting={fitting.data!} />
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {ENTRY_POINTS.map((ep) => {
              const Icon = ep.icon;
              const active = entryPoint === ep.value;
              return (
                <button
                  key={ep.value}
                  type="button"
                  onClick={() => {
                    setEntryPoint(ep.value);
                    setResult(null);
                  }}
                  aria-pressed={active}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? "border-blue-600 bg-blue-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <span className="flex items-center gap-2 font-medium text-slate-900">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {ep.label}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {ep.blurb}
                  </span>
                </button>
              );
            })}
          </div>

          {entryPoint === "remote_link" ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">Send by</span>
              {(["email", "sms"] as const).map((c) => (
                <label
                  key={c}
                  className="flex items-center gap-1.5 text-sm text-slate-700"
                >
                  <input
                    type="radio"
                    name="fitting-channel"
                    checked={channel === c}
                    onChange={() => setChannel(c)}
                  />
                  {c === "email" ? "Email" : "Text message"}
                </label>
              ))}
              <span className="text-xs text-slate-400">
                {channel === "email"
                  ? (referral.patient.email ?? "no email on file")
                  : (referral.patient.phone ?? "no mobile on file")}
              </span>
            </div>
          ) : null}

          {send.isError ? (
            <ErrorNote>
              {send.error instanceof Error
                ? send.error.message
                : "Couldn't start the fitting."}
            </ErrorNote>
          ) : null}

          <Button
            className="mt-4"
            onClick={() => send.mutate()}
            disabled={send.isPending}
          >
            {entryPoint === "remote_link"
              ? "Send the fitting link"
              : entryPoint === "in_office"
                ? "Start the fitting here"
                : "Show the QR code"}
          </Button>

          {result ? (
            <FittingHandoff
              url={result.url}
              entryPoint={result.entryPoint}
              delivered={result.delivered}
              deliveryReason={result.deliveryReason}
            />
          ) : referral.status === "awaiting_fitting" ? (
            <p className="mt-3 text-sm text-slate-500">
              Sent {formatDateTime(referral.fitting.sentAt)}. This page updates
              itself when the patient finishes.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * What to do with the link once it exists.
 *
 * Each entry point hands it over differently, and getting this wrong is
 * what makes an "in-office" mode useless in practice: the provider needs
 * the URL in front of them, not a confirmation that something was sent.
 */
function FittingHandoff({
  url,
  entryPoint,
  delivered,
  deliveryReason,
}: {
  url: string;
  entryPoint: EntryPoint;
  delivered: boolean;
  deliveryReason: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (entryPoint === "kiosk_qr") {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
        <p className="text-sm font-medium text-slate-900">
          Ask the patient to scan this with their phone camera
        </p>
        <div className="mt-3 flex justify-center">
          <QrCode value={url} size={200} ariaLabel="Mask fitting link" />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The fitting runs entirely on their device — no app to install, and
          their camera images never leave the phone.
        </p>
      </div>
    );
  }

  if (entryPoint === "in_office") {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-medium text-slate-900">
          Open this on the device the patient will use
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => window.open(url, "_blank", "noopener")}>
            <Smartphone className="h-4 w-4" aria-hidden="true" />
            Open the fitter
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              setCopied(true);
            }}
          >
            {copied ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p className="mt-2 break-all font-mono text-xs text-slate-400">{url}</p>
      </div>
    );
  }

  return (
    <div
      className={`mt-4 rounded-xl px-4 py-3 text-sm ${
        delivered
          ? "bg-emerald-50 text-emerald-900"
          : "bg-amber-50 text-amber-900"
      }`}
      role="status"
    >
      {delivered ? (
        <p>Sent. The patient will get a link to their fitting.</p>
      ) : (
        <>
          <p>
            {deliveryReason === "no_email" || deliveryReason === "no_phone"
              ? "There was no contact detail on file to send to."
              : "We couldn't send the message."}{" "}
            You can pass this link on yourself:
          </p>
          <p className="mt-1.5 break-all font-mono text-xs">{url}</p>
        </>
      )}
    </div>
  );
}

function FittingResult({ fitting }: { fitting: ReferralFitting }) {
  const s = fitting.session;
  if (!s) return null;
  return (
    <div className="mt-3">
      {s.primary ? (
        <div className="rounded-xl border border-slate-200 p-4">
          <p className="font-semibold text-slate-900">
            {s.primary.manufacturer} {s.primary.name}
          </p>
          {s.primary.cushion?.sizeLabel ? (
            <p className="text-sm text-slate-600">
              Recommended size: {s.primary.cushion.sizeLabel}
            </p>
          ) : null}
          {s.primary.reasons && s.primary.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              {s.primary.reasons.slice(0, 3).map((reason, i) => (
                <li key={i}>· {reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The fitting did not produce a confident recommendation
          {s.outcome === "contraindicated"
            ? " — every option was ruled out on safety or therapy compatibility."
            : s.outcome === "outside_validated_range"
              ? " — the measurements fall outside the range our sizing data covers."
              : " — there wasn't enough evidence to be confident."}{" "}
          A respiratory therapist should fit this patient in person.
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">
        {s.formularyName ? `${s.formularyName} · ` : ""}
        {s.rulesEngineVersion ? `rules ${s.rulesEngineVersion} · ` : ""}
        completed {formatDateTime(s.completedAt)}
      </p>
    </div>
  );
}

// ── Step 2: approval ─────────────────────────────────────────────────

function ApprovalStep({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const fitting = useQuery({
    queryKey: ["provider", "referral", referral.id, "fitting"],
    queryFn: () => getFitting(referral.id),
    enabled: Boolean(referral.fitting.inviteId),
  });
  const [selected, setSelected] = useState<string>("");
  const [note, setNote] = useState("");

  const approve = useMutation({
    mutationFn: () => {
      const options = candidates();
      const pick = options.find((o) => o.id === selected);
      return approveMask(referral.id, {
        maskModelId: selected,
        variantId: pick?.variantId ?? null,
        note: note.trim() || undefined,
      });
    },
    onSuccess: onChange,
  });

  function candidates() {
    const s = fitting.data?.session;
    if (!s) return [];
    const all = [s.primary, ...(s.alternatives ?? [])].filter(Boolean);
    return all.map((c) => ({
      id: String(c!.maskId ?? c!.maskSlug ?? ""),
      label: `${c!.manufacturer ?? ""} ${c!.name ?? ""}`.trim(),
      size: c!.cushion?.sizeLabel ?? null,
      variantId: c!.cushion?.variantId ?? null,
      isPrimary: c === s.primary,
      why: (c as { rankedBelowBecause?: string | null }).rankedBelowBecause,
    }));
  }

  const options = candidates();
  const done = Boolean(referral.approval.approvedAt);
  const available = fitting.data?.status === "complete" && options.length > 0;

  return (
    <Card className="mb-4 p-5">
      <StepHeading n={2} title="Approve a mask" done={done} />
      {done ? (
        <p className="mt-2 text-sm text-slate-600">
          Approved {formatDateTime(referral.approval.approvedAt)}
          {referral.approval.isOverride
            ? " — a different mask to the one recommended."
            : "."}
          {referral.approval.note ? (
            <span className="mt-1 block text-slate-500">
              &ldquo;{referral.approval.note}&rdquo;
            </span>
          ) : null}
        </p>
      ) : !available ? (
        <p className="mt-2 text-sm text-slate-500">
          Available once the patient has completed their fitting.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {options.map((o) => (
            <label
              key={o.id}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                selected === o.id
                  ? "border-blue-600 bg-blue-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="approve-mask"
                className="mt-1"
                checked={selected === o.id}
                onChange={() => setSelected(o.id)}
              />
              <span>
                <span className="block font-medium text-slate-900">
                  {o.label}
                  {o.isPrimary ? (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800">
                      Recommended
                    </span>
                  ) : null}
                </span>
                {o.size ? (
                  <span className="block text-sm text-slate-600">
                    Size {o.size}
                  </span>
                ) : null}
                {o.why ? (
                  <span className="block text-xs text-slate-500">
                    Ranked lower because {o.why}
                  </span>
                ) : null}
              </span>
            </label>
          ))}

          <div>
            <label
              className="block text-sm font-medium text-slate-700"
              htmlFor="approve-note"
            >
              Note
              <span className="ml-1 font-normal text-slate-400">
                (required if you pick something other than the recommendation)
              </span>
            </label>
            <textarea
              id="approve-note"
              rows={2}
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. patient has a healed nasal fracture; avoiding bridge contact"
            />
          </div>

          {approve.isError ? (
            <ErrorNote>
              {approve.error instanceof Error
                ? approve.error.message
                : "Couldn't record the approval."}
            </ErrorNote>
          ) : null}

          <Button
            onClick={() => approve.mutate()}
            disabled={!selected || approve.isPending}
          >
            Approve this mask
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Step 3: sign + send ──────────────────────────────────────────────

function SignAndSendStep({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const sign = useMutation({
    mutationFn: () => requestSignature(referral.id),
    onSuccess: (res) => {
      onChange();
      // The order is signed in the queue the provider already knows,
      // rather than in a second signing UI built just for referrals —
      // but it has to come BACK. Signing does not send anything; the
      // provider still has to return and press "Send to the DME". Without
      // a return target the signing screen says the practice has been
      // notified and offers only "Back to my documents", which is how a
      // signed referral ends up sitting unsubmitted forever.
      const back = encodeURIComponent(`/provider/referrals/${referral.id}`);
      window.location.assign(
        `/provider/sign/${res.signatureRequestId}?return=${back}`,
      );
    },
  });
  const submit = useMutation({
    mutationFn: () => submitReferral(referral.id),
    onSuccess: onChange,
  });

  const signed = Boolean(referral.signature.signedAt);
  const sent = Boolean(referral.submittedAt);

  // The server refuses to raise an order for signature until everything
  // the DME needs is present, because signing freezes the forms that
  // would supply it. Mirror that here so it reads as a sequence rather
  // than a rejection — the server stays the gate, this is the affordance.
  const outstanding: string[] = [];
  if (!referral.patient.dob) outstanding.push("date of birth");
  if (!referral.insurance.payerName) outstanding.push("the insurance payer");
  if (!referral.approval.approvedAt) outstanding.push("an approved mask");
  if (!referral.documents.some((d) => d.docType === "prescription")) {
    outstanding.push("a prescription");
  }
  const canSign = outstanding.length === 0 && !signed;

  return (
    <Card className="mb-4 p-5">
      <StepHeading n={3} title="Sign and send" done={sent} />
      {sent ? (
        <p className="mt-2 text-sm text-slate-600">
          Sent to {referral.dmeName ?? "the DME"}{" "}
          {formatDateTime(referral.submittedAt)}.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {!signed ? (
            <>
              <p className="text-sm text-slate-600">
                Sign the referral order. It goes through the same signing screen
                and signature log as your other documents.
              </p>
              {sign.isError ? (
                <ErrorNote>
                  {sign.error instanceof Error
                    ? sign.error.message
                    : "Couldn't raise the order for signing."}
                </ErrorNote>
              ) : null}
              <Button
                onClick={() => sign.mutate()}
                disabled={!canSign || sign.isPending}
              >
                <FileSignature className="h-4 w-4" aria-hidden="true" />
                Sign the referral order
              </Button>
              {!canSign ? (
                <p className="text-xs text-slate-500">
                  Still needed before this can be signed:{" "}
                  {outstanding.join(", ")}. Signing locks the order, so these
                  have to be right first.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Signed {formatDateTime(referral.signature.signedAt)}.
              </p>
              {submit.isError ? (
                <ErrorNote>
                  {submit.error instanceof Error
                    ? submit.error.message
                    : "Couldn't send it."}
                </ErrorNote>
              ) : null}
              <Button
                onClick={() => submit.mutate()}
                disabled={submit.isPending}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Send to {referral.dmeName ?? "the DME"}
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Thread, documents, timeline ──────────────────────────────────────

function Thread({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const [body, setBody] = useState("");
  // Every DME-side query filters on `submitted_at`, so a message written
  // before the referral is sent is stored, counted, and unreadable. The
  // server refuses it; this keeps the UI from promising otherwise.
  const sent = Boolean(referral.submittedAt);
  const send = useMutation({
    mutationFn: () => sendReferralMessage(referral.id, body.trim()),
    onSuccess: () => {
      setBody("");
      onChange();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim()) send.mutate();
  };

  return (
    <Card className="mb-4 p-5">
      <h2 className="flex items-center gap-2 font-semibold text-slate-900">
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
        Messages with {referral.dmeName ?? "the DME"}
      </h2>
      {!sent ? (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          The thread opens once you send the referral — until then there is no
          one at {referral.dmeName ?? "the supplier"} it could reach.
        </p>
      ) : referral.messages.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          No messages yet. Anything you send here reaches their team directly —
          no phone call, no fax.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {referral.messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-xl px-3.5 py-2.5 text-sm ${
                m.authorKind === "provider"
                  ? "bg-blue-50 text-blue-950"
                  : "bg-slate-100 text-slate-800"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className="mt-1 text-xs text-slate-500">
                {m.authorKind === "provider"
                  ? "You"
                  : (referral.dmeName ?? "DME")}{" "}
                · {formatDateTime(m.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {sent ? (
        <form className="mt-3 flex gap-2" onSubmit={submit}>
          <input
            className={inputClass}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Send a message…"
            aria-label="Message the DME"
          />
          <Button type="submit" disabled={!body.trim() || send.isPending}>
            Send
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Paperwork: attach, download, remove.
 *
 * A prescription is what the DME cannot dispense without, so it is
 * called out by name rather than left to be discovered at submit time —
 * "you can't send this yet" is a far worse place to learn it than here.
 * Attachments freeze once the order is signed (the server enforces it);
 * the UI stops offering the controls at the same point so the freeze
 * never shows up as an error.
 */
function Documents({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [docType, setDocType] = useState<ReferralDocType>("prescription");
  const [error, setError] = useState<string | null>(null);

  const editable =
    referral.status === "draft" ||
    referral.status === "awaiting_fitting" ||
    referral.status === "fitting_complete";

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadReferralDocument(referral.id, file, docType),
    onSuccess: () => {
      setError(null);
      if (fileRef.current) fileRef.current.value = "";
      onChange();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (docId: string) => removeReferralDocument(referral.id, docId),
    onSuccess: onChange,
    onError: (err: Error) => setError(err.message),
  });

  const hasRx = referral.documents.some((d) => d.docType === "prescription");

  return (
    <Card className="mb-4 p-5">
      <h2 className="flex items-center gap-2 font-semibold text-slate-900">
        <Paperclip className="h-4 w-4" aria-hidden="true" />
        Paperwork
      </h2>

      {!hasRx ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          A prescription has to be attached before this can go to the DME.
        </p>
      ) : null}

      {referral.documents.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing attached yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {referral.documents.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-900">
                  {d.fileName}
                </span>
                <span className="text-xs text-slate-500">
                  {DOC_TYPE_LABEL[d.docType as ReferralDocType] ??
                    d.docType.replace(/_/g, " ")}{" "}
                  · {Math.round(d.sizeBytes / 1024)} KB ·{" "}
                  {d.uploadedByKind === "provider" ? "you" : "the DME"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <a
                  href={referralDocumentUrl(referral.id, d.id)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Download
                </a>
                {editable && d.uploadedByKind === "provider" ? (
                  <button
                    type="button"
                    onClick={() => remove.mutate(d.id)}
                    disabled={remove.isPending}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-700 disabled:opacity-50"
                    aria-label={`Remove ${d.fileName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {editable ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-4">
          <div>
            <label className={labelClass} htmlFor="referral-doc-type">
              Attach
            </label>
            <select
              id="referral-doc-type"
              className={inputClass}
              value={docType}
              onChange={(e) => setDocType(e.target.value as ReferralDocType)}
            >
              {(
                Object.keys(DOC_TYPE_LABEL) as Array<
                  keyof typeof DOC_TYPE_LABEL
                >
              ).map((k) => (
                <option key={k} value={k}>
                  {DOC_TYPE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_DOC_MIME.join(",")}
            aria-label="Choose a file to attach"
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
            }}
            disabled={upload.isPending}
          />
          {upload.isPending ? <Spinner label="Uploading…" /> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          The order is signed, so its paperwork is locked. Send a message if
          something needs to change.
        </p>
      )}
    </Card>
  );
}

/**
 * The two fields the DME cannot process a referral without, collected
 * here rather than on the create form.
 *
 * The create form is deliberately a 30-second job so a physician can
 * start a fitting mid-visit. That leaves date of birth and the payer to
 * be filled in before sending, and this is where. The submit gate names
 * exactly these, so surfacing them next to the send button is what turns
 * a 409 into something the provider can just fix.
 */
function ChartDetails({
  referral,
  onChange,
}: {
  referral: ReferralDetail;
  onChange: () => void;
}) {
  const [dob, setDob] = useState(referral.patient.dob ?? "");
  const [payerName, setPayerName] = useState(
    referral.insurance.payerName ?? "",
  );
  const [memberId, setMemberId] = useState(referral.insurance.memberId ?? "");
  const [saved, setSaved] = useState(false);

  const editable =
    referral.status === "draft" ||
    referral.status === "awaiting_fitting" ||
    referral.status === "fitting_complete";

  const save = useMutation({
    mutationFn: () =>
      updateReferral(referral.id, {
        patient: { dob: dob || null },
        insurance: {
          payerName: payerName.trim() || null,
          memberId: memberId.trim() || null,
        },
      } as Parameters<typeof updateReferral>[1]),
    onSuccess: () => {
      setSaved(true);
      onChange();
    },
  });

  const missing: string[] = [];
  if (!referral.patient.dob) missing.push("date of birth");
  if (!referral.insurance.payerName) missing.push("insurance payer");

  // Nothing missing and nothing editable — don't take up the space.
  if (!editable && missing.length === 0) return null;

  return (
    <Card className="mb-4 p-5">
      <h2 className="font-semibold text-slate-900">Patient and insurance</h2>
      {missing.length > 0 ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The DME needs the {missing.join(" and the ")} before this can be sent.
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-500">
          Everything the DME needs is here.
        </p>
      )}

      {editable ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor="referral-detail-dob">
                Date of birth
              </label>
              <input
                id="referral-detail-dob"
                type="date"
                className={inputClass}
                value={dob}
                onChange={(e) => setDob(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="referral-detail-payer">
                Insurance payer
              </label>
              <input
                id="referral-detail-payer"
                className={inputClass}
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
                placeholder="e.g. Aetna"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="referral-detail-member">
                Member ID (optional)
              </label>
              <input
                id="referral-detail-member"
                className={inputClass}
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              />
            </div>
          </div>
          {save.isError ? (
            <ErrorNote>
              {save.error instanceof Error
                ? save.error.message
                : "Couldn't save that."}
            </ErrorNote>
          ) : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {saved && !save.isPending ? (
              <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
                <Check className="h-4 w-4" aria-hidden="true" /> Saved
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function Timeline({ referral }: { referral: ReferralDetail }) {
  if (referral.events.length === 0) return null;
  return (
    <Card className="p-5">
      <h2 className="font-semibold text-slate-900">History</h2>
      <ol className="mt-3 space-y-2 text-sm">
        {referral.events.map((e, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-700">
              {EVENT_LABEL[e.eventType] ?? e.eventType.replace(/[._]/g, " ")}
            </span>
            <span className="shrink-0 text-xs text-slate-400">
              {formatDateTime(e.occurredAt)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const EVENT_LABEL: Record<string, string> = {
  "referral.created": "Referral started",
  "fitting.sent": "Fitting link issued",
  "fitting.completed": "Patient completed their fitting",
  "mask.approved": "Mask approved",
  "document.attached": "Document attached",
  "document.removed": "Document removed",
  "signature.requested": "Order raised for signature",
  "signature.signed": "Order signed",
  "referral.submitted": "Sent to the DME",
  "referral.accepted": "Accepted by the DME",
  "referral.declined": "Declined by the DME",
  "referral.in_progress": "DME started work",
  "referral.dispensed": "Dispensed",
  "referral.cancelled": "Withdrawn",
  "message.sent": "Message sent",
  "patient.matched": "Matched to a chart",
};

function WithdrawButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => cancelReferral(id, reason.trim() || undefined),
    onSuccess: onDone,
  });

  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Withdraw this referral
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <label
        className="block text-sm font-medium text-slate-700"
        htmlFor="withdraw-reason"
      >
        Why are you withdrawing it?
        <span className="ml-1 font-normal text-slate-400">
          (optional — sent to the DME)
        </span>
      </label>
      <input
        id="withdraw-reason"
        className={inputClass}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          Withdraw
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

function StepHeading({
  n,
  title,
  done,
}: {
  n: number;
  title: string;
  done: boolean;
}) {
  return (
    <h2 className="flex items-center gap-2.5 font-semibold text-slate-900">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"
        }`}
        aria-hidden="true"
      >
        {done ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      {title}
    </h2>
  );
}

export default ProviderReferralDetail;
