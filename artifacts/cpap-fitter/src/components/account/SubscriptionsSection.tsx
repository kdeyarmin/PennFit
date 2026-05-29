// /account → "Auto-ship subscriptions" section.
//
// Patient-managed Subscribe & Save lines. Self-fetches on mount
// (subscriptions live on a separate endpoint from /shop/me) so the
// section has its own loading / empty / mixed state without
// widening the /shop/me response.
//
// Hidden when the user has zero subscriptions — the section's
// whole point is to be a quiet management surface, not to
// advertise the feature on accounts that haven't tried it.
//
// Major moving pieces inside this component:
//   - Per-row pause / resume / cancel / change-cadence actions
//   - Bulk "Pause all (travel mode)" + "Resume all"
//   - Cancel-intercept dialog that offers "Pause instead" before
//     letting the customer follow through with a hard cancel
//   - Cadence-change dialog with lazy-fetched Stripe options
//
// Pause / resume / cancel actions share the row-level `pending`
// state to keep those buttons from racing each other, while the
// cadence-change flow tracks its own submitting state.

import { useEffect, useRef, useState } from "react";

import {
  AlertCircle,
  CalendarClock,
  Loader2,
  Pause,
  Play,
  Repeat,
  Settings2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  cancelShopSubscription,
  changeShopSubscriptionCadence,
  fetchShopCadenceOptions,
  fetchShopMySubscriptions,
  pauseShopSubscription,
  resumeShopSubscription,
  type ShopCadenceOption,
  type ShopSubscriptionView,
} from "@/lib/account-api";
import { formatMoneyCents } from "@/lib/shop-api";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

type PendingAction = "cancel" | "pause" | "resume";

/**
 * Render the "Auto-ship subscriptions" management section with per-row controls
 * (pause, resume, cancel, change cadence) and bulk travel-mode actions.
 *
 * The section self-loads the current user's subscriptions on mount and hides
 * itself when no subscriptions are available or while initially loading.
 *
 * @param previewMode - When `true`, interactive actions are disabled (used when Stripe
 *   is not connected or the UI is in preview state).
 * @returns The subscriptions management section element, or `null` when loading or when
 *   the user has no subscriptions.
 */
