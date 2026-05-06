import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  useGetReminderSubscription,
  getGetReminderSubscriptionQueryKey,
  useUpdateReminderSubscription,
  useUnsubscribeFromReminders,
  ApiError,
} from "@workspace/api-client-react/storefront";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { CheckCircle2, ShieldOff, BellOff } from "lucide-react";
import {
  REMINDER_ITEMS,
  todayIso,
  type ReminderSku,
} from "@/lib/reminder-defaults";

const PAGE_TITLE = "Manage your reminders";

interface ItemState {
  enabled: boolean;
  lastReplacedAt: string;
  intervalDays: number;
}

function buildState(
  serverItems: Array<{
    sku: string;
    lastReplacedAt: string;
    intervalDays: number;
  }>,
): Record<ReminderSku, ItemState> {
  const today = todayIso();
  const out = {} as Record<ReminderSku, ItemState>;
  for (const def of REMINDER_ITEMS) {
    const found = serverItems.find((i) => i.sku === def.sku);
    out[def.sku] = found
      ? {
          enabled: true,
          lastReplacedAt: found.lastReplacedAt,
          intervalDays: found.intervalDays,
        }
      : {
          enabled: false,
          lastReplacedAt: today,
          intervalDays: def.defaultIntervalDays,
        };
  }
  return out;
}

