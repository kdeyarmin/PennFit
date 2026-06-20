// Stripe Connect (Express) onboarding card — rendered on the
// /admin/billing/config/organization page (the return target for Stripe's
// hosted onboarding). Lets a tenant owner connect their own Stripe account
// so their storefront charges land in THEIR books.
//
// Flow:
//   * Not connected            → "Connect Stripe account" → POST /start,
//                                 redirect to Stripe's hosted onboarding.
//   * Connected, not enabled   → onboarding incomplete; "Continue
//                                 onboarding" (fresh link) + "Refresh
//                                 status" (reconcile from Stripe).
//   * Connected, charges on    → "Active"; charges route to this account.
//
// Stripe redirects back here with ?stripe_connect=return|refresh:
//   * return  → re-reconcile status (the webhook may not have landed yet).
//   * refresh → the prior onboarding link expired; mint a fresh one and
//               redirect straight back into Stripe (Stripe's intended use).

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink, RefreshCw } from "lucide-react";

import { Card } from "@/components/admin/Card";
import {
  disconnectStripeConnect,
  fetchStripeConnectStatus,
  refreshStripeConnectStatus,
  startStripeConnectOnboarding,
} from "@/lib/admin/stripe-connect-api";

const STATUS_KEY = ["admin", "stripe-connect", "status"] as const;

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function StripeConnectCard() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: fetchStripeConnectStatus,
  });

  const [notice, setNotice] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: startStripeConnectOnboarding,
    onSuccess: (res) => {
      // Hand off to Stripe's hosted onboarding.
      window.location.assign(res.url);
    },
  });

  const refresh = useMutation({
    mutationFn: refreshStripeConnectStatus,
    onSuccess: (res) => {
      queryClient.setQueryData(STATUS_KEY, res);
      setNotice(
        res.chargesEnabled
          ? "Onboarding complete — charges now route to your Stripe account."
          : "Stripe hasn't enabled charges yet. Finish onboarding, then refresh.",
      );
    },
  });

  const disconnect = useMutation({
    mutationFn: disconnectStripeConnect,
    onSuccess: (res) => {
      queryClient.setQueryData(STATUS_KEY, res);
      setNotice("Disconnected. Charges route to the platform account.");
    },
  });

  // Handle Stripe's return/refresh redirect exactly once.
  const handledRedirect = useRef(false);
  useEffect(() => {
    if (handledRedirect.current) return;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("stripe_connect");
    if (mode !== "return" && mode !== "refresh") return;
    handledRedirect.current = true;
    // Strip the param so a manual page refresh doesn't re-trigger.
    params.delete("stripe_connect");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    if (mode === "refresh") {
      // The onboarding link expired — mint a fresh one and bounce back in.
      start.mutate();
    } else {
      // Returned from onboarding — the webhook may not have landed yet, so
      // reconcile straight from Stripe.
      refresh.mutate();
    }
    // start/refresh are stable mutation handles; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = start.isPending || refresh.isPending || disconnect.isPending;

  let badge: { text: string; color: string };
  if (!data?.connected) {
    badge = { text: "Not connected", color: "hsl(var(--ink-3))" };
  } else if (data.chargesEnabled) {
    badge = { text: "Active", color: "#15803d" };
  } else {
    badge = { text: "Onboarding incomplete", color: "#b45309" };
  }

  return (
    <Card title="Payments — Stripe Connect">
      <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Connect your own Stripe account so storefront and patient-balance
        charges are collected in <strong>your</strong> books. Until you finish
        onboarding, charges keep running on the platform account. Disconnecting
        routes them back to the platform; it does not delete your Stripe
        account.
      </p>

      {isPending ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Loading status…
        </p>
      ) : isError ? (
        <div className="text-sm" style={{ color: "#dc2626" }}>
          {errMessage(error, "Could not load Stripe Connect status.")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void refetch()}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>Status:</span>
            <span className="font-semibold" style={{ color: badge.color }}>
              {badge.text}
            </span>
            {data?.accountId && (
              <code className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {data.accountId}
              </code>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!data?.connected ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "hsl(var(--penn-navy))" }}
                disabled={busy}
                onClick={() => start.mutate()}
              >
                <CreditCard className="h-4 w-4" />
                {start.isPending ? "Connecting…" : "Connect Stripe account"}
              </button>
            ) : (
              <>
                {!data.chargesEnabled && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    style={{ background: "hsl(var(--penn-navy))" }}
                    disabled={busy}
                    onClick={() => start.mutate()}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {start.isPending ? "Opening…" : "Continue onboarding"}
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: "hsl(var(--line))" }}
                  disabled={busy}
                  onClick={() => refresh.mutate()}
                >
                  <RefreshCw className="h-4 w-4" />
                  {refresh.isPending ? "Refreshing…" : "Refresh status"}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  style={{ borderColor: "hsl(var(--line))", color: "#dc2626" }}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disconnect this Stripe account? Charges will route to the platform account until you reconnect.",
                      )
                    ) {
                      disconnect.mutate();
                    }
                  }}
                >
                  {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
                </button>
              </>
            )}
          </div>

          {notice && (
            <p className="mt-3 text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              {notice}
            </p>
          )}
          {(start.isError || refresh.isError || disconnect.isError) && (
            <p className="mt-3 text-sm" style={{ color: "#dc2626" }}>
              {errMessage(
                start.error ?? refresh.error ?? disconnect.error,
                "Action failed. Please try again.",
              )}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default StripeConnectCard;
