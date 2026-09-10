import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Phone } from "lucide-react";
import { Button } from "./Button";
import { ErrorPanel } from "./ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  queueResupplyOutreach,
  type OutreachChannel,
} from "@/lib/admin/resupply-calendar-api";

export function ResupplyOutreachActions({
  recipients,
}: {
  recipients: { id: string; patientName: string }[];
}) {
  const [confirm, dialog] = useConfirmDialog();
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [submittedNames, setSubmittedNames] = useState<Record<string, string>>(
    {},
  );
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: ({
      ids,
      channel,
    }: {
      ids: string[];
      channel: OutreachChannel;
    }) => queueResupplyOutreach(ids, channel),
    onSuccess: (data) => {
      setQueued(
        (previous) =>
          new Set([
            ...previous,
            ...data.results
              .filter((r) => r.status === "queued")
              .map((r) => r.episodeId),
          ]),
      );
      void client.invalidateQueries({
        queryKey: ["admin", "resupply-calendar"],
      });
    },
  });
  const pending = recipients.filter((r) => !queued.has(r.id));
  async function contact(channel: OutreachChannel) {
    const slate = pending.slice(0, 50);
    if (!slate.length || send.isPending || reviewing) return;
    setReviewing(true);
    const label =
      channel === "voice"
        ? "automated resupply calls"
        : `${channel === "sms" ? "SMS" : "email"} reminders`;
    const approved = await confirm({
      title: `Queue ${label}?`,
      confirmLabel: "Queue outreach",
      description: (
        <div className="space-y-3">
          <p>
            Ask {slate.length} patient{slate.length === 1 ? "" : "s"} whether
            they still use their supplies and need a refill. Orders require the
            patient's response.
          </p>
          <ul className="max-h-40 overflow-auto list-disc pl-5">
            {slate.map((r) => (
              <li key={r.id}>{r.patientName}</li>
            ))}
          </ul>
          <p>
            Patients contacted in the last 48 hours, those not due, and those
            missing contact details are skipped. SMS and calls respect local
            contact hours.
          </p>
        </div>
      ),
    });
    setReviewing(false);
    if (!approved) return;
    setSubmittedNames(
      Object.fromEntries(slate.map((r) => [r.id, r.patientName])),
    );
    send.mutate({ ids: slate.map((r) => r.id), channel });
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          intent="secondary"
          disabled={!pending.length || send.isPending || pending.length > 50}
          onClick={() => void contact("email")}
        >
          <Mail className="h-4 w-4" /> Email
        </Button>
        <Button
          size="sm"
          intent="secondary"
          disabled={!pending.length || send.isPending || pending.length > 50}
          onClick={() => void contact("sms")}
        >
          <MessageSquare className="h-4 w-4" /> SMS
        </Button>
        <Button
          size="sm"
          intent="secondary"
          disabled={!pending.length || send.isPending || pending.length > 50}
          onClick={() => void contact("voice")}
        >
          <Phone className="h-4 w-4" /> Automated call
        </Button>
        <span className="text-xs text-muted-foreground">
          {send.isPending
            ? "Queueing outreach…"
            : `${recipients.length} selected · ${pending.length} ready to queue · up to 50 per batch`}
        </span>
      </div>
      {send.isError && <ErrorPanel error={send.error} />}
      {send.data && (
        <div role="status" className="rounded border p-3 text-sm space-y-1">
          <p className="font-semibold">
            {send.data.results.filter((r) => r.status === "queued").length}{" "}
            queued ·{" "}
            {send.data.results.filter((r) => r.status === "skipped").length}{" "}
            skipped ·{" "}
            {send.data.results.filter((r) => r.status === "error").length}{" "}
            failed
          </p>
          {send.data.results.map((r) => (
            <p key={r.episodeId}>
              {submittedNames[r.episodeId] ?? "Patient"}: {r.message}
            </p>
          ))}
          <p>
            Queued means accepted for processing. Review delivery and patient
            replies in Conversations.
          </p>
        </div>
      )}
      {dialog}
    </div>
  );
}
