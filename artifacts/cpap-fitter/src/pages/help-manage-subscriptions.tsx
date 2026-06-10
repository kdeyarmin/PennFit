import React from "react";
import { Link } from "wouter";
import { Repeat } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open your subscriptions",
    body: (
      <p>
        Sign in and open{" "}
        <Link href="/account#autoship" className="text-primary hover:underline">
          your account
        </Link>
        , then pick the <strong>Orders &amp; returns</strong> tab. Your
        recurring deliveries are listed under{" "}
        <strong>Auto-ship subscriptions</strong> — each row shows the item, the
        price, and its <strong>Next ship</strong> date.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="Auto-ship lives under the Orders & returns tab of your account."
      >
        <AccountShot />
      </Screenshot>
    ),
    note: "Don't see the section? It only appears once you have at least one auto-ship subscription — you can start one from any product page or at checkout.",
  },
  {
    title: "Pause and resume anytime",
    body: (
      <p>
        Tap <strong>Pause</strong> on a subscription and confirm. While paused
        we stop charging your card and stop shipping until you tap{" "}
        <strong>Resume</strong>. Traveling? Use{" "}
        <strong>Pause all (travel mode)</strong> to pause everything at once,
        then <strong>Resume all</strong> when you&apos;re back.
      </p>
    ),
    tip: "Pausing is the easiest way to skip a delivery without losing your setup — nothing else about the subscription changes.",
  },
  {
    title: "Change how often it ships",
    body: (
      <p>
        Tap <strong>Change cadence</strong> to see the schedules offered for
        that item — for example <em>Every 2 weeks</em> or <em>Every 4 weeks</em>
        , with your current choice marked <em>(current)</em>. Pick one and tap{" "}
        <strong>Save cadence</strong>.
      </p>
    ),
    note: "Auto-ship pricing is the same as a one-time purchase — there's no membership fee, so pick whatever cadence matches how you actually use supplies.",
  },
  {
    title: "Cancel if you need to",
    body: (
      <p>
        Tap <strong>Cancel auto-ship</strong>. We&apos;ll first ask whether a
        pause would work instead — choose{" "}
        <strong>Pause auto-ship instead</strong> to keep the subscription on
        ice, or <strong>Cancel anyway</strong> to end it. A canceled
        subscription shows <em>Stops after</em> its final date and won&apos;t
        renew.
      </p>
    ),
  },
  {
    title: "Fix a failed payment",
    body: (
      <p>
        If a renewal can&apos;t charge your card, the subscription shows{" "}
        <strong>Payment past due — update card on file</strong>. Update your
        card from the <strong>Saved card</strong> panel on your account page and
        the subscription picks back up.
      </p>
    ),
  },
];

export function HelpManageSubscriptions() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Manage auto-ship subscriptions"
      Icon={Repeat}
      minutes="3 min"
      metaDescription="How to manage PennPaps auto-ship subscriptions: pause, resume, change delivery cadence, cancel, use travel mode, and fix a past-due payment."
      intro="Auto-ship keeps cushions, filters, and tubing arriving on schedule. Here's how to pause for a trip, change how often items ship, update payment, or cancel."
      summary={
        <>
          Open{" "}
          <strong>
            Account → Orders &amp; returns → Auto-ship subscriptions
          </strong>
          . From each row you can <strong>Pause</strong>,{" "}
          <strong>Resume</strong>, <strong>Change cadence</strong>, or{" "}
          <strong>Cancel auto-ship</strong> — and{" "}
          <strong>Pause all (travel mode)</strong> covers every subscription at
          once.
        </>
      }
      prerequisites={[
        "A PennPaps account, signed in.",
        "At least one auto-ship subscription (start one from a product page or at checkout).",
      ]}
      steps={steps}
      next={{
        href: "/help/payment-methods",
        label: "Payment methods & billing",
        blurb: "Keep the card behind your auto-ship up to date.",
      }}
      faqs={[
        {
          q: "Does auto-ship cost more than ordering one-time?",
          a: "No — the price is the same as a one-time purchase and there's no membership fee. You can cancel anytime.",
        },
        {
          q: "Am I charged while paused?",
          a: "No. Pausing stops both the charge and the shipment until you resume.",
        },
        {
          q: "What's the difference between auto-ship and resupply reminders?",
          a: "Auto-ship charges your card and ships automatically on a schedule. Reminders just nudge you when a supply is due — you place each order yourself. Reminders work without an account from the reminders page.",
        },
      ]}
      related={[
        {
          href: "/help/resupply-reminders",
          label: "Set up resupply reminders",
          blurb: "Prefer a nudge over an automatic shipment?",
        },
        {
          href: "/help/payment-methods",
          label: "Payment methods & billing",
          blurb: "Update the card your subscriptions charge.",
        },
      ]}
    />
  );
}
