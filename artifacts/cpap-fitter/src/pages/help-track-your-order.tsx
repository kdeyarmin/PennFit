import React from "react";
import { Link } from "wouter";
import { Truck } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, TrackOrderShot } from "@/components/help/help-screens";
import { BrandName } from "@/components/company-contact";

const steps: HelpStep[] = [
  {
    title: "Prefer Account if you're signed in",
    body: (
      <p>
        Open{" "}
        <Link href="/account" className="text-primary hover:underline">
          Account
        </Link>{" "}
        and check <strong>Recent shipments</strong> on the Overview tab —
        insurance fulfillments and any legacy storefront rows show there. Use
        the public tracker below when you&apos;re signed out or have a
        confirmation reference handy.
      </p>
    ),
  },
  {
    title: "Open the order tracker",
    body: (
      <p>
        Go to{" "}
        <Link href="/track-order" className="text-primary hover:underline">
          Track an order
        </Link>{" "}
        — it&apos;s in the site footer under Patient Services, and linked from
        your confirmation email. No sign-in is required.
      </p>
    ),
  },
  {
    title: "Enter your reference and email",
    body: (
      <p>
        Look up any order with two pieces of information. They must match
        what&apos;s on the order, which keeps your details private.
      </p>
    ),
    substeps: [
      <>
        Type your <strong>order reference number</strong> — it looks like{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">
          PENN-AB1234
        </code>
        , a CSR{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">ORD-…</code>, or
        a legacy{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">PHM-…</code>{" "}
        reference — and is on your confirmation screen and email.
      </>,
      <>
        Enter the <strong>email address</strong> you used on the order.
      </>,
      <>
        Tap <strong>Find my order</strong>.
      </>,
    ],
    shot: (
      <Screenshot caption="Look up any order with its reference number and the email on file.">
        <TrackOrderShot />
      </Screenshot>
    ),
    tip: (
      <>
        Lost your reference number? It&apos;s in the order confirmation email —
        search your inbox for “<BrandName /> order”. Signed-in patients can also
        skip the reference and use Account → Recent shipments.
      </>
    ),
  },
  {
    title: "Read your status card",
    body: (
      <>
        <p>
          A successful lookup shows the mask you requested, when we received the
          order, and a short status label:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Processing</strong> — we have the request and are confirming
            details with our team.
          </li>
          <li>
            <strong>Received</strong> — fulfillment has it; someone contacts you
            within 1 business day.
          </li>
          <li>
            <strong>Delivery issue</strong> — something blocked the confirmation
            email; call us or reply to support so we can unblock it.
          </li>
        </ul>
      </>
    ),
    note: "Shipping and carrier tracking arrive in a separate email once the package leaves our warehouse — they are not stages on this page.",
  },
  {
    title: "Need a person?",
    body: (
      <p>
        Lost the reference, or the status looks wrong?{" "}
        <Link href="/contact" className="text-primary hover:underline">
          Contact us
        </Link>{" "}
        or, if you&apos;re signed in, message your care team from{" "}
        <Link href="/account#messages" className="text-primary hover:underline">
          Account → Messages
        </Link>
        . There is no retail order book — if you&apos;re signed in, open{" "}
        <Link href="/account" className="text-primary hover:underline">
          Account
        </Link>{" "}
        to see Recent shipments. Guests (or anyone with a confirmation
        reference) can still use{" "}
        <Link href="/track-order" className="text-primary hover:underline">
          Track an order
        </Link>
        .
      </p>
    ),
  },
];

export function HelpTrackYourOrder() {
  return (
    <HelpArticleShell
      eyebrow="Orders & Delivery"
      title="Track your order"
      Icon={Truck}
      minutes="2 min"
      metaDescription="How to track your order: look it up by reference number and email on the public tracker, then read the status card."
      intro="Wondering where your order is? Signed-in patients can check Recent shipments on Account. Guests can look it up with a reference number and email — no sign-in required."
      summary={
        <>
          If you&apos;re signed in, open{" "}
          <Link href="/account" className="text-primary hover:underline">
            Account
          </Link>{" "}
          and scroll to <strong>Recent shipments</strong>. Otherwise open{" "}
          <strong>Track an order</strong>, enter your{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PENN-…</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ORD-…</code>,
          or legacy{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PHM-…</code>{" "}
          reference and the email on the order, and read the status card.
          Shipping updates arrive by email when the package ships.
        </>
      }
      prerequisites={[
        "Signed in: nothing else — Account → Recent shipments lists your fulfillments.",
        "Guest: your order reference (PENN-…, ORD-…, or legacy PHM-…) from the confirmation email…",
        "…and the email address on the order.",
      ]}
      steps={steps}
      next={{
        href: "/help/resupply-reminders",
        label: "Set up resupply reminders",
        blurb: "Never run out — get nudged when supplies are due.",
      }}
      faqs={[
        {
          q: "Why do I need both the reference number and my email?",
          a: "Requiring both keeps your order details private — someone with just a reference number can't see your information.",
        },
        {
          q: "My tracker still says Processing — what now?",
          a: "That usually means our team has not finished the first confirmation pass yet. Most requests move to Received within 1 business day; you'll hear from us if insurance or the prescription needs a follow-up.",
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
          href: "/help/request-your-mask",
          label: "Ask for your recommended mask",
          blurb: "Where your order comes from in the first place.",
        },
        {
          href: "/help/create-an-account",
          label: "Create an account",
          blurb: "Save addresses, reminders, and messages in one place.",
        },
      ]}
    />
  );
}
