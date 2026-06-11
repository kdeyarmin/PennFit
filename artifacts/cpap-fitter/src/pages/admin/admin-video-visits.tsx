// /admin/video-visits — telehealth video visits.
//
// An RT or CSR sets up a browser video call with a patient (equipment
// setup walk-through, mask troubleshooting, follow-up), sends the
// patient a join link by SMS/email (or copies it into any channel),
// and joins the call from this page. Media is WebRTC peer-to-peer —
// see components/video-call/.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Send, Video, XCircle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { StartVideoVisitModal } from "@/components/admin/StartVideoVisitModal";
import {
  VideoCallRoom,
  buildSignalWsUrl,
} from "@/components/video-call/VideoCallRoom";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  cancelVideoVisit,
  completeVideoVisit,
  joinVideoVisit,
  listVideoVisits,
  resendVideoVisitInvite,
  type JoinVideoVisitResponse,
  type VideoVisit,
  type VideoVisitPurpose,
} from "@/lib/admin/video-visits-api";

const PURPOSE_LABEL: Record<VideoVisitPurpose, string> = {
  setup: "Equipment setup",
  troubleshooting: "Troubleshooting",
  follow_up: "Follow-up",
  other: "Other",
};

const STATUS_BADGE: Record<
  VideoVisit["status"],
  {
    label: string;
    variant: "neutral" | "info" | "success" | "muted" | "danger";
  }
