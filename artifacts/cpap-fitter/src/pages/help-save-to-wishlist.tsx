import React from "react";
import { Link } from "wouter";
import { Heart } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  ShopShot,
  WishlistShot,
  AccountShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Find a product you want to save",
    body: (
      <p>
        Browse the{" "}
        <Link href="/shop" className="text-primary hover:underline">
          shop
        </Link>{" "}
        or open any product&apos;s detail page. The wishlist is handy for
        supplies you&apos;ll reorder — cushions, filters, and tubing for your
        exact mask.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/shop"
        caption="Every product card and detail page has a heart icon to save it."
      >
        <ShopShot />
      </Screenshot>
    ),
  },
  {
    title: "Tap the heart to save it",
    body: (
      <p>
        Tap the <strong>heart icon</strong> on the product. It fills in to show
        it&apos;s saved, and a counter appears on the heart in the header so you
        always know how many items are on your list.
      </p>
    ),
    tip: "Tap the heart again anytime to remove an item — saving and un-saving is instant.",
  },
  {
    title: "Open your wishlist",
    body: (
      <p>
        Tap the <strong>heart icon in the header</strong> to open{" "}
        <Link href="/shop/wishlist" className="text-primary hover:underline">
          your wishlist
        </Link>
        . Everything you&apos;ve saved is listed together with its price and an{" "}
        <strong>Add to cart</strong> button.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/shop/wishlist"
        caption="Your saved items in one place — add any of them straight to the cart."
      >
        <WishlistShot />
      </Screenshot>
    ),
    note: "Your wishlist is saved on this device. Sign in to keep it with your account across devices.",
  },
  {
    title: "Reorder past purchases in one tap",
    body: (
      <p>
        For things you&apos;ve bought before, the fastest path is your account.
        Open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your orders
        </Link>{" "}
        and tap <strong>Reorder</strong> on any past order to drop the same
        items straight into your cart — no searching required.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="Every past order has a one-tap Reorder button."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
];

export function HelpSaveToWishlist() {
  return (
    <HelpArticleShell
      eyebrow="Shopping & Orders"
      title="Save favorites & reorder"
      Icon={Heart}
      minutes="2 min"
      metaDescription="How to use the PennPaps wishlist and reorder: save products with the heart icon, open your wishlist, add saved items to the cart, and reorder past purchases in one tap."
      intro="Keep the supplies you reorder within easy reach. Save products to your wishlist with a tap, and reorder past purchases without hunting for them again."
      summary={
        <>
          Tap the <strong>heart</strong> on any product to save it, open your
          wishlist from the header heart icon, and add saved items to your cart.
          For repeat buys, use <strong>Reorder</strong> on a past order in your
          account.
        </>
      }
      prerequisites={[
        "Nothing to save items — the wishlist works without an account on this device.",
        "An account (and a past order) to use one-tap Reorder across devices.",
      ]}
      steps={steps}
      next={{
        href: "/help/resupply-reminders",
        label: "Set up resupply reminders",
        blurb: "Let us remind you to reorder before you run out.",
      }}
      faqs={[
        {
          q: "Is the wishlist saved if I leave?",
          a: "Yes — it's saved on your device, so it's there when you come back. Sign in to keep it with your account and see it on any device.",
        },
        {
          q: "What's the difference between the wishlist and Reorder?",
          a: "The wishlist is for things you want to save before buying. Reorder is a shortcut on past orders that re-adds exactly what you bought before.",
        },
        {
          q: "Can I move everything from my wishlist to the cart at once?",
          a: "Add saved items to the cart from the wishlist with each item's Add to cart button, then check out as usual.",
        },
      ]}
      related={[
        {
          href: "/help/shop-and-checkout",
          label: "Shop supplies & check out",
          blurb: "Turn your saved items into an order.",
        },
        {
          href: "/help/resupply-reminders",
          label: "Set up resupply reminders",
          blurb: "Get nudged when it's time to reorder.",
        },
      ]}
    />
  );
}
