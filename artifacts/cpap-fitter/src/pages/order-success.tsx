import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  CheckCircle2,
  Mail,
  Phone,
  Tag,
  Home,
  RefreshCcw,
  ShieldCheck,
  BookOpen,
} from "lucide-react";
import { ComfortGuarantee } from "@/components/comfort-guarantee";
import { SubscribeRemindersCta } from "@/components/subscribe-reminders-cta";
import {
  FacialMeasurementsCard,
  type FacialMeasurementsLike,
} from "@/components/facial-measurements-card";

interface OrderConfirmation {
  orderReference: string;
  message: string;
  mask: {
    name: string;
    manufacturer: string;
    modelNumber: string;
  };
  /**
   * Persisted on /order submit so the customer keeps seeing the
   * exact measurements Penn Home Medical Supply received, even
   * after the in-memory fitter store resets on success.
   */
  measurements?: FacialMeasurementsLike | null;
}

export function OrderSuccess() {
  useDocumentTitle("Order confirmed");
  const [, setLocation] = useLocation();
  const { reset } = useFitterStore();
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(
    null,
  );

  // The route-level OrderSuccessGate in App.tsx already verified that the
  // confirmation exists in sessionStorage before mounting this component.
  // We just hydrate it into local state on first mount.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("fitter_order_confirmation");
      if (stored) setConfirmation(JSON.parse(stored));
    } catch {
      /* fall through — the gate will redirect on next route change */
    }
  }, []);

  if (!confirmation) return null;

  const handleStartOver = () => {
    sessionStorage.removeItem("fitter_order_confirmation");
    reset();
    setLocation("/");
  };

  return (
    <div className="container max-w-2xl mx-auto px-4 py-16 animate-shimmer-in">
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6 callout-success">
          <CheckCircle2 className="w-9 h-9 text-[hsl(150,55%,30%)]" />
        </div>
        <div className="inline-flex items-center justify-center gap-3 mb-3">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Order Confirmed
          </span>
          <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
        </div>
        <h1
          className="text-display text-3xl md:text-5xl font-bold tracking-tight mb-3 text-gradient-brand"
          data-testid="text-success-heading"
        >
          Order Sent Successfully
        </h1>
        <p className="text-lg text-muted-foreground max-w-lg mx-auto">
          {confirmation.message}
        </p>
      </div>

      <Card className="mb-6 border-0 glass-card rounded-2xl ring-gold-soft">
        <CardContent className="p-6 space-y-5">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-[hsl(var(--penn-navy))]/70 font-semibold mb-1">
              Your order reference
            </div>
            <div
              className="font-mono text-3xl font-bold text-primary tracking-wider"
              data-testid="text-order-reference"
            >
              {confirmation.orderReference}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Save this reference for your records and to mention when calling
              Penn Home Medical Supply.
            </p>
          </div>

          <div className="border-t border-border/50 pt-4">
            <div className="text-xs uppercase tracking-[0.2em] text-[hsl(var(--penn-navy))]/70 font-semibold mb-2 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5" />
              Mask Ordered
            </div>
            <div className="font-semibold leading-tight tracking-tight">
              {confirmation.mask.name}
            </div>
            <div className="text-sm text-muted-foreground">
              {confirmation.mask.manufacturer} ·{" "}
              <code className="font-mono text-foreground bg-white/60 px-1.5 py-0.5 rounded text-xs">
                {confirmation.mask.modelNumber}
              </code>
            </div>
          </div>
        </CardContent>
      </Card>

      {confirmation.measurements && (
        <div className="mb-6">
          <FacialMeasurementsCard
            measurements={confirmation.measurements}
            testIdPrefix="order-success-facial-measurements"
          />
        </div>
      )}

      <Card className="mb-6 border-0 glass-card rounded-2xl">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-semibold text-lg tracking-tight">
            What happens next
          </h3>
          <ol className="space-y-4 text-sm">
            <Step n={1}>
              <strong>Within 1 business day:</strong> A Penn Home Medical Supply
              team member will call or email you to confirm your order and
              verify your insurance benefits.
            </Step>
            <Step n={2}>
              <strong>Prescription verification:</strong> If we don't already
              have your CPAP prescription on file, we'll coordinate with your
              physician.
            </Step>
            <Step n={3}>
              <strong>Shipping:</strong> Once your order is approved, your mask
              ships to the address you provided. Most orders arrive within 5–7
              business days.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card className="mb-8 border-0 glass-panel rounded-2xl">
        <CardContent className="p-5">
          <h4 className="font-semibold mb-3 text-sm tracking-tight">
            Questions about your order?
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2.5 text-muted-foreground">
              <div className="h-8 w-8 rounded-lg icon-halo-navy flex items-center justify-center shrink-0">
                <Phone className="w-3.5 h-3.5" />
              </div>
              <span>Call PennPaps</span>
            </div>
            <div className="flex items-center gap-2.5 text-muted-foreground">
              <div className="h-8 w-8 rounded-lg icon-halo-gold flex items-center justify-center shrink-0">
                <Mail className="w-3.5 h-3.5" />
              </div>
              <span>Email PennPaps</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Mention reference{" "}
            <code className="font-mono text-foreground bg-white/70 px-1 py-0.5 rounded">
              {confirmation.orderReference}
            </code>{" "}
            when you contact us.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 text-xs text-muted-foreground p-4 rounded-xl callout-navy mb-8">
        <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" />
        <p>
          Your order details have been securely transmitted to Penn Home Medical
          Supply. We do not store your insurance, contact, or address
          information on this website.
        </p>
      </div>

      <ComfortGuarantee variant="feature" className="mb-8" />

      {/* Resupply-reminder cross-sell. The patient just placed a mask
          order through insurance — now is the moment to enroll them
          in the cushion / filter / tubing reminder cadence so the
          rest of the supply chain stays on schedule. The shop's
          checkout-success page already does this; mirroring it here
          keeps both order-completion paths consistent. */}
      <div className="mb-6">
        <SubscribeRemindersCta variant="compact" />
      </div>

      <Link
        href="/learn/device-setup"
        className="block glass-card lift-on-hover rounded-2xl p-5 mb-6 group"
        data-testid="order-success-link-device-setup"
      >
        <div className="flex items-start gap-4">
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="flex-1 space-y-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              New to CPAP or BiPAP? Read the setup guide.
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Step-by-step instructions for unboxing, your first night, daily
              care, and fixes for the most common first-week issues.
            </p>
          </div>
        </div>
      </Link>

      <div className="flex flex-col sm:flex-row gap-3 justify-center flex-wrap">
        <Link href="/">
          <Button
            variant="outline"
            className="w-full sm:w-auto rounded-full glass-panel border-0 px-6"
            data-testid="button-home"
          >
            <Home className="w-4 h-4 mr-2" /> Back to Home
          </Button>
        </Link>
        <Link href="/shop">
          <Button
            variant="outline"
            className="w-full sm:w-auto rounded-full glass-panel border-0 px-6"
            data-testid="button-shop"
          >
            Shop supplies
          </Button>
        </Link>
        <Button
          onClick={handleStartOver}
          className="w-full sm:w-auto rounded-full btn-primary-glow px-6"
          data-testid="button-start-over"
        >
          <RefreshCcw className="w-4 h-4 mr-2" /> Start a new fitting
        </Button>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg icon-halo-navy text-xs font-bold font-mono">
        {String(n).padStart(2, "0")}
      </span>
      <span className="leading-relaxed pt-0.5">{children}</span>
    </li>
  );
}
