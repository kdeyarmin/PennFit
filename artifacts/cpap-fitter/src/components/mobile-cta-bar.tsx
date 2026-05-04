// MobileCtaBar — sticky 3-button bar at the bottom of mobile
// viewports. Universally used on consumer DTC sites (Warby, Hims,
// Glossier) because the conversion lift on small screens is large
// and consistent.
//
// Self-gates by route: hidden on staff surfaces (/admin, /resupply),
// auth flows (/sign-in, /sign-up, /verify-email, /forgot-password,
// /reset-password), inside the fit-flow (/capture, /measure,
// /questionnaire, /results, /order, /order-success — already a
// dedicated stepper there), the cart/checkout pages, and the
// admin-console-tied storefront pages. Everywhere else (home, learn,
// faq, masks, shop list, account, insurance, etc.) the bar is
// visible on mobile and hidden on md+ screens where the desktop nav
// already puts these affordances in the header.
//
// Layout note: the bar is `fixed bottom-0` and uses
// env(safe-area-inset-bottom) so it sits above the iOS home
// indicator. The surrounding <main> in layout.tsx adds bottom
// padding on mobile so page content always scrolls clear of the
// bar.

import React from "react";
import { Link, useLocation } from "wouter";
import { ScanFace, ShoppingBag, MessageCircle } from "lucide-react";

const HIDDEN_PREFIXES = [
  "/admin",
  "/resupply",
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/capture",
  "/measure",
  "/questionnaire",
  "/results",
  "/order",
  "/order-success",
  "/shop/cart",
  "/shop/checkout",
];

function shouldHide(rawPath: string): boolean {
  // Strip query + hash so e.g. "/shop/cart?coupon=…" still hides.
  // wouter's useLocation returns pathname-only today, but the cost
  // of being defensive is one substring per render.
  const qIdx = rawPath.indexOf("?");
  const hIdx = rawPath.indexOf("#");
  let end = rawPath.length;
  if (qIdx >= 0) end = Math.min(end, qIdx);
  if (hIdx >= 0) end = Math.min(end, hIdx);
  const path = rawPath.slice(0, end);
  return HIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function MobileCtaBar() {
  const [location] = useLocation();
  if (shouldHide(location)) return null;

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border/60 bg-white/92 backdrop-blur-xl"
      style={{
        paddingBottom: "max(env(safe-area-inset-bottom), 0.25rem)",
      }}
      aria-label="Quick actions"
      data-testid="mobile-cta-bar"
    >
      <div className="grid grid-cols-3 text-[11px] font-medium">
        <Link
          href="/consent"
          className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 text-[hsl(var(--penn-navy))] active:bg-secondary/40 transition-colors"
          data-testid="mobile-cta-fit"
        >
          <ScanFace className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
          <span>Get fitted</span>
        </Link>
        <Link
          href="/shop"
          className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 text-[hsl(var(--penn-navy))] active:bg-secondary/40 transition-colors border-l border-r border-border/40"
          data-testid="mobile-cta-shop"
        >
          <ShoppingBag className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
          <span>Shop</span>
        </Link>
        <Link
          href="/faq"
          className="flex flex-col items-center justify-center gap-1 px-2 py-2.5 text-[hsl(var(--penn-navy))] active:bg-secondary/40 transition-colors"
          data-testid="mobile-cta-talk"
        >
          <MessageCircle
            className="w-5 h-5"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span>Talk to us</span>
        </Link>
      </div>
    </nav>
  );
}
