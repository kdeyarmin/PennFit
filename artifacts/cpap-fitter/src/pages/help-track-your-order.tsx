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
        </code>{" "}
        (or a legacy{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">PHM-…</code>{" "}
        reference) and is on your confirmation screen and email.
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
        search your inbox for “<BrandName /> order”.
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
        . There is no in-account order history list —{" "}
        <Link href="/track-order" className="text-primary hover:underline">
          Track an order
        </Link>{" "}
        is the patient lookup.
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
      intro="Wondering where your order is? Look it up in seconds with your reference number and email — no sign-in required."
      summary={
        <>
          Open <strong>Track an order</strong>, enter your{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PENN-…</code>{" "}
          reference number (or a legacy{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PHM-…</code>)
          and the email on the order, and read the status card. Shipping updates
          arrive by email when the package ships.
        </>
      }
      prerequisites={[
        "Your order reference number (PENN-… or legacy PHM-…), from your confirmation email…",
        "…and the email address you used on the order.",
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
