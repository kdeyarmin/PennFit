import React from "react";
import { Link } from "wouter";
import { Stethoscope } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open My equipment",
    body: (
      <p>
        Sign in, open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your account
        </Link>
        , and pick the <strong>Therapy &amp; supplies</strong> tab. The{" "}
        <strong>My equipment</strong> section lists every device you&apos;ve
        registered and is where you add new ones.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="My equipment lives under the Therapy & supplies tab."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
  {
    title: "Find the serial number",
    body: (
      <p>
        The serial number is on a label on the bottom or back of your machine
        (and on its box). It&apos;s usually marked <em>SN</em> or{" "}
        <em>Serial</em>.
      </p>
    ),
    tip: "Snap a photo of the label while you're at it — handy if you ever need the number for warranty or travel paperwork.",
  },
  {
    title: "Register the device",
    body: (
      <p>
        Pick the device <strong>Class</strong> (CPAP, Auto CPAP, BiPAP, ASV,
        AVAPS, Humidifier, Oximeter, or Other), then enter the{" "}
        <strong>Manufacturer</strong> (e.g., ResMed), <strong>Model</strong>{" "}
        (e.g., AirSense 11), and <strong>Serial&nbsp;#</strong>, and tap{" "}
        <strong>Register</strong>. You&apos;ll see{" "}
        <em>“Equipment registered. Thanks!”</em> and the device joins your list.
      </p>
    ),
    note: "Register as many devices as you own — your travel machine and humidifier included.",
  },
  {
    title: "What registration does for you",
    body: (
      <p>
        If a manufacturer ever recalls a model you own, we match the recall
        against registered serial numbers and contact you directly — by email
        and, if enabled, by <strong>account &amp; order texts</strong> (urgent
        recall notices are exactly what that channel is for). Your registered
        device also helps us suggest compatible cushions, filters, and tubing
        when you shop.
      </p>
    ),
    warning:
      "A recall is handled by the manufacturer — like the Philips foam recall, repairs and replacements run through the manufacturer's own program. We make sure you find out fast and know your next step; we don't repair machines.",
  },
];

export function HelpEquipmentAndRecalls() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Register equipment & get recall alerts"
      Icon={Stethoscope}
      minutes="2 min"
      metaDescription="How to register your CPAP, BiPAP, or accessory device on PennPaps so you're alerted if a manufacturer recall ever matches your serial number."
      intro="Sixty seconds of typing now means you hear immediately if your machine is ever recalled — and better compatibility suggestions every time you shop."
      summary={
        <>
          Open <strong>Account → Therapy &amp; supplies → My equipment</strong>,
          choose the device <strong>Class</strong>, enter{" "}
          <strong>Manufacturer</strong>, <strong>Model</strong>, and{" "}
          <strong>Serial&nbsp;#</strong>, and tap <strong>Register</strong>.
        </>
      }
      prerequisites={[
        "A PennPaps account, signed in.",
        "The serial number from the label on your device.",
      ]}
      steps={steps}
      next={{
        href: "/help/communication-preferences",
        label: "Communication preferences & opting out",
        blurb: "Make sure recall notices can reach you by text.",
      }}
      faqs={[
        {
          q: "Where is my serial number?",
          a: "On a label on the bottom or back of the machine, usually marked SN or Serial. It's also printed on the original box.",
        },
        {
          q: "Can I register more than one device?",
          a: "Yes — register every device you own, including a travel machine, humidifier, or oximeter. Each one is matched against recall notices separately.",
        },
        {
          q: "Does registering share my information with the manufacturer?",
          a: "No. Registration stays on your PennPaps account and is used to match recall notices to you and improve compatibility suggestions — nothing is sent to the manufacturer.",
        },
      ]}
      related={[
        {
          href: "/help/communication-preferences",
          label: "Communication preferences & opting out",
          blurb: "Recall notices arrive via account & order texts.",
        },
        {
          href: "/help/shop-and-checkout",
          label: "Shop supplies & check out",
          blurb: "Compatibility hints follow your registered gear.",
        },
      ]}
    />
  );
}
