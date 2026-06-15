import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAdminReminders,
  sendDueReminders,
  type AdminReminderSubscriber,
} from "@/lib/admin/storefront-admin-api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/admin/ui-shims";
import { Button } from "@/components/admin/ui-shims";
import { Badge } from "@/components/admin/ui-shims";
import { Skeleton } from "@/components/admin/ui-shims";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/admin/ui-shims";
import { Bell, Send, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";
import { labelForSku } from "@/lib/admin/reminder-skus";
import { formatAppDate, todayAppDateIso } from "@/lib/utils";

export function AdminReminders() {
  useDocumentTitle("Admin · Reminders");
  const queryClient = useQueryClient();
  const [confirmingSend, setConfirmingSend] = useState(false);

  const list = useQuery({
    queryKey: ["admin-reminders"],
    queryFn: fetchAdminReminders,
  });

  const send = useMutation({
    mutationFn: sendDueReminders,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-reminders"] });
      setConfirmingSend(false);
    },
    onError: () => {
      // Drop back out of the confirm state so retrying after a failure
      // takes two deliberate clicks again — not one accidental one.
      setConfirmingSend(false);
    },
  });

  const subs = list.data?.subscribers ?? [];
  const totalDue = subs.reduce((acc, s) => acc + s.dueCount, 0);
  const activeCount = subs.filter((s) => s.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Reminders</h1>
          <p className="text-muted-foreground mt-1">
            People who asked to be reminded when supplies are due. Click “Send
            due reminders now” to email everyone whose next reminder falls
            today.
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {list.isLoading
              ? "Loading…"
              : `${subs.length} total · ${activeCount} active · ${totalDue} item${totalDue === 1 ? "" : "s"} due today`}
          </p>
        </div>
        <Button
          onClick={() =>
            confirmingSend ? send.mutate() : setConfirmingSend(true)
          }
          disabled={send.isPending || list.isLoading}
          data-testid="button-send-due"
        >
          <Send className="w-4 h-4 mr-2" />
          {send.isPending
            ? "Sending..."
            : confirmingSend
              ? "Click again to confirm"
              : "Send due reminders now"}
        </Button>
      </div>

      {send.data && (
        <Alert>
          {send.data.failed > 0 ? (
            <AlertTriangle className="w-4 h-4" />
          ) : (
            <CheckCircle2 className="w-4 h-4" />
          )}
          <AlertTitle>Batch complete</AlertTitle>
          <AlertDescription>
            Sent {send.data.sent} · Skipped within quiet period{" "}
            {send.data.skippedQuiet} · Skipped (no items due){" "}
            {send.data.skippedNoneDue} · Failed {send.data.failed}
            {!send.data.sendgridConfigured && (
              <span className="block mt-1 text-amber-700">
                Email sending is turned off in this environment, so no reminders
                actually went out. Ask an engineer to enable email delivery
                before running this in production.
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* A failed batch must be loud (app-review 2026-06-10, P2-13):
          with no error rendered, the operator's natural reaction is to
          click "Send" again — and if the failure happened mid-batch,
          a re-click risks double-sending to anyone already texted. */}
      {send.error && (
        <Alert variant="destructive" data-testid="alert-send-failed">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Send failed</AlertTitle>
          <AlertDescription>
            The reminder batch did not complete. Some reminders may already have
            gone out — check the conversations inbox before retrying to avoid
            double-sending.
          </AlertDescription>
        </Alert>
      )}

      {list.error && (
        <Alert variant="destructive">
          <AlertDescription>Could not load subscribers.</AlertDescription>
        </Alert>
      )}

      {list.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : subs.length === 0 ? (
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader className="text-center space-y-3">
            <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-gold flex items-center justify-center">
              <Bell className="w-6 h-6" />
            </div>
            <CardTitle>No subscribers yet</CardTitle>
            <CardDescription>
              When customers sign up at /reminders they'll show up here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {subs.map((s) => (
            <SubscriberRow key={s.id} sub={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubscriberRow({ sub }: { sub: AdminReminderSubscriber }) {
  const today = todayAppDateIso();
  return (
    <Card className="border-0 glass-card rounded-2xl">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium" data-testid={`text-sub-email-${sub.id}`}>
              {sub.email}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Joined {formatAppDate(sub.createdAt)}
              {sub.lastSentAt &&
                ` · last reminded ${formatAppDate(sub.lastSentAt)}`}
            </p>
          </div>
          <div className="flex gap-2">
            {sub.status === "unsubscribed" && (
              <Badge variant="outline">Unsubscribed</Badge>
            )}
            {sub.dueCount > 0 && sub.status === "active" && (
              <Badge className="bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-gold))]">
                {sub.dueCount} due
              </Badge>
            )}
          </div>
        </div>
        <ul className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {sub.items.map((item) => {
            const isDue = item.nextDueAt <= today;
            return (
              <li
                key={item.sku}
                className={isDue ? "text-amber-700" : "text-muted-foreground"}
              >
                {labelForSku(item.sku)} — next {item.nextDueAt}
                {isDue && " (due)"}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
