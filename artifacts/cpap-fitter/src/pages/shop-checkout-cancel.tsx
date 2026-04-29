// /shop/checkout-cancel — Stripe redirects here when the user closes
// the Hosted Checkout tab without paying. We deliberately do NOT
// clear the cart, so the user can reopen it without rebuilding.

import React from "react";
import { Link } from "wouter";
import { ArrowLeft, ShieldCheck, ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function ShopCheckoutCancel() {
  useDocumentTitle("Checkout canceled");
  return (
    <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 max-w-xl">
      <div className="glass-card rounded-2xl p-8 md:p-10 text-center" data-testid="cancel-card">
        <div className="flex justify-center mb-5">
          <div className="h-14 w-14 rounded-2xl icon-halo-navy flex items-center justify-center">
            <ShoppingCart className="w-7 h-7" />
          </div>
        </div>
        <h1 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3">
          No charge made — your cart is saved.
        </h1>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          You closed the secure checkout window before completing
          payment. Your items are still in your cart whenever you&apos;re
          ready.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link href="/shop/cart">
            <Button className="w-full" data-testid="cancel-cart-cta">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to cart
            </Button>
          </Link>
          <Link href="/consent">
            <Button
              variant="outline"
              className="w-full"
              data-testid="cancel-insurance-cta"
            >
              <ShieldCheck className="w-4 h-4 mr-2" />
              Use insurance instead
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