export function SubscriptionsSection({
  previewMode,
}: {
  previewMode: boolean;
}) {
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [subs, setSubs] = useState<ShopSubscriptionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    action: PendingAction;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Cadence dialog state. Held at the section level (not per-row) so
  // we can render a single shared <Dialog> instead of N dialogs.
  const [cadenceSub, setCadenceSub] = useState<ShopSubscriptionView | null>(
    null,
  );
  const [cadenceOptions, setCadenceOptions] = useState<
    ShopCadenceOption[] | null
  >(null);
  const [cadenceLoadError, setCadenceLoadError] = useState<string | null>(null);
  const [cadenceSelectedPriceId, setCadenceSelectedPriceId] = useState<
    string | null
  >(null);
  const [cadenceSubmitting, setCadenceSubmitting] = useState(false);
  // Tracks which subscription's options fetch is in flight so stale
  // responses from a previous open can't overwrite the current dialog.
  const cadenceRequestSubIdRef = useRef<string | null>(null);

  // Cancel-intercept dialog — offers "Pause instead" before letting
  // the customer follow through with a hard cancel. Holds the
  // subscription targeted for cancellation (or null when closed)
  // plus an optional reason the customer chose, so we can log /
  // analyze later when we add a reasons table. The reason itself
  // is stored in component state only for now (no backend yet) —
  // the immediate goal is the deflection moment, not the analytics.
  const [cancelInterceptSub, setCancelInterceptSub] =
    useState<ShopSubscriptionView | null>(null);

  // Travel-mode bulk pause/resume in-flight flag.
  const [travelModeBusy, setTravelModeBusy] = useState(false);
  const [travelModeError, setTravelModeError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const r = await fetchShopMySubscriptions();
      setSubs(r.subscriptions);
    } catch (err: unknown) {
      // Treat 404 (route absent — preview mode without Stripe) and
      // every other read error the same: show nothing rather than a
      // scary banner. The section is opt-in surface; failing closed
      // is the right call.
      setSubs([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function isPending(id: string, action?: PendingAction) {
    if (!pending || pending.id !== id) return false;
    return action ? pending.action === action : true;
  }

  function handleCancel(sub: ShopSubscriptionView) {
    if (pending || travelModeBusy) return;
    // Open the cancel-intercept dialog instead of going straight to
    // a confirm-and-cancel. The dialog surfaces "Pause instead" as
    // the primary CTA — most patients who hit cancel just need a
    // break (vacation, hospital stay, supply backlog) rather than a
    // permanent stop. The native confirm() flow buried that option.
    setCancelInterceptSub(sub);
    setActionError(null);
  }

  async function confirmCancel(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "cancel" });
    setActionError(null);
    try {
      await cancelShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function pauseFromIntercept(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Pause / resume — both buttons are always shown when the sub is
  // active and not pending cancellation. We don't track local pause
  // state (no schema slice), so showing both lets the patient pick the
  // intent without us having to guess Stripe's `pause_collection`
  // value. Both endpoints are idempotent server-side.
  async function handlePause(sub: ShopSubscriptionView) {
    if (pending || travelModeBusy) return;
    if (
      !(await confirm({
        title: "Pause auto-ship?",
        description:
          "We'll stop charging your card and shipping until you resume. Your subscription stays active so you can pick up where you left off.",
        confirmLabel: "Pause",
      }))
    ) {
      return;
    }
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function handleResume(sub: ShopSubscriptionView) {
    if (pending || travelModeBusy) return;
    setPending({ id: sub.id, action: "resume" });
    setActionError(null);
    try {
      await resumeShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Travel mode — bulk-pause or bulk-resume every applicable
  // subscription with one click. Sequential rather than Promise.all so
  // we surface partial-failure state (Stripe rate limits + retry).
  // We don't store a "travel mode active" flag locally; the truth is
  // the subscriptions' actual paused/active state, which the next
  // load() reflects.
  async function bulkPauseAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await pauseShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be paused. ` +
          "Try the per-row Pause button.",
      );
    }
  }

  async function bulkResumeAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await resumeShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be resumed. ` +
          "Try the per-row Resume button.",
      );
    }
  }

  // Cadence dialog — opened by clicking "Change cadence" on a row.
  // We fetch the option list lazily on open (Stripe round-trip) so
  // the patient pays the latency only when they actually want it.
  async function openCadenceDialog(sub: ShopSubscriptionView) {
    setCadenceSub(sub);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
    cadenceRequestSubIdRef.current = sub.id;
    try {
      const r = await fetchShopCadenceOptions(sub.id);
      if (cadenceRequestSubIdRef.current !== sub.id) return;
      setCadenceOptions(r.options);
      // Default-select the current cadence so the radio group has
      // a chosen value immediately (better than empty selection).
      const current = r.options.find((o) => o.isCurrent);
      if (current) setCadenceSelectedPriceId(current.priceId);
    } catch (err: unknown) {
      if (cadenceRequestSubIdRef.current !== sub.id) return;
      setCadenceLoadError(err instanceof Error ? err.message : String(err));
      setCadenceOptions([]);
    }
  }

  function closeCadenceDialog() {
    if (cadenceSubmitting) return;
    cadenceRequestSubIdRef.current = null;
    setCadenceSub(null);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
  }

  async function handleCadenceConfirm() {
    if (!cadenceSub || !cadenceSelectedPriceId) return;
    // No-op if the patient didn't actually change their selection —
    // the server short-circuits this too, but skipping the round-trip
    // makes the UX feel snappier on close.
    const current = cadenceOptions?.find((o) => o.isCurrent);
    if (current?.priceId === cadenceSelectedPriceId) {
      closeCadenceDialog();
      return;
    }
    setCadenceSubmitting(true);
    setActionError(null);
    try {
      await changeShopSubscriptionCadence(
        cadenceSub.id,
        cadenceSelectedPriceId,
      );
      await load();
      // Close AFTER the load completes so the dialog visibly reflects
      // the new state on the row underneath when it disappears.
      setCadenceSub(null);
      setCadenceOptions(null);
      setCadenceSelectedPriceId(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCadenceSubmitting(false);
    }
  }

  // While loading, render nothing — avoids flicker for the common
  // case of "this user has no subscriptions" which is the empty-state
  // we hide entirely.
  if (subs === null) return null;
  if (subs.length === 0) {
    // Hide the section entirely when empty (per spec). The load
    // error, if any, surfaces only on next mount — accept that as a
    // tradeoff to keep the empty-state silent.
    if (loadError) {
      // dev-mode breadcrumb; never user-visible.
      console.debug("[account] subscriptions load skipped:", loadError);
    }
    return null;
  }

  return (
    <section
      id="autoship"
      className="glass-card rounded-2xl p-6 scroll-mt-24"
      data-testid="account-subscriptions-section"
    >
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Auto-ship subscriptions</h2>
        </div>
        {(() => {
          // Bulk pause-everything is only useful when there's at least one
          // subscription that could meaningfully change. We show "Pause
          // all" if anything is active and "Resume all" if every active
          // subscription is paused (Stripe `paused` status). When the
          // collection is mixed we render Pause All — pausing what's
          // active is the higher-leverage action.
          const pauseTargets = subs.filter(
            (s) => s.status === "active" || s.status === "trialing",
          );
          const pausedTargets = subs.filter((s) => s.status === "paused");
          if (pauseTargets.length > 0) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkPauseAll(pauseTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-pause-all"
                title="Pause every active auto-ship — useful for travel or hospital stays."
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Pausing all…
                  </>
                ) : (
                  <>Pause all (travel mode)</>
                )}
              </Button>
            );
          }
          if (pausedTargets.length > 1) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkResumeAll(pausedTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-resume-all"
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Resuming all…
                  </>
                ) : (
                  <>Resume all</>
                )}
              </Button>
            );
          }
          return null;
        })()}
      </div>
      {travelModeError && (
        <p
          className="text-xs text-rose-700 mb-3"
          role="alert"
          data-testid="account-travel-mode-error"
        >
          {travelModeError}
        </p>
      )}
      <ul className="divide-y divide-border/40">
        {subs.map((sub) => {
          const isActive = sub.status === "active" || sub.status === "trialing";
          const isPastDue =
            sub.status === "past_due" || sub.status === "unpaid";
          const isCanceled =
            sub.status === "canceled" || sub.status === "incomplete_expired";
          const nextShip = sub.currentPeriodEnd
            ? new Date(sub.currentPeriodEnd)
            : null;
          return (
            <li
              key={sub.id}
              className="py-4 first:pt-0 last:pb-0"
              data-testid={`account-subscription-${sub.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <ul className="space-y-1">
                    {sub.items.map((item) => (
                      <li
                        key={item.priceId}
                        className="text-sm font-medium tabular-nums"
                      >
                        {item.quantity > 1 ? `${item.quantity}× ` : ""}
                        {item.name ?? item.priceId}
                        {item.intervalLabel && (
                          <span className="text-xs text-muted-foreground ml-2 font-normal">
                            every {item.intervalLabel}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {nextShip && isActive && !sub.cancelAtPeriodEnd && (
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" />
                        Next ship{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {sub.cancelAtPeriodEnd && nextShip && (
                      <span className="inline-flex items-center gap-1 text-[hsl(var(--penn-navy))]">
                        <XCircle className="h-3 w-3" />
                        Stops after{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {isPastDue && (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        Payment past due — update card on file
                      </span>
                    )}
                    {isCanceled && (
                      <span className="inline-flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        Canceled
                      </span>
                    )}
                  </div>
                </div>
                {!isCanceled && !sub.cancelAtPeriodEnd && (
                  // Vertical button column on the right keeps the
                  // four CTAs from wrapping awkwardly on mobile, and
                  // lets us put the destructive action visually last.
                  // Pause + Resume are both shown unconditionally
                  // because we don't track local pause state — see
                  // the comment block at the top of the section.
                  <div className="flex flex-col items-stretch gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        previewMode || isPending(sub.id) || travelModeBusy
                      }
                      onClick={() => void handlePause(sub)}
                      data-testid={`account-subscription-pause-${sub.id}`}
                      title={
                        previewMode
                          ? "Pause will be available once Stripe is connected."
                          : "Pause auto-ship and stop charges until you resume."
                      }
                    >
                      {isPending(sub.id, "pause") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Pausing…
                        </>
                      ) : (
                        <>
                          <Pause className="h-3.5 w-3.5 mr-1.5" />
                          Pause
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        previewMode || isPending(sub.id) || travelModeBusy
                      }
                      onClick={() => void handleResume(sub)}
                      data-testid={`account-subscription-resume-${sub.id}`}
                      title={
                        previewMode
                          ? "Resume will be available once Stripe is connected."
                          : "Resume auto-ship if it's currently paused."
                      }
                    >
                      {isPending(sub.id, "resume") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Resuming…
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 mr-1.5" />
                          Resume
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        previewMode || isPending(sub.id) || travelModeBusy
                      }
                      onClick={() => void openCadenceDialog(sub)}
                      data-testid={`account-subscription-cadence-${sub.id}`}
                      title={
                        previewMode
                          ? "Cadence changes will be available once Stripe is connected."
                          : "Change how often supplies arrive."
                      }
                    >
                      <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                      Change cadence
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        previewMode || isPending(sub.id) || travelModeBusy
                      }
                      onClick={() => void handleCancel(sub)}
                      data-testid={`account-subscription-cancel-${sub.id}`}
                      title={
                        previewMode
                          ? "Auto-ship will be cancellable as soon as Stripe is connected."
                          : undefined
                      }
                    >
                      {isPending(sub.id, "cancel") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Cancelling…
                        </>
                      ) : (
                        "Cancel auto-ship"
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {actionError && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="account-subscription-action-error"
          role="alert"
        >
          {actionError}
        </p>
      )}

      {/* Cadence-change dialog — shared across all rows; opens with
          the row's options pre-fetched. We render the radio group
          inline (rather than a Select) because older patients find
          radios easier to scan and the option list is short (≤ ~6). */}
      <Dialog
        open={cadenceSub !== null}
        onOpenChange={(o) => {
          if (!o) closeCadenceDialog();
        }}
      >
        <DialogContent
          data-testid="account-cadence-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Change auto-ship cadence</DialogTitle>
            <DialogDescription>
              Choose how often you'd like your supplies to ship. Changes apply
              to your next order — we won't re-charge you for the current
              period.
            </DialogDescription>
          </DialogHeader>
          {cadenceOptions === null && !cadenceLoadError && (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading options…
            </div>
          )}
          {cadenceLoadError && (
            <p className="py-4 text-sm text-destructive">
              Couldn't load cadence options. Please try again.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No alternate shipping cadences are available for this product.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length > 0 && (
            <RadioGroup
              value={cadenceSelectedPriceId ?? ""}
              onValueChange={(v) => setCadenceSelectedPriceId(v)}
              className="space-y-2 py-2"
            >
              {cadenceOptions.map((opt) => {
                const inputId = `cadence-opt-${opt.priceId}`;
                const price =
                  opt.unitAmountCents != null && opt.currency
                    ? formatMoneyCents(opt.unitAmountCents, opt.currency)
                    : null;
                return (
                  <div
                    key={opt.priceId}
                    className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 hover:bg-accent/30"
                  >
                    <RadioGroupItem value={opt.priceId} id={inputId} />
                    <Label
                      htmlFor={inputId}
                      className="flex-1 cursor-pointer text-sm font-normal"
                    >
                      <span className="font-medium">
                        Every {opt.intervalLabel}
                      </span>
                      {price && (
                        <span className="ml-2 text-muted-foreground tabular-nums">
                          · {price}
                        </span>
                      )}
                      {opt.isCurrent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (current)
                        </span>
                      )}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeCadenceDialog}
              disabled={cadenceSubmitting}
              data-testid="account-cadence-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCadenceConfirm()}
              disabled={
                cadenceSubmitting ||
                !cadenceSelectedPriceId ||
                cadenceOptions === null ||
                cadenceOptions.length === 0
              }
              data-testid="account-cadence-confirm"
            >
              {cadenceSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save cadence"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelInterceptSub !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setCancelInterceptSub(null);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          data-testid="account-cancel-intercept-dialog"
        >
          <DialogHeader>
            <DialogTitle>Before you cancel — would a pause work?</DialogTitle>
            <DialogDescription>
              Most patients who hit Cancel just need a temporary break. Pause
              keeps your subscription on file with no charges; you resume in one
              tap when you&apos;re ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-[hsl(var(--penn-gold)/0.4)] bg-[hsl(var(--penn-gold)/0.06)] p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Pause auto-ship instead
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                We&apos;ll stop charging your card and pause shipments. Your
                cadence and payment method stay on file. Resume anytime from
                this page.
              </p>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Cancel for good
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Your supplies will keep shipping until the end of the current
                period, then stop. You&apos;ll need to re-subscribe (and
                re-confirm cadence + price) if you change your mind later.
              </p>
            </div>
            {actionError && (
              <p className="text-xs text-rose-700" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setCancelInterceptSub(null)}
              disabled={pending !== null}
              data-testid="account-cancel-intercept-keep"
            >
              Keep auto-ship as-is
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                cancelInterceptSub && void confirmCancel(cancelInterceptSub)
              }
              disabled={pending !== null}
              className="border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              data-testid="account-cancel-intercept-confirm"
            >
              {isPending(cancelInterceptSub?.id ?? "", "cancel") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Canceling…
                </>
              ) : (
                "Cancel anyway"
              )}
            </Button>
            <Button
              onClick={() =>
                cancelInterceptSub &&
                void pauseFromIntercept(cancelInterceptSub)
              }
              disabled={pending !== null}
              data-testid="account-cancel-intercept-pause"
            >
              {isPending(cancelInterceptSub?.id ?? "", "pause") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Pausing…
                </>
              ) : (
                "Pause instead"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialogEl}
    </section>
  );
}
