import React from "react";
import { Link } from "wouter";
import { ClipboardCheck } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  FitterResultsShot,
  OrderFormShot,
} from "@/components/help/help-screens";
import { BrandName } from "@/components/company-contact";

const steps: HelpStep[] = [
  {
    title: "Finish your fitting and read your results",
    body: (
      <p>
        At the end of the fitter,{" "}
        <Link href="/results" className="text-primary hover:underline">
          your results page
        </Link>{" "}
        shows your best-fit masks with a short explanation of why each one suits
        your measurements and your answers. Nothing has been ordered at this
        point — this is your shortlist.
      </p>
    ),
    shot: (
      <Screenshot caption="Your shortlist, with the reasoning behind each recommendation.">
        <FitterResultsShot />
      </Screenshot>
    ),
  },
  {
    title: "Choose how you'd like us to follow up",
    body: (
      <p>
        There are two ways to ask, and both put you in the queue for a real
        person. Pick whichever suits you — neither one is faster than the other.
      </p>
    ),
    substeps: [
      <>
        <strong>Send my details</strong> — you pass along what you know, and we
        take it from there.
      </>,
      <>
        <strong>Ask a representative to contact me</strong> — just your contact
        details, no forms. Choose this if you would rather talk it through.
      </>,
    ],
  },
  {
    title: "Fill in what you know — insurance is optional",
    body: (
      <p>
        We ask for your name, how to reach you, and your insurance details if
        you have them handy. Your insurance information is genuinely{" "}
        <strong>optional</strong>: a member of our team verifies your benefits
        anyway, so not being able to find your member ID should never stop you
        from asking.
      </p>
    ),
    shot: (
      <Screenshot caption="Contact details are required; insurance is optional because we verify it for you.">
        <OrderFormShot />
      </Screenshot>
    ),
    note: (
      <>
        You only need to give a phone number if you asked to be reached by phone
        or text. If you picked email, an email address is enough.
      </>
    ),
  },
  {
    title: "We take it from here",
    body: (
      <p>
        A <BrandName /> representative reviews your request, confirms what your
        plan covers, sorts out the prescription with your sleep provider if one
        is needed, and places the order for you. We aim to be in touch within{" "}
        <strong>one business day</strong>.
      </p>
    ),
    tip: (
      <>
        You won&apos;t get an order number straight away — that&apos;s
        deliberate. Nothing has been ordered until a person has looked at your
        request, and we&apos;d rather not hand you a number that doesn&apos;t
        mean anything yet.
      </>
    ),
  },
];

export function HelpRequestYourMask() {
  return (
    <HelpArticleShell
      eyebrow="Masks & Fitting"
      title="Ask for your recommended mask"
      Icon={ClipboardCheck}
      minutes="3 min"
      metaDescription="How to request your recommended CPAP mask after a fitting: send your details or ask for a callback, why insurance is optional, and what happens next."
      intro="Finished a fitting? Here's how to turn your recommendation into a real mask — and why we ask a person to place the order rather than having you do it yourself."
      summary={
        <>
          On your results page, choose <strong>Send my details</strong> or{" "}
          <strong>Ask a representative to contact me</strong>. Insurance details
          are optional. A <BrandName /> representative verifies your benefits,
          handles the prescription, and places the order — usually within one
          business day.
        </>
      }
      prerequisites={[
        "A finished fitting, so we know which mask sizes suit you…",
        "…and an email address we can reach you on. Everything else is optional.",
      ]}
      steps={steps}
      next={{
        href: "/help/track-your-order",
        label: "Track your order",
        blurb: "Once your order is placed, follow it to your door.",
      }}
      faqs={[
        {
          q: "Why can't I just place the order myself?",
          a: (
            <>
              Because supplies are billed to your insurance, and a claim
              shouldn&apos;t start from a guess at your member ID. Having a
              person verify your benefits first is what prevents a surprise bill
              later — and it means you don&apos;t have to get the paperwork
              right.
            </>
          ),
        },
        {
          q: "Do I have to give my insurance information?",
          a: "No. It helps us move faster if you have your card handy, but we verify your benefits with the plan either way. Ask first and find the card later.",
        },
        {
          q: "I clicked submit twice. Did I ask for two masks?",
          a: "No. If you send the same request again while the first one is still open, it just returns the request you already have — you won't end up in the queue twice.",
        },
        {
          q: "How long until I hear from someone?",
          a: "We aim for one business day. If it's taking longer than that, call us — the number is at the bottom of every page.",
        },
        {
          q: "Can I ask for a different mask than the one recommended?",
          a: (
            <>
              Absolutely — tell us in the notes, or say so when we call. The
              shortlist is a recommendation, not a restriction, and our team can
              talk through the trade-offs with you.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/find-your-mask",
          label: "Find your mask",
          blurb: "How the fitting itself works.",
        },
        {
          href: "/help/insurance-estimate",
          label: "Check what insurance covers",
          blurb: "See what your plan is likely to pay before you ask.",
        },
        {
          href: "/help/order-by-phone",
          label: "Order by phone",
          blurb: "Prefer to talk? Do the whole thing by phone.",
        },
      ]}
    />
  );
}