> = {
  scheduled: { label: "Scheduled", variant: "info" },
  in_progress: { label: "In progress", variant: "success" },
  completed: { label: "Completed", variant: "muted" },
  cancelled: { label: "Cancelled", variant: "danger" },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function AdminVideoVisitsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activeCall, setActiveCall] = useState<JoinVideoVisitResponse | null>(
    null,
  );

  const listKey = ["admin", "video-visits", { showClosed }] as const;
  const visitsQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listVideoVisits({ includeClosed: showClosed }),
    refetchInterval: 30_000,
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin", "video-visits"] });

  const join = useMutation({
    mutationFn: joinVideoVisit,
    onSuccess: (info) => {
      setActiveCall(info);
    },
    onError: () => {
      toast({
        title: "Couldn't join the visit",
        description: "The visit may have been completed or cancelled.",
        variant: "destructive",
      });
      refresh();
    },
  });

  const copyLink = useMutation({
    mutationFn: joinVideoVisit,
    onSuccess: async (info) => {
      const ok = await copyToClipboard(info.patientJoinUrl);
      toast(
        ok
          ? { title: "Patient link copied to clipboard" }
          : {
              title: "Couldn't copy automatically",
              description: info.patientJoinUrl,
            },
      );
    },
  });

  const resend = useMutation({
    mutationFn: (vars: { visitId: string; channel: "email" | "sms" }) =>
      resendVideoVisitInvite(vars.visitId, { channel: vars.channel }),
    onSuccess: (r) => {
      toast(
        r.delivered
          ? { title: "Invite sent" }
          : {
              title: "Invite not delivered",
              description: r.deliveryError ?? "Delivery failed.",
              variant: "destructive",
            },
      );
      refresh();
    },
    onError: () => {
      toast({
        title: "Couldn't send the invite",
        description:
          "Check that the patient has contact info on file and is active.",
        variant: "destructive",
      });
    },
  });

  const cancel = useMutation({
    mutationFn: cancelVideoVisit,
    onSuccess: () => {
      toast({
        title: "Visit cancelled",
        description: "The join link no longer works.",
      });
      refresh();
    },
  });

  const complete = useMutation({
    mutationFn: completeVideoVisit,
    onSuccess: () => {
      toast({ title: "Visit marked completed" });
      refresh();
    },
  });

  const visits = visitsQuery.data?.visits ?? [];

  return (
    <div className="admin-root p-6 space-y-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            <Video className="h-6 w-6" />
            Video visits
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Face-to-face video calls with patients for equipment setups,
            troubleshooting, and follow-ups. Calls are encrypted
            browser-to-browser and never recorded.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New video visit
        </Button>
      </header>

      <Card
        title="Visits"
        action={
          <label
            className="flex items-center gap-2 text-xs"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Show completed & cancelled
          </label>
        }
      >
        {visitsQuery.isPending && <Spinner />}
        {visitsQuery.isError && (
          <ErrorPanel
            error={visitsQuery.error}
            onRetry={() => void visitsQuery.refetch()}
          />
        )}
        {visitsQuery.isSuccess && visits.length === 0 && (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No {showClosed ? "" : "open "}video visits. Create one to send a
            patient a join link.
          </p>
        )}
        {visits.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-xs uppercase tracking-wide"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="py-2 pr-4">Patient</th>
                  <th className="py-2 pr-4">Purpose</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Scheduled</th>
                  <th className="py-2 pr-4">Invite</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => {
                  const badge = STATUS_BADGE[v.status];
                  const open =
                    v.status === "scheduled" || v.status === "in_progress";
                  return (
                    <tr
                      key={v.id}
                      className="border-t align-top"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td className="py-2.5 pr-4 font-medium">
                        {v.patientName ?? "—"}
                        {v.notes && (
                          <p
                            className="mt-0.5 max-w-[28ch] truncate text-xs font-normal"
                            style={{ color: "hsl(var(--ink-3))" }}
                            title={v.notes}
                          >
                            {v.notes}
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {PURPOSE_LABEL[v.purpose] ?? v.purpose}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        {formatDateTime(v.scheduledAt)}
                      </td>
                      <td className="py-2.5 pr-4">
                        {v.inviteChannel === "none" || !v.inviteChannel
                          ? "Link only"
                          : `${v.inviteChannel.toUpperCase()} ${
                              v.inviteDelivered === false
                                ? "(failed)"
                                : v.inviteDelivered
                                  ? "(sent)"
                                  : ""
                            }`}
                      </td>
                      <td className="py-2.5 pr-4">
                        {formatDateTime(v.createdAt)}
                      </td>
                      <td className="py-2.5">
                        {open ? (
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => join.mutate(v.id)}
                              isLoading={
                                join.isPending && join.variables === v.id
                              }
                            >
                              <Video className="h-3.5 w-3.5" />
                              Join
                            </Button>
                            <Button
                              size="sm"
                              intent="secondary"
                              title="Copy the patient's join link"
                              onClick={() => copyLink.mutate(v.id)}
                            >
                              <Copy className="h-3.5 w-3.5" />
                              Copy link
                            </Button>
                            <Button
                              size="sm"
                              intent="ghost"
                              title="Re-send the invite over the original channel (or email if none)"
                              onClick={() =>
                                resend.mutate({
                                  visitId: v.id,
                                  channel:
                                    v.inviteChannel === "sms" ? "sms" : "email",
                                })
                              }
                            >
                              <Send className="h-3.5 w-3.5" />
                              Re-send
                            </Button>
                            <Button
                              size="sm"
                              intent="ghost"
                              onClick={() => {
                                void (async () => {
                                  if (
                                    await confirm({
                                      title: "Mark this visit completed?",
                                      description:
                                        "The patient's join link will stop working.",
                                      confirmLabel: "Mark completed",
                                    })
                                  ) {
                                    complete.mutate(v.id);
                                  }
                                })();
                              }}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Complete
                            </Button>
                            <Button
                              size="sm"
                              intent="ghost"
                              onClick={() => {
                                void (async () => {
                                  if (
                                    await confirm({
                                      title: "Cancel this visit?",
                                      description:
                                        "The patient's join link will stop working immediately.",
                                      confirmLabel: "Cancel visit",
                                    })
                                  ) {
                                    cancel.mutate(v.id);
                                  }
                                })();
                              }}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <span
                            className="text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {formatDateTime(v.endedAt)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <StartVideoVisitModal
          onClose={() => setCreating(false)}
          onCreated={() => refresh()}
        />
      )}

      {activeCall && (
        <VideoCallRoom
          wsUrl={buildSignalWsUrl(activeCall.wsPath, activeCall.staffToken)}
          iceServers={activeCall.iceServers}
          polite={false}
          title={activeCall.visit.patientName ?? "Video visit"}
          peerLabel="the patient"
          waitingMessage="Waiting for the patient to join… They can use the link from their invite."
          endLabel="End visit"
          onExit={() => {
            setActiveCall(null);
            refresh();
          }}
        />
      )}

      {ConfirmDialogEl}
    </div>
  );
}

export default AdminVideoVisitsPage;
