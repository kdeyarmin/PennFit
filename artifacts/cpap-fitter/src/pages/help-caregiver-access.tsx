import React from "react";
import { Link } from "wouter";
import { UserPlus } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open Designated contact",
    body: (
      <p>
        Sign in, open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your account
        </Link>
        , and pick the <strong>Account</strong> tab. Scroll to{" "}
        <strong>Designated contact</strong> — this is where you add one person
        (a spouse, adult child, or home-health aide) who should hear when your
        supplies ship and arrive.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="Designated contact lives under the Account tab."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
  {
    title: "Add their name and email",
    body: (
      <p>
        Tap <strong>Add a designated contact</strong> and enter{" "}
        <strong>their name</strong> and <strong>their email</strong>. Check the
        box confirming{" "}
        <em>“I&apos;m authorized to share supplies-status with this person”</em>{" "}
        — it&apos;s required by HIPAA — then tap <strong>Save contact</strong>.
      </p>
    ),
    note: "One designated contact per account. You can change or remove them anytime.",
  },
  {
    title: "Know exactly what they receive",
    body: (
      <p>
        Your contact gets a separate email when your supplies{" "}
        <strong>ship</strong> and when they <strong>arrive</strong> —
        that&apos;s it. Claims, explanations of benefits, and billing detail
        stay private to your account; their email is never used for anything but
        supplies-status updates.
      </p>
    ),
  },
  {
    title: "Edit or remove anytime",
    body: (
      <p>
        Back in <strong>Designated contact</strong>, tap <strong>Edit</strong>{" "}
        to update their details or <strong>Remove contact</strong> to stop the
        updates immediately.
      </p>
    ),
  },
];

export function HelpCaregiverAccess() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Share updates with a caregiver"
      Icon={UserPlus}
      minutes="2 min"
      metaDescription="How to add a designated contact to your PennPaps account so a spouse, adult child, or aide gets shipping and delivery updates — without seeing claims or billing."
      intro="Many CPAP users have someone who helps manage supplies. Add them as your designated contact and they'll get shipped and delivered emails alongside you — nothing more."
      summary={
        <>
          Open <strong>Account → Account tab → Designated contact</strong>, tap{" "}
          <strong>Add a designated contact</strong>, enter their name and email,
          check the authorization box, and <strong>Save contact</strong>.
        </>
      }
      prerequisites={[
        "A PennPaps account, signed in.",
        "Your contact's email address — and their okay to receive updates.",
      ]}
      steps={steps}
      next={{
        href: "/help/track-your-order",
        label: "Track your order",
        blurb: "What those shipped and delivered updates link to.",
      }}
      faqs={[
        {
          q: "Can I add more than one contact?",
          a: "Not currently — the account supports one designated contact. Pick the person most involved in your supplies, and remember you can swap them anytime.",
        },
        {
          q: "Can my contact sign in or see my account?",
          a: "No. They never get account access — only shipping and delivery emails. Claims, EOBs, and billing detail stay private to you.",
        },
        {
          q: "Why do I have to check the authorization box?",
          a: "HIPAA requires your explicit okay before we share even supplies-status information with someone else. Checking the box records that authorization, and removing the contact withdraws it.",
        },
      ]}
      related={[
        {
          href: "/help/communication-preferences",
          label: "Communication preferences & opting out",
          blurb: "Control what lands in your own inbox.",
        },
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "Follow a delivery yourself, any time.",
        },
      ]}
    />
  );
}
