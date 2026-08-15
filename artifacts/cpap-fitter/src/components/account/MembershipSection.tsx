// Self-serve cash-pay membership join.
//
// Lists the membership tiers the storefront offers (GET
// /shop/membership/options) and starts a Stripe subscription Checkout for the
// chosen tier (POST /shop/membership/checkout), redirecting to the hosted
// page. Renders NOTHING when no tiers are configured, so the section is
// invisible in environments without membership prices (fail-soft, matching
// the backend). The customer.subscription.* webhook sets membership_tier on
// the account once the subscription goes active.

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getMembershipOptions,
  startMembershipCheckout,
  type MembershipOption,
} from "@/lib/account/self-service-api";
import { formatMoneyCents } from "@/lib/shop-api";

const TIER_LABELS: Record<string, string> = {
  monthly_unlimited: "Monthly Unlimited",
  quarterly_unlimited: "Quarterly Unlimited",
};

function priceLabel(opt: MembershipOption): string {
  if (opt.unitAmountCents == null) return "Membership";
  const amount = formatMoneyCents(opt.unitAmountCents);
  if (!opt.interval) return amount;
  const every =
    opt.intervalCount && opt.intervalCount > 1
      ? `every ${opt.intervalCount} ${opt.interval}s`
      : `/ ${opt.interval}`;
  return `${amount} ${every}`;
}

export function MembershipSection() {
  const [tiers, setTiers] = useState<MembershipOption[] | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMembershipOptions()
      .then((res) => {
        // Guard the SHAPE, not just the request. A 200 whose body lacks
        // `tiers` (an unseeded demo endpoint, or a mid-deploy proxy serving
        // the SPA shell instead of the API JSON) would otherwise set
        // `tiers` to undefined — and the `tiers === null` check below only
        // short-circuits on null, so `tiers.length` threw and took the
        // whole /account page to the ErrorBoundary. Treat a non-array as
        // "no tiers configured", the same fail-soft posture as the catch.
        if (!cancelled) setTiers(Array.isArray(res?.tiers) ? res.tiers : []);
      })
      .catch(() => {
        if (!cancelled) setTiers([]); // treat a fetch error as "unavailable"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Invisible until we know there's at least one joinable tier.
  if (tiers === null || tiers.length === 0) return null;

  const onJoin = async (tier: string) => {
    setError(null);
    setJoining(tier);
    try {
      const { url } = await startMembershipCheckout(tier);
      if (url) {
        window.location.href = url;
        return;
      }
      setError("We couldn't start checkout. Please try again.");
    } catch {
      setError("We couldn't start checkout. Please try again.");
    } finally {
      setJoining(null);
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Sparkles className="h-5 w-5" />
        Membership
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Join a membership for member pricing on your supplies. Cancel anytime
        from your account.
      </p>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {tiers.map((opt) => (
          <div
            key={opt.tier}
            className="flex flex-col justify-between rounded-md border border-slate-200 p-4"
          >
            <div>
              <div className="font-medium text-slate-900">
                {TIER_LABELS[opt.tier] ?? opt.tier}
              </div>
              <div className="text-sm text-slate-600">{priceLabel(opt)}</div>
            </div>
            <Button
              type="button"
              className="mt-3"
              disabled={joining !== null}
              onClick={() => void onJoin(opt.tier)}
            >
              {joining === opt.tier ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Join"
              )}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
