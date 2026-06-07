import React from "react";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  InsuranceEstimateShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open the estimate tool",
    body: (
      <p>
        Go to{" "}
        <Link
          href="/insurance/estimate"
          className="text-primary hover:underline"
        >
          Insurance estimate
        </Link>{" "}
        (linked from the{" "}
        <Link href="/insurance" className="text-primary hover:underline">
          Insurance
        </Link>{" "}
        page). It gives you a quick, no-obligation projection of what a new mask
        or supplies will cost you out of pocket.
      </p>
    ),
  },
  {
    title: "Enter your plan details",
    body: (
      <p>
        Three answers drive the estimate — the more accurate they are, the
        closer the projection.
      </p>
    ),
    substeps: [
      <>
        Choose your <strong>insurance provider</strong>.
      </>,
      <>
        Pick your <strong>plan type</strong> (e.g. Medicare, commercial, HMO).
      </>,
      <>
        Tell us whether you&apos;ve <strong>met your deductible</strong> this
        year.
      </>,
    ],
    shot: (
      <Screenshot
        url="pennpaps.com/insurance/estimate"
        caption="A few plan details on the left produce an instant cost estimate on the right."
      >
        <InsuranceEstimateShot />
      </Screenshot>
    ),
    tip: "Not sure if you've met your deductible? Pick your best guess — you can re-run the estimate with different answers to see the range.",
  },
  {
    title: "Read your projected cost",
    body: (
      <p>
        Tap <strong>Estimate my cost</strong> to see a projected{" "}
        <strong>out-of-pocket range</strong> per mask, plus a short breakdown of
        what insurance is expected to cover. Most plans (Medicare, Medicaid, and
        most commercial insurers) cover CPAP supplies on a regular schedule, so
        many patients land at little to no cost.
      </p>
    ),
    warning:
      "This is a projection, not a bill. Your real cost depends on your specific plan and how much of your deductible is left — we always verify it before anything ships.",
  },
  {
    title: "Move forward with confidence",
    body: (
      <p>
        When you&apos;re ready, head to the{" "}
        <Link
          href="/help/find-your-mask"
          className="text-primary hover:underline"
        >
          fitter
        </Link>{" "}
        or{" "}
        <Link
          href="/help/place-an-order"
          className="text-primary hover:underline"
        >
          place an order
        </Link>
        , and our team confirms your exact coverage as part of processing.
      </p>
    ),
  },
];

export function HelpInsuranceEstimate() {
  return (
    <HelpArticleShell
      eyebrow="Insurance & Costs"
      title="Get an insurance estimate"
      Icon={ShieldCheck}
      minutes="2 min"
      metaDescription="How to use the PennPaps insurance estimate tool: enter your provider, plan type, and deductible status to see a projected out-of-pocket cost for CPAP supplies."
      intro="Want to know what you'll pay before you order? The insurance estimate tool projects your out-of-pocket cost from a few plan details in about two minutes."
      summary={
        <>
          Open the estimate tool, pick your provider, plan type, and deductible
          status, and tap <strong>Estimate my cost</strong> for a projected
          out-of-pocket range. It&apos;s a no-obligation projection — we verify
          your exact cost before anything ships.
        </>
      }
      prerequisites={[
        "Your insurance provider and plan type.",
        "A rough idea of whether you've met this year's deductible.",
      ]}
      steps={steps}
      next={{
        href: "/help/find-your-mask",
        label: "Find your mask",
        blurb: "Match to the right mask, then turn it into an order.",
      }}
      faqs={[
        {
          q: "Is the estimate a guaranteed price?",
          a: "No — it's a projection to help you plan. We verify your exact out-of-pocket cost with your insurer before anything ships, so there are no surprises.",
        },
        {
          q: "What does insurance usually cover?",
          a: "Most US plans cover CPAP supplies on a replacement schedule — typically a new mask every three months plus cushions, headgear, filters, and tubing. Coverage varies by plan, which is why we verify.",
        },
        {
          q: "What if my insurance changes?",
          a: (
            <>
              Let us know and we&apos;ll re-verify coverage with the new plan
              before your next order. You can also re-run the estimate with your
              new plan details, or{" "}
              <Link href="/help" className="text-primary hover:underline">
                contact our team
              </Link>
              .
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/place-an-order",
          label: "Order your recommended mask",
          blurb: "Use insurance when you order.",
        },
        {
          href: "/help/find-your-mask",
          label: "Find your mask",
          blurb: "Match to a mask first, then estimate.",
        },
      ]}
    />
  );
}
