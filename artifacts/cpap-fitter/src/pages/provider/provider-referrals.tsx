// /provider/referrals — a referring clinician's own referrals, across
// every DME they refer to, plus the form that starts a new one.
//
// The list is ordered by what needs THEIR attention. A referring
// physician does not want a database status column; they want to know
// which of their patients is stuck and on whom. So each row leads with
// the next action when it is their move, and says who they are waiting on
// when it is not.

import { useMemo, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Send, Inbox } from "lucide-react";

import {
  createReferral,
  getReferralDestinations,
  listReferrals,
  nextAction,
  REFERRAL_STATUS_LABEL,
  type ReferralSummary,
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

const QUERY_KEY = ["provider", "referrals"] as const;

/** Statuses where the ball is in the DME's court. */
const WITH_DME = new Set(["submitted", "accepted", "in_progress"]);

export function ProviderReferrals({
  providerName,
}: {
  providerName?: string | null;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const referrals = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => listReferrals(),
  });

  // Anything the provider still has to act on floats to the top; the
  // rest keeps its recency order. A referring physician opening this
  // page wants their own to-do list, not a chronological feed.
  //
  // The `?? []` lives INSIDE the memo: a fresh array literal in the
  // dependency list would change identity on every render and defeat it.
  const sorted = useMemo(() => {
    const rows = referrals.data?.referrals ?? [];
    const mine = rows.filter((r) => nextAction(r) !== null);
    const theirs = rows.filter((r) => nextAction(r) === null);
    return [...mine, ...theirs];
  }, [referrals.data]);

  return (
    <ProviderShell providerName={providerName}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Referrals</h1>
          <p className="mt-1 text-sm text-slate-500">
            Send a patient to a DME with their mask fitting, prescription, and
            paperwork attached — and follow it without a phone call.
          </p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New referral
        </Button>
      </div>

      {creating ? (
        <NewReferralForm
          onDone={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {referrals.isPending ? <Spinner label="Loading referrals…" /> : null}
      {referrals.isError ? (
        <ErrorNote>
          Couldn&apos;t load your referrals. Please try again in a moment.
        </ErrorNote>
      ) : null}

      {!referrals.isPending && sorted.length === 0 && !creating ? (
        <Card className="p-8 text-center">
          <Inbox
            className="mx-auto h-8 w-8 text-slate-300"
            aria-hidden="true"
          />
          <h2 className="mt-3 text-lg font-semibold text-slate-900">
            No referrals yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Start one and we&apos;ll walk the patient through a mask fitting,
            bring you the recommendation to approve, and route the whole thing
            to the DME.
          </p>
          <Button className="mt-5" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New referral
          </Button>
        </Card>
      ) : null}

      <ul className="space-y-2">
        {sorted.map((r) => (
          <li key={r.id}>
            <ReferralRow referral={r} />
          </li>
        ))}
      </ul>
    </ProviderShell>
  );
}

function ReferralRow({ referral }: { referral: ReferralSummary }) {
  const action = nextAction(referral);
  const waiting = WITH_DME.has(referral.status);
  return (
    <Link
      href={`/provider/referrals/${referral.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">
            {referral.patientName}
            {referral.patientDob ? (
              <span className="ml-2 text-sm font-normal text-slate-400">
                DOB {referral.patientDob}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-sm text-slate-500">
            {referral.dmeName ?? "DME"} ·{" "}
            {REFERRAL_STATUS_LABEL[referral.status]}
          </p>
          {referral.status === "declined" && referral.declinedReason ? (
            <p className="mt-1.5 rounded-md bg-rose-50 px-2.5 py-1.5 text-sm text-rose-800">
              {referral.declinedReason}
            </p>
          ) : null}
          {action ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-sm font-medium text-blue-800">
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {action}
            </p>
          ) : waiting ? (
            <p className="mt-1.5 text-sm text-slate-400">
              Nothing needed from you — the DME has it.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {referral.unreadForProvider > 0 ? (
            <span
              className="rounded-full bg-blue-700 px-2 py-0.5 text-xs font-semibold text-white"
              aria-label={`${referral.unreadForProvider} unread messages`}
            >
              {referral.unreadForProvider}
            </span>
          ) : null}
          <ChevronRight className="h-5 w-5 text-slate-300" aria-hidden="true" />
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Started {formatDateTime(referral.createdAt)}
      </p>
    </Link>
  );
}

/**
 * The new-referral form.
 *
 * Deliberately short. Everything that is not needed to START — insurance
 * detail, clinical notes, the paperwork — is collected on the detail page
 * afterwards, because a physician standing in a room with a patient
 * should be able to open this and get the fitting moving in under a
 * minute. The submit gate on the server is what makes sure the DME never
 * receives something incomplete, so the create form does not have to.
 */
function NewReferralForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const destinations = useQuery({
    queryKey: ["provider", "referral-destinations"],
    queryFn: getReferralDestinations,
  });

  const [dmeLinkId, setDmeLinkId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const create = useMutation({
    mutationFn: () =>
      createReferral({
        dmeLinkId,
        patient: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          dob: dob || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
        },
      }),
    onSuccess: onDone,
  });

  const options = destinations.data?.destinations ?? [];
  const ready =
    dmeLinkId !== "" && firstName.trim() !== "" && lastName.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) create.mutate();
  };

  return (
    <Card className="mb-6 p-5">
      <h2 className="text-lg font-semibold text-slate-900">New referral</h2>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <div>
          <label className={labelClass} htmlFor="referral-dme">
            Send to
          </label>
          {destinations.isPending ? (
            <Spinner label="Loading DMEs…" />
          ) : options.length === 0 ? (
            <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              No DMEs have set you up to receive referrals yet. Ask the supplier
              you work with to invite you from their referral settings.
            </p>
          ) : (
            <select
              id="referral-dme"
              className={inputClass}
              value={dmeLinkId}
              onChange={(e) => setDmeLinkId(e.target.value)}
              required
            >
              <option value="">Choose a supplier…</option>
              {options.map((d) => (
                <option key={d.dmeLinkId} value={d.dmeLinkId}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="referral-first">
              Patient first name
            </label>
            <input
              id="referral-first"
              className={inputClass}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="referral-last">
              Patient last name
            </label>
            <input
              id="referral-last"
              className={inputClass}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="referral-dob">
              Date of birth
            </label>
            <input
              id="referral-dob"
              type="date"
              className={inputClass}
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="referral-email">
              Patient email
            </label>
            <input
              id="referral-email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="For the fitting link"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="referral-phone">
              Mobile number
            </label>
            <input
              id="referral-phone"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+14155550123"
            />
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Contact details are only needed if you want the patient to do the
          fitting at home. You can also fit them here in the office or hand them
          a QR code — that works with nothing on file.
        </p>

        {create.isError ? (
          <ErrorNote>
            {create.error instanceof Error
              ? create.error.message
              : "Couldn't create the referral."}
          </ErrorNote>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={!ready || create.isPending}>
            Create referral
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default ProviderReferrals;
