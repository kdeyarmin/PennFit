import React from "react";
import { Link } from "wouter";
import { ShoppingCart } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, ShopShot, CartShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open the shop",
    body: (
      <p>
        Choose{" "}
        <Link href="/shop" className="text-primary hover:underline">
          Shop
        </Link>{" "}
        from the top menu to browse cushions, headgear, filters, tubing,
        humidifier chambers, and more. Most consumables are cash-pay and
        don&apos;t require a prescription.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/shop"
        caption="The shop lists supplies as product cards, with a search box and your cart in the top corner."
      >
        <ShopShot />
      </Screenshot>
    ),
  },
  {
    title: "Find what you need",
    body: (
      <p>
        Use the <strong>search box</strong> to jump straight to an item, or
        scroll the grid. Tap any product card to see sizing, compatibility, and
        photos on its detail page.
      </p>
    ),
    substeps: [
      <>
        Type a keyword like &ldquo;cushion&rdquo;, &ldquo;filter&rdquo;, or your
        mask model.
      </>,
      <>Open a product to confirm it fits your machine and mask.</>,
      <>
        Check the size/variant selector before adding — sizes differ by mask.
      </>,
    ],
    tip: "Saving an item for later? Tap the heart to add it to your wishlist — it'll be waiting next time you visit.",
  },
  {
    title: "Add items to your cart",
    body: (
      <p>
        Tap <strong>Add to cart</strong> on any product. The cart counter in the
        header updates, and a mini-cart preview lets you peek at what&apos;s
        inside without leaving the page.
      </p>
    ),
    note: "Your cart is saved on this device, so you can keep browsing and come back to it — even if you close the tab.",
  },
  {
    title: "Review your cart",
    body: (
      <p>
        Open the cart to check quantities and the running total before you pay.
      </p>
    ),
    substeps: [
      <>
        Tap the <strong>cart icon</strong> in the header.
      </>,
      <>
        Use the <strong>− / +</strong> steppers to change quantities, or remove
        anything you don&apos;t want.
      </>,
      <>
        Confirm the total looks right, then tap <strong>Checkout</strong>.
      </>,
    ],
    shot: (
      <Screenshot
        url="pennpaps.com/shop/cart"
        caption="Adjust quantities with the steppers; the summary keeps a live total."
      >
        <CartShot />
      </Screenshot>
    ),
  },
  {
    title: "Check out securely",
    body: (
      <p>
        Checkout is handled by <strong>Stripe</strong>, our secure payment
        processor — PennPaps never sees or stores your full card number. Enter
        your shipping and payment details and confirm. You&apos;ll get an order
        confirmation by email, and you can{" "}
        <Link
          href="/help/track-your-order"
          className="text-primary hover:underline"
        >
          track the order
        </Link>{" "}
        anytime.
      </p>
    ),
    warning:
      "If checkout doesn't open, your browser may be blocking the secure payment window — disable any pop-up blocker for pennpaps.com and try again.",
  },
];

export function HelpShopAndCheckout() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Shop supplies & check out"
      Icon={ShoppingCart}
      minutes="3 min"
      metaDescription="How to shop CPAP supplies on PennPaps: browsing and searching products, adding to your cart, reviewing quantities, and checking out securely with Stripe."
      intro="Need replacement cushions, filters, or tubing? The PennPaps shop works like any online store. Here's how to find supplies, build your cart, and check out safely."
      summary={
        <>
          Open <strong>Shop</strong>, search or browse for supplies, add them to
          your cart, review quantities, and check out securely through Stripe.
          Most consumables need no prescription.
        </>
      }
      prerequisites={[
        "Nothing to start browsing — no account or prescription needed for most consumables.",
        "A payment card for checkout (processed securely by Stripe).",
      ]}
      steps={steps}
      next={{
        href: "/help/track-your-order",
        label: "Track your order",
        blurb: "Watch your package move from shipped to your doorstep.",
      }}
      faqs={[
        {
          q: "Do I need a prescription to buy supplies?",
          a: "Most consumables — filters, tubing, cushions, and humidifier chambers — are cash-pay and need no prescription. Complete masks and machines are prescription devices.",
        },
        {
          q: "Is my payment secure?",
          a: "Yes. Checkout runs through Stripe, a PCI-compliant payment processor. Your full card details never touch PennPaps' servers.",
        },
        {
          q: "Can I bill supplies to insurance instead?",
          a: (
            <>
              Shop purchases are cash-pay. To use insurance on a regular
              replacement cadence, set up{" "}
              <Link
                href="/help/resupply-reminders"
                className="text-primary hover:underline"
              >
                resupply reminders
              </Link>{" "}
              and we&apos;ll bill insurance on schedule.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "Watch your package move toward your door.",
        },
        {
          href: "/help/save-to-wishlist",
          label: "Save & reorder favorites",
          blurb: "Keep supplies handy for one-tap reordering.",
        },
        {
          href: "/help/returns-and-refunds",
          label: "Returns & refunds",
          blurb: "Send something back or exchange it.",
        },
      ]}
    />
  );
}