export function RemindersManage() {
  useDocumentTitle(PAGE_TITLE);
  const search = useSearch();
  const token = useMemo(
    () => new URLSearchParams(search).get("token") ?? "",
    [search],
  );

  // The Orval-generated hook's typed `query` option requires `queryKey`
  // even though the runtime defaults it from the params — pass it
  // explicitly via the helper so TypeScript is satisfied.
  const { data, isLoading, error } = useGetReminderSubscription(
    { token },
    {
      query: {
        enabled: token.length > 0,
        queryKey: getGetReminderSubscriptionQueryKey({ token }),
      },
    },
  );
  const update = useUpdateReminderSubscription();
  const unsub = useUnsubscribeFromReminders();

  const [items, setItems] = useState<Record<ReminderSku, ItemState> | null>(
    null,
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);
  // Inline validation message — used when the user tries to Save with
  // every box unchecked. Previously that was a silent no-op; now we
  // explain the choice (keep ≥1 item OR use Unsubscribe).
  const [validationError, setValidationError] = useState<string | null>(null);

  // Re-seed local state whenever the server data changes (e.g. after a save).
  useEffect(() => {
    if (data?.items) setItems(buildState(data.items));
  }, [data]);

  if (!token) {
    return (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-xl mx-auto px-4 py-16"
        >
          <Card className="border-0 glass-card rounded-2xl">
            <CardHeader className="text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
                <ShieldOff className="w-6 h-6" />
              </div>
              <CardTitle>Manage link missing</CardTitle>
              <CardDescription>
                This page needs the link from your subscription confirmation
                email. If you've lost it, just sign up again with the same email
                — we'll send a fresh manage link.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <Link href="/reminders">
                <Button>Go to signup</Button>
              </Link>
            </CardContent>
          </Card>
        </main>
    );
  }

  if (isLoading) {
    return (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-3xl mx-auto px-4 py-10 space-y-4"
        >
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </main>
    );
  }

  if (error) {
    const apiError = error as ApiError | null;
    const status = apiError?.status ?? 0;
    return (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-xl mx-auto px-4 py-16"
        >
          <Card className="border-0 glass-card rounded-2xl">
            <CardHeader className="text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
                <ShieldOff className="w-6 h-6" />
              </div>
              <CardTitle>
                {status === 404
                  ? "Subscription not found"
                  : "Could not load subscription"}
              </CardTitle>
              <CardDescription>
                {status === 404
                  ? "This link doesn't match an active subscription. It may have been used after unsubscribing — sign up again to start fresh."
                  : "Try refreshing in a moment. If this keeps happening, sign up again."}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <Link href="/reminders">
                <Button>Go to signup</Button>
              </Link>
            </CardContent>
          </Card>
        </main>
    );
  }

  if (unsubscribed) {
    return (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-xl mx-auto px-4 py-16"
        >
          <Card className="border-0 glass-card rounded-2xl">
            <CardHeader className="text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
                <BellOff className="w-6 h-6" />
              </div>
              <CardTitle>You've been unsubscribed</CardTitle>
              <CardDescription>
                We won't send you any more reminders. Changed your mind? You can
                sign up again any time.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center space-y-2">
              <Link href="/reminders">
                <Button>Sign up again</Button>
              </Link>
            </CardContent>
          </Card>
        </main>
    );
  }

  if (!items || !data) return null;

  function toggleItem(sku: ReminderSku, checked: boolean) {
    // Clear the "pick at least one" warning the moment the user does
    // anything corrective, otherwise the alert lingers stale.
    if (checked && validationError) setValidationError(null);
    // Clear "Saved <time> ago" the moment the user edits anything —
    // otherwise a stale "Saved" banner reappears next to unsaved
    // edits and falsely implies the new changes are persisted.
    if (savedAt) setSavedAt(null);
    setItems((prev) =>
      prev ? { ...prev, [sku]: { ...prev[sku], enabled: checked } } : prev,
    );
  }
  function updateItemField(sku: ReminderSku, patch: Partial<ItemState>) {
    // Same rationale as toggleItem — any field edit invalidates the
    // post-save confirmation banner.
    if (savedAt) setSavedAt(null);
    setItems((prev) =>
      prev ? { ...prev, [sku]: { ...prev[sku], ...patch } } : prev,
    );
  }

  function onSave() {
    if (!items) return;
    const enabled = REMINDER_ITEMS.filter((d) => items[d.sku].enabled).map(
      (d) => ({
        sku: d.sku,
        lastReplacedAt: items[d.sku].lastReplacedAt,
        intervalDays: items[d.sku].intervalDays,
      }),
    );
    if (enabled.length === 0) {
      // Surface this rather than silently swallowing the click — a user
      // who unchecked everything and pressed Save would otherwise see no
      // feedback at all and assume something was broken.
      setValidationError(
        "Pick at least one supply to keep reminders for, or use Unsubscribe below if you want to stop all reminders.",
      );
      return;
    }
    setValidationError(null);
    update.mutate(
      { params: { token }, data: { items: enabled } },
      { onSuccess: () => setSavedAt(Date.now()) },
    );
  }

  function onUnsubscribe() {
    unsub.mutate(
      { params: { token } },
      { onSuccess: () => setUnsubscribed(true) },
    );
  }

  return (
      <main
        id="main-content"
        tabIndex={-1}
        className="relative z-10 container max-w-3xl mx-auto px-4 py-10 space-y-6"
      >
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Manage reminders
          </h1>
          <p className="text-muted-foreground mt-2">
            Reminders for <span className="font-medium">{data.email}</span>.
            Update your dates after you swap supplies so we don't ping you about
            something you've already taken care of.
          </p>
        </div>

        {savedAt && !validationError && (
          <Alert>
            <CheckCircle2 className="w-4 h-4" />
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>Your reminders are up to date.</AlertDescription>
          </Alert>
        )}

        {validationError && (
          <Alert variant="destructive" data-testid="reminders-validation-error">
            <ShieldOff className="w-4 h-4" />
            <AlertTitle>Pick at least one supply</AlertTitle>
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl">Your supplies</CardTitle>
            <CardDescription>
              Uncheck anything you no longer want reminders for.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {REMINDER_ITEMS.map((def) => {
                const state = items[def.sku];
                return (
                  <div
                    key={def.sku}
                    className="rounded-xl border bg-background/60 p-4 space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`m-${def.sku}`}
                        checked={state.enabled}
                        onCheckedChange={(c) => toggleItem(def.sku, c === true)}
                        data-testid={`checkbox-manage-${def.sku}`}
                      />
                      <div className="flex-1">
                        <Label
                          htmlFor={`m-${def.sku}`}
                          className="text-base cursor-pointer"
                        >
                          {def.label}
                        </Label>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {def.description}
                        </p>
                      </div>
                    </div>
                    {state.enabled && (
                      <div className="grid sm:grid-cols-2 gap-3 pl-7">
                        <div className="space-y-1">
                          <Label
                            htmlFor={`m-last-${def.sku}`}
                            className="text-xs text-muted-foreground"
                          >
                            Last replaced
                          </Label>
                          <Input
                            id={`m-last-${def.sku}`}
                            type="date"
                            max={todayIso()}
                            value={state.lastReplacedAt}
                            onChange={(e) =>
                              updateItemField(def.sku, {
                                lastReplacedAt: e.target.value,
                              })
                            }
                            data-testid={`input-manage-last-${def.sku}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label
                            htmlFor={`m-int-${def.sku}`}
                            className="text-xs text-muted-foreground"
                          >
                            Remind every (days)
                          </Label>
                          <Input
                            id={`m-int-${def.sku}`}
                            type="number"
                            min={1}
                            max={365}
                            value={state.intervalDays}
                            onChange={(e) =>
                              updateItemField(def.sku, {
                                intervalDays: Math.max(
                                  1,
                                  Math.min(
                                    365,
                                    Number(e.target.value) ||
                                      def.defaultIntervalDays,
                                  ),
                                ),
                              })
                            }
                            data-testid={`input-manage-interval-${def.sku}`}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {update.error && (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>
                  Could not save changes. Try again in a moment.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-3 mt-6">
              <Button
                onClick={onSave}
                disabled={update.isPending}
                data-testid="button-save-manage"
              >
                {update.isPending ? "Saving..." : "Save changes"}
              </Button>
              <Button
                variant="outline"
                onClick={onUnsubscribe}
                disabled={unsub.isPending}
                data-testid="button-unsubscribe"
              >
                {unsub.isPending
                  ? "Unsubscribing..."
                  : "Unsubscribe from all reminders"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
  );
}
