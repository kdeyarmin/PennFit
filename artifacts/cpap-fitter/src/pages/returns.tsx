import { Link } from "wouter";
import {
  PackageCheck,
  ShieldCheck,
  CalendarClock,
  Truck,
  PackageX,
  Mail,
  Phone,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function ReturnsPage() {
  useDocumentTitle(
    "Returns & refunds",
    "Penn Home Medical Supply return policy — 30 days for unopened supplies, 30-day fit guarantee on masks and cushions, free exchange shipping.",
  );

  return (
    <main className="container mx-auto max-w-4xl px-4 md:px-6 py-12 md:py-16 space-y-12">
      <header className="text-center space-y-4">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl glass-card">
          <PackageCheck className="w-7 h-7 text-primary" />
        </div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
          PennPaps · Returns &amp; Refunds
        </p>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand">
          Returns &amp; refunds
        </h1>
        <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
          Two simple promises: 30 days to return unopened supplies for a full
          refund, and a 30-day fit guarantee on every mask and cushion. If
          something isn&apos;t right, we&apos;ll make it right.
        </p>
      </header>

      <section className="grid gap-5 md:grid-cols-3">
        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
            <CalendarClock className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">30-day window</h3>
          <p className="text-sm text-muted-foreground">
            The clock starts the day your order is delivered. Plenty of time
            to actually try the supplies before you decide.
          </p>
        </article>

        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">Fit guarantee</h3>
          <p className="text-sm text-muted-foreground">
            Masks and cushions are covered even after they&apos;re opened. If
            the size or style isn&apos;t comfortable, we&apos;ll exchange it
            free.
          </p>
        </article>

        <article className="glass-card rounded-2xl p-6 space-y-2">
          <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
            <Truck className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">Free exchange shipping</h3>
          <p className="text-sm text-muted-foreground">
            We cover return shipping on fit-guarantee exchanges. No
            restocking fees, no surprise charges.
          </p>
        </article>
      </section>

      <section className="space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight">
          What can be returned
        </h2>
        <div className="space-y-4 text-sm md:text-base text-muted-foreground leading-relaxed">
          <p>
            <span className="font-semibold text-foreground">
              Unopened, unused supplies
            </span>{" "}
            — tubing, filters, headgear, humidifier chambers, and accessories
            in their original sealed packaging can be returned within 30 days
            of delivery for a full refund to your original payment method.
          </p>
          <p>
            <span className="font-semibold text-foreground">
              Masks and mask cushions
            </span>{" "}
            are covered by our 30-day fit guarantee even once they&apos;ve
            been opened and tried. If the fit isn&apos;t right, we&apos;ll
            send a different size or style at no charge — see the{" "}
            <Link
              href="/comfort-guarantee"
              className="text-primary hover:underline"
            >
              comfort guarantee details
            </Link>
            .
          </p>
          <p>
            <span className="font-semibold text-foreground">
              CPAP machines and humidifiers
            </span>{" "}
            can be returned unopened within 30 days. Once a device has been
            used, returns are evaluated case-by-case — please contact us
            before shipping anything back.
          </p>
        </div>
      </section>

      <section className="space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
          <PackageX className="w-6 h-6 text-muted-foreground" />
          What we can&apos;t accept back
        </h2>
        <ul className="space-y-2 text-sm md:text-base text-muted-foreground leading-relaxed list-disc pl-6">
          <li>
            Opened consumable supplies (tubing, filters, headgear) for hygiene
            reasons — federal regulation, not our preference.
          </li>
          <li>
            Items returned more than 30 days after delivery without prior
            arrangement.
          </li>
          <li>
            Custom or special-order items not stocked in our standard catalog.
          </li>
          <li>
            Items damaged after delivery from misuse — though shipping damage
            is always our problem to fix, not yours.
          </li>
        </ul>
      </section>

      <section className="space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight">
          How to start a return
        </h2>
        <ol className="space-y-3 text-sm md:text-base text-muted-foreground leading-relaxed list-decimal pl-6">
          <li>
            Sign in and open{" "}
            <Link href="/shop/orders" className="text-primary hover:underline">
              My orders
            </Link>
            . Find the order and click <em>Request return</em>.
          </li>
          <li>
            Tell us which items and why — a sentence is fine. We&apos;ll
            email a prepaid return label within one business day for fit
            exchanges, or a return authorization for refund requests.
          </li>
          <li>
            Drop the package at any USPS or UPS location. Once it arrives,
            refunds post in 3–5 business days; exchange shipments go out the
            same day we receive your return.
          </li>
        </ol>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild>
            <Link href="/shop/orders">
              Open my orders <ArrowRight className="w-4 h-4 ml-1.5" />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/comfort-guarantee">
              Comfort guarantee details
            </Link>
          </Button>
        </div>
      </section>

      <section className="glass-card rounded-2xl p-6 md:p-8 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Need help before you ship?
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Our team would rather talk fit and comfort with you than process a
          return. If you&apos;re unsure whether to exchange or refund, reach
          out and we&apos;ll help you decide.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 pt-1">
          <a
            href="tel:+18142345678"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Phone className="w-4 h-4" /> Call Penn Home Medical Supply
          </a>
          <a
            href="mailto:support@pennpaps.com"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Mail className="w-4 h-4" /> support@pennpaps.com
          </a>
        </div>
      </section>
    </main>
  );
}

export default ReturnsPage;
