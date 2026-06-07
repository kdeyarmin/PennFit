import React from "react";
import { Link } from "wouter";
import { BellRing } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, RemindersShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open your reminder settings",
    body: (
      <p>
        Go to{" "}
        <Link href="/reminders" className="text-primary hover:underline">
          Reminders
        </Link>{" "}
        (also under <strong>Reminders</strong> in your account sidebar). This is
        where you tell us how and when to reach you about replacement supplies.
      </p>
    ),
  },
  {
    title: "Choose how we reach you",
    body: (
      <p>
        Toggle the channels you want — <strong>text message</strong>,{" "}
        <strong>email</strong>, or a <strong>phone call</strong>. Turn on as
        many or as few as you like. SMS is the most popular because the reminder
        includes a secure one-tap link to confirm your reorder.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/reminders"
        caption="Flip on the channels you prefer; your upcoming replacement dates show on the right."
      >
        <RemindersShot />
      </Screenshot>
    ),
    tip: "You can pick more than one channel — for example, a text now and an email as a backup.",
  },
  {
    title: "Review your replacement schedule",
    body: (
      <>
        <p>
          Your schedule is based on the standard insurance-covered replacement
          cadence, so each item is tracked separately:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Mask cushions</strong> — every 2–4 weeks.
          </li>
          <li>
            <strong>Filters</strong> — monthly.
          </li>
          <li>
            <strong>Tubing</strong> — every 3 months.
          </li>
          <li>
            <strong>Headgear</strong> — every 6 months.
          </li>
        </ul>
        <p>
          The panel shows when each item is next due so there are no surprises.
        </p>
      </>
    ),
  },
  {
    title: "Save your preferences",
    body: (
      <p>
        Tap <strong>Save preferences</strong>. From then on, we&apos;ll reach
        out on your chosen channels when you&apos;re due, bill insurance on the
        covered schedule, and ship without you having to remember a thing. You
        can change channels, snooze, or unsubscribe anytime from this same page.
      </p>
    ),
  },
];

export function HelpResupplyReminders() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Set up resupply reminders"
      Icon={BellRing}
      minutes="3 min"
      metaDescription="How to set up PennPaps resupply reminders: choose SMS, email, or phone reminders, review your per-item replacement schedule, and save your preferences."
      intro="Resupply reminders nudge you when cushions, filters, tubing, and headgear are due — and bill insurance on the covered schedule. Here's how to set them up."
      steps={steps}
      faqs={[
        {
          q: "Will I be charged automatically?",
          a: "No. A reminder asks you to confirm before anything ships — you're always in control. Covered items are billed to insurance on the standard replacement schedule.",
        },
        {
          q: "Can I change or stop reminders later?",
          a: "Yes. Return to the Reminders page anytime to switch channels, snooze a reminder, or unsubscribe completely.",
        },
        {
          q: "Do I need to re-run the fitter for resupply?",
          a: (
            <>
              Only if your fit has changed (significant weight change, dental or
              facial surgery). Otherwise reordering the same supplies needs no
              new scan. If something feels off, you can{" "}
              <Link
                href="/help/find-your-mask"
                className="text-primary hover:underline"
              >
                re-run the fitter
              </Link>
              .
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/create-an-account",
          label: "Create an account",
          blurb: "Manage reminders from your dashboard.",
        },
        {
          href: "/help/shop-and-checkout",
          label: "Shop supplies",
          blurb: "Reorder anything between reminders.",
        },
      ]}
    />
  );
}
