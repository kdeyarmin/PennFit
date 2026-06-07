import React from "react";
import { Link } from "wouter";
import { PackageCheck } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  FitterResultsShot,
  OrderFormShot,
  OrderSuccessShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Choose a mask",
    body: (
      <p>
        From your{" "}
        <Link
          href="/help/find-your-mask"
          className="text-primary hover:underline"
        >
          fitter results
        </Link>{" "}
        (or any mask&apos;s detail page), tap <strong>Choose this mask</strong>.
        That carries the mask — and the measurements behind the recommendation —
        straight into the order form so you don&apos;t re-enter anything.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/results"
        caption="Pick the mask you want from your ranked results to start the order."
      >
        <FitterResultsShot />
      </Screenshot>
    ),
  },
  {
    title: "Enter your shipping and contact details",
    body: (
      <p>
        Fill in your name, shipping address, and the best phone and email for
        order updates. A running <strong>order summary</strong> on the right
        shows the mask you picked and the estimated cost as you go.
      </p>
    ),
    substeps: [
      <>Enter your full name and shipping address.</>,
      <>
        Add a phone number and email — this is where order updates and your
        confirmation go.
      </>,
      <>Double-check the address; it&apos;s where your mask ships.</>,
    ],
    shot: (
      <Screenshot
        url="pennpaps.com/order"
        caption="The order form keeps a live summary alongside the fields you fill in."
      >
        <OrderFormShot />
      </Screenshot>
    ),
  },
  {
    title: "Add your insurance and prescription",
    body: (
      <p>
        Enter your insurance details so we can verify coverage, then tell us
        about your prescription. CPAP masks are prescription devices, so we
        won&apos;t ship without a valid prescription on record.
      </p>
    ),
    substeps: [
      <>Enter your insurance provider and member ID.</>,
      <>
        Choose <strong>&ldquo;PennPaps has it on file&rdquo;</strong> if we
        already have your prescription…
      </>,
      <>
        …or enter your sleep provider&apos;s details and we&apos;ll coordinate
        one directly.
      </>,
    ],
    tip: "Not sure what you'll pay? Run an insurance estimate first — it takes a few seconds and there's no obligation.",
    note: "Paying cash instead of using insurance? Just leave the insurance fields blank and note it — our team will follow up with your options.",
  },
  {
    title: "Submit your order",
    body: (
      <p>
        Review the summary one last time and tap <strong>Submit order</strong>.
        Submitting sends the order to Penn Home Medical Supply, where a team
        member verifies your insurance and prescription before anything ships.
      </p>
    ),
    warning:
      "Nothing is charged when you submit. We confirm your exact out-of-pocket cost with you before any payment or shipment — so you'll never get a surprise charge.",
  },
  {
    title: "Save your confirmation",
    body: (
      <p>
        You&apos;ll land on a confirmation screen with your{" "}
        <strong>order reference number</strong> and get the same details by
        email. Keep that reference — you&apos;ll use it (with your email) to{" "}
        <Link
          href="/help/track-your-order"
          className="text-primary hover:underline"
        >
          track your order
        </Link>{" "}
        at any time.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/order-success"
        caption="Your reference number appears here and in the confirmation email — keep it for tracking."
      >
        <OrderSuccessShot />
      </Screenshot>
    ),
    tip: "Create a free account before you order and every order is saved automatically — no need to keep the reference number.",
  },
];

export function HelpPlaceAnOrder() {
  return (
    <HelpArticleShell
      eyebrow="Getting Started"
      title="Order your recommended mask"
      Icon={PackageCheck}
      minutes="4 min"
      metaDescription="How to order a CPAP mask from PennPaps: choosing a mask from your results, entering shipping, insurance, and prescription details, submitting, and saving your confirmation."
      intro="Found your match? Turning a recommendation into a real order takes about four minutes. Here's every step, including how insurance and prescriptions are handled."
      summary={
        <>
          Pick a mask from your results, fill in shipping, insurance, and
          prescription details, then submit. Nothing is charged at submit — we
          verify coverage and confirm your cost first. Keep the reference number
          you&apos;re given to track the order.
        </>
      }
      prerequisites={[
        "A mask in mind — ideally from your fitter results.",
        "Your shipping address and contact details.",
        "Your insurance provider and member ID (or plan to pay cash).",
        "Your prescription on file with us, or your sleep provider's details.",
      ]}
      steps={steps}
      next={{
        href: "/help/track-your-order",
        label: "Track your order",
        blurb: "Follow your order from received all the way to delivered.",
      }}
      faqs={[
        {
          q: "Am I charged when I submit the order?",
          a: "No. Submitting sends the order to our team to verify insurance and your prescription. We confirm your exact out-of-pocket cost before anything ships.",
        },
        {
          q: "Do I need an account to order?",
          a: (
            <>
              No — you can order without one. Creating a free{" "}
              <Link
                href="/help/create-an-account"
                className="text-primary hover:underline"
              >
                account
              </Link>{" "}
              just saves your details and gives you a one-tap Reorder button
              later.
            </>
          ),
        },
        {
          q: "What if PennPaps doesn't have my prescription?",
          a: "Tell us your sleep provider on the order form and we'll reach out to coordinate one. You don't have to chase your doctor's office yourself.",
        },
        {
          q: "How long until it arrives?",
          a: (
            <>
              Standard orders ship within 1–3 business days once your
              prescription and insurance are verified, and you&apos;ll get a
              tracking email. See{" "}
              <Link
                href="/help/track-your-order"
                className="text-primary hover:underline"
              >
                tracking your order
              </Link>{" "}
              for the status stages.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "Follow your order from received to delivered.",
        },
        {
          href: "/help/insurance-estimate",
          label: "Get an insurance estimate",
          blurb: "Know your cost before you submit.",
        },
      ]}
    />
  );
}
