import React from "react";
import { Link } from "wouter";
import {
  ShieldCheck,
  CheckCircle2,
  PackageX,
  Truck,
  CalendarClock,
  Mail,
  Phone,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

/**
 * Public policy page for the 30-day comfort/fit guarantee. Linked
 * from every <ComfortGuarantee> badge across the funnel. Plain copy,
 * no marketing puffery — patients reading this are anxious and want
 * the rules.
 */
export function ComfortGuaranteePage() {
  useDocumentTitle(
    "30-day comfort guarantee",
    "Penn Home Medical Supply backs every CPAP mask with a 30-day comfort guarantee — swap for a different size or style if it doesn't fit.",
  );

  return (
    <main className="container mx-auto max-w-4xl px-4 md:px-6 py-12 md:py-16 space-y-12">
      <header className="text-center space-y-4">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl glass-card">
          <ShieldCheck className="w-7 h-7 text-primary" />
        </div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
          PennPaps · Customer Promise
        </p>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand">
          30-day comfort guarantee
        </h1>
        <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
          Mask fit is personal. If the one you ordered isn&apos;t comfortable,
          tell us within 30 days and we&apos;ll send a different size or
          style — and cover return shipping. No restocking fees.
        </p>
      </header>

      <section className="grid gap-5 md:grid-cols-3">
        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
            <CalendarClock className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">30 days from delivery</h3>
          <p className="text-sm text-muted-foreground">
            The clock starts the day your order is delivered, not the day you
            placed it. Plenty of time to actually sleep with the mask.
          </p>
        </article>

        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
            <Truck className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">We pay return shipping</h3>
          <p className="text-sm text-muted-foreground">
            We email a prepaid label. Drop the original mask at any USPS or
            UPS location. Your replacement ships as soon as the return scans.
          </p>
        </article>

        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">No restocking fee</h3>
          <p className="text-sm text-muted-foreground">
            One swap per order, free. We just ask that the mask, frame, and
            headgear come back with all original parts.
          </p>
        </article>
      </section>

      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            How to start a swap
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <ol className="space-y-4">
          {[
            {
              n: 1,
              title: "Email or call us within 30 days",
              body: "Reach out from the email address you used to order, or include your order number. We respond same business day.",
            },
            {
              n: 2,
              title: "Pick your replacement",
              body: "We'll suggest a different size, style, or family based on the issue (leak at the bridge, pressure on the lip, claustrophobia, etc.). You confirm before we ship.",
            },
            {
              n: 3,
              title: "Ship the original back, free",
              body: "We email a prepaid USPS or UPS label. Drop it at any location — no printer required if you have a QR code.",
            },
            {
              n: 4,
              title: "Replacement ships right away",
              body: "We don't wait for the return to land before sending the replacement when your account is in good standing — your therapy doesn't stop.",
            },
          ].map(({ n, title, body }) => (
            <li
              key={n}
              className="flex items-start gap-4 glass-card rounded-2xl p-5"
            >
              <div className="h-9 w-9 rounded-full bg-[hsl(var(--penn-gold)/0.15)] text-[hsl(var(--penn-navy))] font-bold flex items-center justify-center shrink-0">
                {n}
              </div>
              <div className="space-y-1">
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            What&apos;s covered (and what isn&apos;t)
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <article className="glass-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-[hsl(var(--penn-navy))]">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              <h3 className="font-semibold">Covered</h3>
            </div>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-5">
              <li>Mask systems (frame + cushion + headgear) bought from PennPaps.</li>
              <li>Mask cushions purchased on their own.</li>
              <li>Headgear and frames purchased on their own.</li>
              <li>One swap per order (size, style, or different family).</li>
            </ul>
          </article>
          <article className="glass-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-[hsl(var(--penn-navy))]">
              <PackageX className="w-5 h-5 text-rose-600" />
              <h3 className="font-semibold">Not covered</h3>
            </div>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-5">
              <li>Disposable supplies — filters, tubing, water chambers (hygiene).</li>
              <li>CPAP machines (covered by the manufacturer warranty).</li>
              <li>Returns started after 30 days from delivery.</li>
              <li>Items missing original parts (frame, clips, headgear).</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="rounded-2xl border bg-gradient-to-br from-[hsl(var(--penn-gold)/0.08)] to-[hsl(var(--penn-navy)/0.05)] p-6 sm:p-8 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Need to start a swap right now?
        </h2>
        <p className="text-muted-foreground">
          Email{" "}
          <a
            className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
            href="mailto:support@pennpaps.com"
          >
            support@pennpaps.com
          </a>{" "}
          with your order number, or call{" "}
          <a
            className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
            href="tel:+18005551234"
          >
            (800) 555-1234
          </a>{" "}
          Monday–Friday, 8am–6pm ET. If you&apos;re signed in, you can also
          start it directly from your order history.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href="mailto:support@pennpaps.com">
            <Button variant="outline">
              <Mail className="w-4 h-4 mr-2" /> Email support
            </Button>
          </a>
          <a href="tel:+18005551234">
            <Button variant="outline">
              <Phone className="w-4 h-4 mr-2" /> Call us
            </Button>
          </a>
          <Link href="/shop/orders">
            <Button>
              View my orders <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </section>
    </main>
  );
}
