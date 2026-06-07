import React from "react";
import { Link } from "wouter";
import { RotateCcw } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, ReturnsShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open the returns page",
    body: (
      <p>
        Go to{" "}
        <Link href="/returns" className="text-primary hover:underline">
          Returns &amp; refunds
        </Link>{" "}
        (in the footer under Patient Services). The page explains what&apos;s
        eligible and starts your request — including the{" "}
        <strong>60-day comfort guarantee</strong> on masks fitted through
        PennPaps.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/returns"
        caption="The returns page leads with the 60-day comfort guarantee, then walks you through the request."
      >
        <ReturnsShot />
      </Screenshot>
    ),
  },
  {
    title: "Pick the order and item",
    body: (
      <p>
        Choose the order you&apos;re returning (sign in to pick from your
        history, or enter your order reference and email). Then select the
        specific item — you can return a single product without affecting the
        rest of the order.
      </p>
    ),
    tip: "For hygiene and safety, unopened consumables are the easiest to return. If a mask doesn't fit, the comfort guarantee covers an exchange even after it's been worn.",
  },
  {
    title: "Tell us the reason",
    body: (
      <p>
        Pick a reason — wrong fit, not as expected, ordered by mistake, and so
        on — and add a quick note if it helps. If it&apos;s a fit problem,
        we&apos;ll often suggest a better-matched mask rather than just a
        refund, so you end up with something that actually works.
      </p>
    ),
  },
  {
    title: "Submit and ship it back",
    body: (
      <p>
        Tap <strong>Start a return</strong> to submit. Our team reviews it and
        emails you next steps — a return label where applicable and confirmation
        of your refund or exchange. Refunds go back to your original payment
        method once we receive the item.
      </p>
    ),
  },
];

export function HelpReturnsAndRefunds() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Returns, exchanges & refunds"
      Icon={RotateCcw}
      minutes="3 min"
      metaDescription="How to return or exchange a PennPaps order: start a return, pick the order and item, choose a reason, and use the 60-day mask comfort guarantee."
      intro="If something isn't right, returns are straightforward — and your mask is backed by a 60-day comfort guarantee. Here's how to start a return or exchange."
      steps={steps}
      faqs={[
        {
          q: "What is the 60-day comfort guarantee?",
          a: "If a mask fitted through PennPaps doesn't feel right after you've adjusted it, we'll exchange it for an alternative within the first 60 days at no charge — even if it's been worn.",
        },
        {
          q: "How long do refunds take?",
          a: "Once we receive your returned item, refunds are issued to your original payment method. Bank processing times vary but it's typically a few business days after we process the return.",
        },
        {
          q: "Can I exchange instead of refund?",
          a: (
            <>
              Yes — exchanges are encouraged, especially for fit issues.
              Choosing &ldquo;wrong fit&rdquo; as your reason flags it so we can
              suggest a better match. You can also{" "}
              <Link
                href="/help/find-your-mask"
                className="text-primary hover:underline"
              >
                re-run the fitter
              </Link>{" "}
              first.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "Find the order you want to return.",
        },
        {
          href: "/help/shop-and-checkout",
          label: "Shop supplies",
          blurb: "Reorder or pick a replacement.",
        },
      ]}
    />
  );
}
