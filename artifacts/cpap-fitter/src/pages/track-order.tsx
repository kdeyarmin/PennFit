// /track-order — public order-status lookup (no login).
//
// What this is
// ------------
// A 2-field form (order reference + email) → calls /api/orders/track
// → renders a small status card. No login required, no PHI surfaced.
// Captures the single largest "where's my order?" inbound CSR
// contact deflectable with a simple self-service surface.
//
// Accepts mint `PENN-XXXXXX` (or bare 6) plus legacy `PHM-XXX-XXX`
// still in flight. Signed-in account history remains on /account.

import React, { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle2, Package, Search } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCompanyContact } from "@/lib/contact";
import { formatAppDate } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Matches mint (`PENN-`+6 / bare 6) plus legacy `PHM-XXX-XXX` still in flight. */
const REF_RE =
  /^(?:(?:PENN-)?[A-Za-z0-9]{6}|PHM-[A-Za-z0-9]{3}-[A-Za-z0-9]{3})$/i;

interface TrackResult {
  orderReference: string;
  mask: { name: string; manufacturer: string | null };
  createdAt: string;
  emailStatus: string | null;
  emailDeliveredAt: string | null;
}

function formatStatus(s: string | null): {
  label: string;
  description: string;
} {
  switch (s) {
    case "sent":
      return {
        label: "Received",
        description:
          "Our fulfillment team has your order. A team member contacts you within 1 business day.",
      };
    case "failed":
      return {
        label: "Delivery issue",
        description:
          "We hit a snag forwarding your order. Please call us or reply to your confirmation email.",
      };
    case "pending":
    case "skipped":
    default:
      return {
        label: "Processing",
        description: "Order received. Awaiting confirmation from our team.",
      };
  }
}

export function TrackOrder() {
  const company = useCompanyContact();
  useDocumentTitle(
    `Track my order — ${company.name}`,
    `Look up a ${company.name} order status without signing in. Enter your order reference and email.`,
  );

  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TrackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Synchronous in-flight guard. setState is async — a rapid
  // double Enter would fire handleSubmit twice with both calls
  // still seeing the old `submitting=false` until React commits
  // the next render. A ref flips synchronously so the second
  // call short-circuits.
  const inFlightRef = React.useRef(false);

  const refValid = REF_RE.test(reference.trim());
  const emailValid = EMAIL_RE.test(email.trim());
  const canSubmit = refValid && emailValid && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/orders/track", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderReference: reference.trim().toUpperCase(),
          email: email.trim().toLowerCase(),
        }),
      });
      if (res.status === 404) {
        setError(
          "We couldn't find that order. Double-check the reference and the email match.",
        );
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Please try again in a moment.");
        return;
      }
      const data = (await res.json()) as TrackResult;
      setResult(data);
    } catch {
      setError("Something went wrong. Please try again in a moment.");
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 space-y-8 animate-shimmer-in">
      <header className="text-center space-y-3">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <Package className="w-4 h-4" />
            Order status
          </div>
        </div>
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Track my order
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Enter your {company.name} order reference (from your confirmation
          email) and the email you used to place it. No login needed.
        </p>
      </header>

      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            Order lookup
          </CardTitle>
          <CardDescription>
            Lost the reference?{" "}
            <Link
              href="/contact"
              className="text-primary underline-offset-4 hover:underline"
            >
              Contact us
            </Link>{" "}
            and we&apos;ll look it up. Signed-in patients can also message the
            team from{" "}
            <Link
              href="/account#messages"
              className="text-primary underline-offset-4 hover:underline"
            >
              Account → Messages
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <ResultCard result={result} onReset={() => setResult(null)} />
          ) : (
            <form
              onSubmit={handleSubmit}
              className="space-y-4"
              data-testid="track-order-form"
            >
              <div className="space-y-2">
                <Label htmlFor="track-reference">Order reference</Label>
                <Input
                  id="track-reference"
                  data-testid="track-reference"
                  // Shape only, no brand prefix. References minted under
                  // the seed tenant carry a "PENN-" prefix that the server
                  // still accepts (and a bare tail resolves to the same
                  // order), but this bundle serves every tenant's
                  // storefront — an example naming one of them would be
                  // wrong on all the others. The header above already tells
                  // the patient where to find their own reference.
                  placeholder="ABC123"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={20}
                  autoComplete="off"
                  aria-invalid={reference.length > 0 && !refValid}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="track-email">Email on the order</Label>
                <Input
                  id="track-email"
                  data-testid="track-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={email.length > 0 && !emailValid}
                />
              </div>
              {error && (
                <p
                  className="text-sm text-destructive"
                  data-testid="track-error"
                >
                  {error}
                </p>
              )}
              <Button
                type="submit"
                disabled={!canSubmit}
                data-testid="track-submit"
                className="w-full h-11 rounded-full btn-primary-glow disabled:shadow-none"
              >
                <Search className="w-4 h-4 mr-1.5" />
                {submitting ? "Looking up…" : "Look up my order"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ResultCard({
  result,
  onReset,
}: {
  result: TrackResult;
  onReset: () => void;
}) {
  const status = formatStatus(result.emailStatus);
  const maskLine = result.mask.manufacturer
    ? `${result.mask.manufacturer} ${result.mask.name}`
    : result.mask.name;
  return (
    <div className="space-y-4" data-testid="track-result">
      <div className="rounded-xl bg-[hsl(var(--penn-navy))]/[0.06] ring-1 ring-[hsl(var(--penn-navy))]/10 p-5 space-y-1">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Status
        </p>
        <p className="text-2xl font-bold text-primary inline-flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[hsl(var(--penn-gold))]" />
          {status.label}
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {status.description}
        </p>
      </div>
      <div className="rounded-xl glass-panel p-4 sm:p-5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Reference
          </span>
          <span className="font-mono text-sm font-semibold">
            {result.orderReference}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Mask
          </span>
          <span className="text-sm font-medium">{maskLine}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Submitted
          </span>
          <span className="text-sm">{formatAppDate(result.createdAt)}</span>
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onReset}
        className="w-full h-10 rounded-full"
      >
        Look up another order
      </Button>
    </div>
  );
}
