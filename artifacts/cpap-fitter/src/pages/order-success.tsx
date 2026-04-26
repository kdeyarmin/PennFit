import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Mail, Phone, Tag, Home, RefreshCcw, ShieldCheck } from "lucide-react";

interface OrderConfirmation {
  orderReference: string;
  deliveredAt: string;
  message: string;
  mask: {
    name: string;
    manufacturer: string;
    modelNumber: string;
  };
}

export function OrderSuccess() {
  const [, setLocation] = useLocation();
  const { reset } = useFitterStore();
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("fitter_order_confirmation");
      if (!stored) {
        setLocation("/");
        return;
      }
      setConfirmation(JSON.parse(stored));
    } catch {
      setLocation("/");
    }
  }, [setLocation]);

  if (!confirmation) return null;

  const handleStartOver = () => {
    sessionStorage.removeItem("fitter_order_confirmation");
    reset();
    setLocation("/");
  };

  return (
    <div className="container max-w-2xl mx-auto px-4 py-16 animate-in fade-in duration-500">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 text-green-700 mb-6 ring-8 ring-green-50">
          <CheckCircle2 className="w-10 h-10" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" data-testid="text-success-heading">
          Order Sent Successfully
        </h1>
        <p className="text-lg text-muted-foreground max-w-lg mx-auto">{confirmation.message}</p>
      </div>

      <Card className="mb-6 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
        <CardContent className="p-6 space-y-5">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              Your order reference
            </div>
            <div
              className="font-mono text-2xl font-bold text-primary tracking-wider"
              data-testid="text-order-reference"
            >
              {confirmation.orderReference}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Save this reference for your records and to mention when calling Penn Home Medical Supply.
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5" />
              Mask Ordered
            </div>
            <div className="font-semibold leading-tight">{confirmation.mask.name}</div>
            <div className="text-sm text-muted-foreground">
              {confirmation.mask.manufacturer} ·{" "}
              <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">
                {confirmation.mask.modelNumber}
              </code>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-semibold text-lg">What happens next</h3>
          <ol className="space-y-3 text-sm">
            <Step n={1}>
              <strong>Within 1 business day:</strong> A Penn Home Medical Supply team member will call or
              email you to confirm your order and verify your insurance benefits.
            </Step>
            <Step n={2}>
              <strong>Prescription verification:</strong> If we don't already have your CPAP prescription on
              file, we'll coordinate with your physician.
            </Step>
            <Step n={3}>
              <strong>Shipping:</strong> Once your order is approved, your mask ships to the address you
              provided. Most orders arrive within 5–7 business days.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card className="mb-8 bg-muted/30 border-border">
        <CardContent className="p-5">
          <h4 className="font-semibold mb-3 text-sm">Questions about your order?</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Phone className="w-4 h-4 text-primary shrink-0" />
              <span>Call Penn Home Medical Supply</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Mail className="w-4 h-4 text-primary shrink-0" />
              <span>Email Penn Home Medical Supply</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Mention reference{" "}
            <code className="font-mono text-foreground bg-background px-1 py-0.5 rounded">
              {confirmation.orderReference}
            </code>{" "}
            when you contact us.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 text-xs text-muted-foreground p-4 rounded-lg bg-muted/20 mb-8">
        <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" />
        <p>
          Your order details have been securely transmitted to Penn Home Medical Supply. We do not store
          your insurance, contact, or address information on this website.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link href="/">
          <Button variant="outline" className="w-full sm:w-auto" data-testid="button-home">
            <Home className="w-4 h-4 mr-2" /> Back to Home
          </Button>
        </Link>
        <Button onClick={handleStartOver} variant="ghost" className="w-full sm:w-auto" data-testid="button-start-over">
          <RefreshCcw className="w-4 h-4 mr-2" /> Start a New Fitting
        </Button>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold">
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
