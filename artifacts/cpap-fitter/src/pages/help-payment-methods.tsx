import React from "react";
import { Link } from "wouter";
import { CreditCard } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Find your saved card",
    body: (
      <p>
        Sign in and open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your account
        </Link>
        . The <strong>Saved card</strong> panel shows the card on file — its
        brand, the last four digits, and the expiration date. This is the card
        used for one-tap reorders and auto-ship renewals.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="The Saved card panel sits alongside your account tabs."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
  {
    title: "Update the card or billing details",
    body: (
      <p>
        Tap <strong>Update card or billing details</strong>. This opens
        Stripe&apos;s secure billing portal in the same tab — change the card,
        billing address, or remove a card there, and you&apos;re brought
        straight back to your account when you&apos;re done.
      </p>
    ),
    note: "PennPaps never sees or stores your card number. Payments run through Stripe, and only the brand, last four digits, and expiry are visible on your account.",
  },
  {
    title: "No card saved yet?",
    body: (
      <p>
        That&apos;s normal for new accounts — your next checkout can save the
        card you use, so future orders are one tap. Browse the{" "}
        <Link href="/shop" className="text-primary hover:underline">
          shop
        </Link>{" "}
        and the option appears at checkout.
      </p>
    ),
  },
  {
    title: "Fix a past-due subscription",
    body: (
      <p>
        If an auto-ship renewal can&apos;t charge, the subscription shows{" "}
        <strong>Payment past due — update card on file</strong>. Update the card
        here and the subscription resumes on its own — no need to rebuild it.
      </p>
    ),
    tip: "Paying out of pocket for consumables? HSA and FSA cards work at checkout like any other card.",
  },
];

export function HelpPaymentMethods() {
  return (
    <HelpArticleShell
      eyebrow="Insurance & Costs"
      title="Payment methods & billing"
      Icon={CreditCard}
      minutes="2 min"
      metaDescription="How to manage your PennPaps payment method: view the saved card, update card or billing details through Stripe's secure portal, and fix a past-due auto-ship payment."
      intro="Your saved card powers one-tap reorders and auto-ship. Here's where it lives, how to update it securely, and what to do when a payment fails."
      summary={
        <>
          Open <strong>your account</strong> and find the{" "}
          <strong>Saved card</strong> panel, then tap{" "}
          <strong>Update card or billing details</strong> — changes happen in
          Stripe&apos;s secure portal and you&apos;re returned to your account
          automatically.
        </>
      }
      prerequisites={["A PennPaps account, signed in."]}
      steps={steps}
      next={{
        href: "/help/manage-subscriptions",
        label: "Manage auto-ship subscriptions",
        blurb: "The card you just saved keeps these shipping.",
      }}
      faqs={[
        {
          q: "Does PennPaps store my card number?",
          a: "No. Cards are stored by Stripe, our payment processor. Your account only ever shows the brand, last four digits, and expiration.",
        },
        {
          q: "Can I use an HSA or FSA card?",
          a: "Yes — for cash-pay CPAP consumables, HSA/FSA cards work at checkout like a regular card.",
        },
        {
          q: "How do I remove my card completely?",
          a: "Tap Update card or billing details and remove the card inside Stripe's billing portal. Note that active auto-ship subscriptions need a card on file to keep shipping.",
        },
      ]}
      related={[
        {
          href: "/help/manage-subscriptions",
          label: "Manage auto-ship subscriptions",
          blurb: "Pause, resume, or change delivery cadence.",
        },
        {
          href: "/help/insurance-estimate",
          label: "Get an insurance estimate",
          blurb: "See what insurance covers before you pay cash.",
        },
      ]}
    />
  );
}
