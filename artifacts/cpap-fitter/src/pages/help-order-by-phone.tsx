import React from "react";
import { Phone } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { SUPPORT_PHONE_DISPLAY, SUPPORT_PHONE_E164 } from "@/lib/contact";

const steps: HelpStep[] = [
  {
    title: "Call the resupply line",
    body: (
      <p>
        Call{" "}
        <a
          href={`tel:${SUPPORT_PHONE_E164}`}
          className="text-primary hover:underline"
        >
          {SUPPORT_PHONE_DISPLAY}
        </a>
        . Our voice assistant answers right away — day or night — and our team
        is available Monday–Friday, 9a–5p ET. The same number is in the site
        footer and on every reminder text we send.
      </p>
    ),
  },
  {
    title: "Verify it's you",
    body: (
      <p>
        Before discussing anything about your account, the assistant confirms
        your identity — it asks for your <strong>date of birth</strong>, and for
        shop accounts it may also confirm the{" "}
        <strong>last four digits of the card on file</strong>. Nothing
        account-specific is shared until that matches.
      </p>
    ),
    note: "Calling for general questions — replacement schedules, mask types, how the fitter works? No verification needed for that.",
  },
  {
    title: "Say what you need",
    body: (
      <>
        <p>Speak naturally — the assistant can:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Reorder supplies</strong> — confirm what&apos;s due, adjust
            quantities, and place the order to your address on file.
          </li>
          <li>
            <strong>Answer supply questions</strong> — replacement cadence, what
            fits your mask, order status.
          </li>
          <li>
            <strong>Confirm or decline a reminder</strong> — the same choices as
            the link in your reminder text.
          </li>
        </ul>
      </>
    ),
    tip: "It's fine to interrupt — the assistant stops talking and listens, just like a person would.",
  },
  {
    title: "Ask for a person anytime",
    body: (
      <p>
        Say <em>“I&apos;d like to talk to a person”</em> at any point and the
        assistant hands the call to our team — or arranges a callback outside
        business hours. After every call, a summary goes to our staff so any
        follow-up you were promised actually happens.
      </p>
    ),
    warning:
      "The assistant never gives medical advice. Questions about pressure settings, symptoms, or your therapy itself belong with your sleep provider.",
  },
];

export function HelpOrderByPhone() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Order by phone with the voice assistant"
      Icon={Phone}
      minutes="2 min"
      metaDescription="How PennPaps phone ordering works: call the resupply line, verify your identity, reorder supplies with the AI voice assistant, and reach a person whenever you want."
      intro="Prefer the phone to a website? Call the resupply line and our voice assistant takes your reorder in a natural conversation — with a real person one sentence away."
      summary={
        <>
          Call{" "}
          <a
            href={`tel:${SUPPORT_PHONE_E164}`}
            className="font-semibold text-primary hover:underline"
          >
            {SUPPORT_PHONE_DISPLAY}
          </a>
          , confirm your date of birth, and tell the assistant what you need —
          it places the reorder. Say <em>“talk to a person”</em> anytime to
          reach our team.
        </>
      }
      prerequisites={[
        "Your date of birth, to verify identity before account details are discussed.",
        "Nothing else — no account or app required to call.",
      ]}
      steps={steps}
      next={{
        href: "/help/track-your-order",
        label: "Track your order",
        blurb: "Follow the order you just placed by phone.",
      }}
      faqs={[
        {
          q: "Am I talking to a robot?",
          a: "You're talking to PennPaps' AI voice assistant — it identifies itself, speaks naturally, and hands off to a human team member whenever you ask or whenever the call needs one.",
        },
        {
          q: "Can I call after hours?",
          a: "Yes. The assistant answers around the clock and can take reorders anytime. Our human team is available Monday–Friday, 9a–5p ET, and the assistant can arrange a callback.",
        },
        {
          q: "Is my information safe on the call?",
          a: "The assistant verifies your date of birth before sharing anything account-specific, and call summaries are visible only to PennPaps staff.",
        },
      ]}
      related={[
        {
          href: "/help/resupply-reminders",
          label: "Set up resupply reminders",
          blurb: "Reminder texts include this number too.",
        },
        {
          href: "/help/manage-subscriptions",
          label: "Manage auto-ship subscriptions",
          blurb: "Prefer fully automatic? Auto-ship needs no call at all.",
        },
      ]}
    />
  );
}
