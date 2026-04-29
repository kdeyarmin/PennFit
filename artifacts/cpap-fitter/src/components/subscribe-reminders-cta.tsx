import React from "react";
import { Link } from "wouter";
import { Bell, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Promo card encouraging the user to sign up for supply replacement
 * reminders. Used on the Replacement Schedule page (primary spot — that's
 * where users are actively thinking about cadence) and on the
 * shop-checkout-success page (post-purchase).
 *
 * Variant `compact` is used in narrow contexts (post-purchase). Variant
 * `feature` is the larger, headline-style card for content pages.
 */
export function SubscribeRemindersCta({
  variant = "feature",
}: {
  variant?: "feature" | "compact";
}) {
  if (variant === "compact") {
    return (
      <div className="rounded-xl border bg-background/60 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-10 h-10 rounded-lg icon-halo-gold flex items-center justify-center shrink-0">
            <Bell className="w-5 h-5" />
          </div>
          <div>
            <p className="font-medium">Get reminded when it's time to swap supplies</p>
            <p className="text-sm text-muted-foreground">
              Free, one-click unsubscribe.
            </p>
          </div>
        </div>
        <Link href="/reminders">
          <Button variant="outline" data-testid="button-cta-reminders-compact">
            Sign up
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-gradient-to-br from-[hsl(var(--penn-gold)/0.08)] to-[hsl(var(--penn-navy)/0.05)] p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-2xl icon-halo-gold flex items-center justify-center shrink-0">
          <Bell className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-semibold tracking-tight">
            Never miss a refill again
          </h3>
          <p className="text-muted-foreground mt-1.5">
            Get a friendly email the moment each supply hits its replacement
            interval — cushion every month, tubing every quarter, filters every
            two weeks. You pick what to track, we do the math.
          </p>
          <div className="mt-4">
            <Link href="/reminders">
              <Button data-testid="button-cta-reminders-feature">
                Sign up for free reminders
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
