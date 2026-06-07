import React from "react";
import { Link } from "wouter";
import { Truck } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  TrackOrderShot,
  AccountShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open the order tracker",
    body: (
      <p>
        Go to{" "}
        <Link href="/track-order" className="text-primary hover:underline">
          Track an order
        </Link>{" "}
        (it&apos;s in the site footer under Patient Services, and linked from
        your confirmation email). No sign-in is required.
      </p>
    ),
  },
  {
    title: "Enter your reference and email",
    body: (
      <p>
        Type your <strong>order reference number</strong> (it starts with{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">PEN-</code> and
        is on your confirmation screen and email) and the{" "}
        <strong>email address</strong> you used on the order. The two must
        match, which keeps your order details private.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/track-order"
        caption="Look up any order with its reference number and the email on file."
      >
        <TrackOrderShot />
      </Screenshot>
    ),
    tip: "Lost your reference number? It's in the order confirmation email — search your inbox for “PennPaps order”.",
  },
  {
    title: "Read your status timeline",
    body: (
      <>
        <p>
          Tap <strong>Find my order</strong> to see a status timeline. Completed
          stages are checked off in green so you can see at a glance where
          things stand:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Order received</strong> — we have your order.
          </li>
          <li>
            <strong>Insurance verified</strong> — coverage and prescription
            confirmed.
          </li>
          <li>
            <strong>Shipped</strong> — your package is on its way.
          </li>
          <li>
            <strong>Out for delivery / Delivered</strong> — the last mile.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "Or track from your account",
    body: (
      <p>
        If you have an{" "}
        <Link
          href="/help/create-an-account"
          className="text-primary hover:underline"
        >
          account
        </Link>
        , every order is saved under <strong>Orders</strong> — no reference
        number needed. Open one to see its status, and use{" "}
        <strong>Reorder</strong> to buy the same items again in one tap.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="Signed-in customers see every order, its status, and a one-tap Reorder button."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
];

export function HelpTrackYourOrder() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Track your order"
      Icon={Truck}
      minutes="2 min"
      metaDescription="How to track a PennPaps order: look it up by reference number and email, read the delivery status timeline, or view all orders from your account."
      intro="Wondering where your order is? You can look up any order in seconds with your reference number and email — or see everything at once from your account."
      steps={steps}
      faqs={[
        {
          q: "Why do I need both the reference number and my email?",
          a: "Requiring both keeps your order details private — someone with just a reference number can't see your information.",
        },
        {
          q: "My tracker says “Insurance verified” but not shipped — what now?",
          a: "That means we've confirmed coverage and your prescription and your order is queued to ship, usually within 1–3 business days. You'll get a tracking email when it's on the way.",
        },
        {
          q: "I never got a reference number.",
          a: (
            <>
              Check your spam folder for the confirmation email. If it&apos;s
              truly missing,{" "}
              <Link href="/help" className="text-primary hover:underline">
                contact our care team
              </Link>{" "}
              and we&apos;ll look it up by name and email.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/place-an-order",
          label: "Order your recommended mask",
          blurb: "Where your reference number comes from.",
        },
        {
          href: "/help/create-an-account",
          label: "Create an account",
          blurb: "Skip the reference number next time.",
        },
      ]}
    />
  );
}
