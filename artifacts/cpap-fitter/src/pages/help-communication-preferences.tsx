import React from "react";
import { Link } from "wouter";
import { Bell } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";
import { BrandName } from "@/components/company-contact";

const steps: HelpStep[] = [
  {
    title: "Open communication preferences",
    body: (
      <p>
        Sign in, open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your account
        </Link>
        , and pick the <strong>Account</strong> tab. Scroll to{" "}
        <strong>Communication preferences</strong> — every change saves
        immediately and a <em>Saved</em> label confirms it.
      </p>
    ),
    shot: (
      <Screenshot caption="Communication preferences live under the Account tab.">
        <AccountShot />
      </Screenshot>
    ),
  },
  {
    title: "Choose your emails",
    body: (
      <>
        <p>Three email switches put you in control:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Resupply reminders</strong> — nudges when each supply is due
            for replacement.
          </li>
          <li>
            <strong>Customer-service replies</strong> — an email when our team
            replies on your message thread.
          </li>
          <li>
            <strong>Updates &amp; reminders</strong> — occasional updates about
            coverage, mask fitting, and resupply timing.
          </li>
        </ul>
      </>
    ),
    note: "Shipping and delivery notices for insurance resupply always send — they're part of fulfilling your supplies, not marketing.",
  },
  {
    title: "Choose your text messages",
    body: (
      <p>
        Under <strong>Text messages</strong> there are two switches:{" "}
        <strong>Account &amp; shipment texts</strong> (shipment updates,
        delivery notices, urgent recall alerts) and{" "}
        <strong>Reminder texts</strong>.
      </p>
    ),
    warning:
      "Replying STOP to any text unsubscribes you from BOTH text categories at once. You can re-enable them here anytime.",
  },
  {
    title: "Set quiet hours",
    body: (
      <p>
        Use the <strong>Quiet hours</strong> editor to block a window when we
        shouldn&apos;t email you — pick start and end hours, or tap the{" "}
        <strong>Overnight</strong> preset, then{" "}
        <strong>Save quiet hours</strong>. Tap <strong>Clear</strong> to remove
        the window.
      </p>
    ),
  },
  {
    title: "Turn on browser notifications (optional)",
    body: (
      <p>
        Under <strong>Browser notifications</strong>, tap{" "}
        <strong>Enable</strong> to get a push notification on this device when
        supplies are ready, an order ships, or our team replies. Tap{" "}
        <strong>Disable</strong> to turn it off — and if your browser has
        blocked notifications, allow them in the browser&apos;s site settings
        first.
      </p>
    ),
  },
];

export function HelpCommunicationPreferences() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Communication preferences & opting out"
      Icon={Bell}
      minutes="3 min"
      metaDescription="How to control your emails, text messages, browser notifications, and quiet hours — including how STOP works and which messages always send."
      intro={
        <>
          Decide exactly how <BrandName /> reaches you: which emails and texts
          you get, a quiet-hours window for overnight, and optional browser
          notifications.
        </>
      }
      summary={
        <>
          Open{" "}
          <strong>Account → Account tab → Communication preferences</strong>.
          Flip switches for each email and text category, set{" "}
          <strong>Quiet hours</strong>, and remember: replying{" "}
          <strong>STOP</strong> to any text stops all texts.
        </>
      }
      prerequisites={[
        <>
          A <BrandName /> account, signed in.
        </>,
      ]}
      steps={steps}
      next={{
        href: "/help/resupply-reminders",
        label: "Set up resupply reminders",
        blurb: "Tune which supplies we remind you about, and when.",
      }}
      faqs={[
        {
          q: "I replied STOP but want texts again — what now?",
          a: "Open Communication preferences and switch the text categories back on. STOP unsubscribes you from both account/shipment texts and reminder texts, so re-enable whichever you want.",
        },
        {
          q: "Will I still get shipping notices if I turn everything off?",
          a: "Yes. Shipping and delivery notices for insurance resupply always send — the switches control resupply reminders, CSR reply emails, and optional updates.",
        },
        {
          q: "Whose timezone do quiet hours use?",
          a: "Your saved timezone, shown right in the quiet-hours description once set — for example “Don’t email me between 9 PM and 7 AM.”",
        },
      ]}
      related={[
        {
          href: "/help/resupply-reminders",
          label: "Set up resupply reminders",
          blurb: "Choose channels and cadence for supply nudges.",
        },
        {
          href: "/help/caregiver-access",
          label: "Share updates with a caregiver",
          blurb: "Send shipping updates to a family member too.",
        },
      ]}
    />
  );
}
