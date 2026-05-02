// /insurance — public, content-only explainer for "how insurance works
// at PennPaps". This page exists because every prominent "Use insurance"
// link on the site previously dumped customers into /consent (the
// camera/biometrics consent screen at the start of the fitter), which
// broke the implicit promise of the link label. Customers who want to
// LEARN how insurance billing works land here; the bottom of the page
// hands them off to /consent only when they're ready to act.

import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  ShieldCheck,
  CheckCircle2,
  CalendarClock,
  FileText,
  Truck,
  PhoneCall,
  Sparkles,
  ArrowRight,
  HelpCircle,
  ShoppingBag,
  Stethoscope,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { InsuranceLeadForm } from "@/components/insurance-lead-form";

type Step = {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: React.ReactNode;
};

const steps: Step[] = [
  {
    Icon: ShieldCheck,
    title: "You tell us your insurance",
    body: (
      <>
        On the order form you enter your insurance carrier, member ID,
        group number, and the patient's date of birth. That's it — we
        don't need a paper card, and you don't need to call your plan
        first.
      </>
    ),
  },
  {
    Icon: FileText,
    title: "We verify your benefits",
    body: (
      <>
        Our team checks your plan in real time: what's covered, what
        replacement cadence your plan allows, your deductible status,
        and any copay. If anything would cost you out-of-pocket, we
        contact you before shipping — never a surprise bill.
      </>
    ),
  },
  {
    Icon: Stethoscope,
    title: "We coordinate the prescription",
    body: (
      <>
        CPAP masks are prescription medical devices. If we don't already
        have a current prescription on file, we reach out to your sleep
        provider directly to get one — you don't have to be the
        messenger. Most prescriptions come back within 1–3 business days.
      </>
    ),
  },
  {
    Icon: Truck,
    title: "We ship and bill the plan",
    body: (
      <>
        Once benefits and prescription are confirmed, your supplies
        ship from our warehouse in 1–3 business days. We bill your
        insurance directly. You get an email with tracking — and, in
        most cases, no bill at all.
      </>
    ),
  },
];

type ScheduleRow = {
  item: string;
  cadence: string;
  note: string;
};

const schedule: ScheduleRow[] = [
  { item: "Mask cushions", cadence: "Every 2–4 weeks", note: "Highest impact on therapy comfort" },
  { item: "Mask frame", cadence: "Every 3 months", note: "Per most commercial plans" },
  { item: "Headgear", cadence: "Every 6 months", note: "Elastic stretches over time" },
  { item: "Tubing (standard or heated)", cadence: "Every 3 months", note: "Mineral buildup compromises pressure" },
  { item: "Disposable filters", cadence: "Every month", note: "Reusable filters: rinse weekly" },
  { item: "Humidifier chamber", cadence: "Every 6 months", note: "Even with distilled water" },
];

type FaqRow = { q: string; a: React.ReactNode };

const faqs: FaqRow[] = [
  {
    q: "What does insurance typically cost me out of pocket?",
    a: (
      <>
        For most patients with active in-network coverage, CPAP supplies
        are <strong>$0 out of pocket</strong> on the standard
        replacement schedule. If you haven't met your deductible yet,
        or your plan has a copay or coinsurance for durable medical
        equipment, we'll tell you the exact amount before we ship.
      </>
    ),
  },
  {
    q: "Which insurance plans do you work with?",
    a: (
      <>
        Penn Home Medical Supply works with <strong>Medicare</strong>,{" "}
        <strong>Medicaid</strong>, and most major commercial insurers
        (Aetna, Anthem/BCBS, Cigna, Humana, UnitedHealthcare, and many
        regional plans). If you're not sure your plan is in-network,
        start an order — verifying your coverage is the first thing we do
        and there's no obligation to proceed.
      </>
    ),
  },
  {
    q: "What if I don't have a prescription?",
    a: (
      <>
        Most patients who already use CPAP have an active prescription
        on file with their sleep provider. If you do, we just need their
        name and we'll request a copy directly. If you've never used
        CPAP and don't have a sleep study yet, your primary care doctor
        can refer you for one — we're for patients who already have a
        diagnosis.
      </>
    ),
  },
  {
    q: "Will my insurance cover a brand-new mask, or only refills?",
    a: (
      <>
        Both. Most plans cover a new mask every 3 months and replacement
        cushions and headgear on the schedule above. If your current
        mask doesn't fit and you're outside that window, your provider
        can write a medical-necessity letter — we'll help coordinate it.
      </>
    ),
  },
  {
    q: "What if my insurance won't cover something I need?",
    a: (
      <>
        You always have the option to pay cash through our{" "}
        <Link
          href="/shop"
          className="text-primary underline-offset-4 hover:underline"
        >
          shop
        </Link>{" "}
        — usually the same supplies, billed directly to your card with
        no insurance hoops. We'll tell you upfront if cash-pay is the
        better path for any specific item.
      </>
    ),
  },
  {
    q: "How quickly does this all happen?",
    a: (
      <>
        Insurance verification and prescription confirmation typically
        take 1–3 business days. Once both are cleared, supplies ship
        within 1–3 business days from our warehouse. From submission to
        delivery is usually under a week for repeat patients with
        active prescriptions.
      </>
    ),
  },
];

export function Insurance() {
  useDocumentTitle(
    "How insurance works",
    "How CPAP insurance billing works at Penn Home Medical Supply: $0 typical out-of-pocket, what's covered, the replacement schedule, and how we coordinate your prescription.",
  );
  return (
    <div className="container max-w-5xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero — matches Learn/FAQ pattern */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <ShieldCheck className="w-4 h-4" />
            <span>Insurance &amp; Billing at PennPaps</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              How Insurance Works
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Most patients pay $0 out of pocket.
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          For in-network patients with active coverage, CPAP supplies are
          billed directly to your insurance on a schedule your plan
          already covers. We handle benefits, prescriptions, and the
          claim — you just get the supplies.
        </p>
      </header>

      {/* Lead-capture form — primary conversion path on this page */}
      <section id="verify">
        <InsuranceLeadForm />
      </section>

      {/* Top-level promise */}
      <section className="grid sm:grid-cols-3 gap-4">
        {[
          {
            Icon: ShieldCheck,
            title: "$0 typical copay",
            body: "In-network patients on standard replacement schedules usually pay nothing out of pocket.",
            halo: "icon-halo-gold",
          },
          {
            Icon: FileText,
            title: "We do the paperwork",
            body: "Benefits verification, prescription requests, and claim filing — all on us.",
            halo: "icon-halo-navy",
          },
          {
            Icon: PhoneCall,
            title: "No surprise bills",
            body: "If anything would cost you anything, we tell you before we ship.",
            halo: "icon-halo-gold",
          },
        ].map(({ Icon, title, body, halo }) => (
          <article
            key={title}
            className="glass-card lift-on-hover rounded-2xl p-6 space-y-3"
          >
            <div className={`h-11 w-11 rounded-xl ${halo} flex items-center justify-center`}>
              <Icon className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">{title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
          </article>
        ))}
      </section>

      {/* The 4-step process */}
      <section className="space-y-5">
        <div className="text-center space-y-2 max-w-2xl mx-auto">
          <h2 className="text-display text-2xl md:text-3xl font-semibold tracking-tight">
            How a PennPaps insurance order works
          </h2>
          <p className="text-muted-foreground">
            From the order form to your front door, here's exactly what
            happens — and what we do for you behind the scenes.
          </p>
        </div>
        <div className="grid gap-4">
          {steps.map(({ Icon, title, body }, i) => (
            <article
              key={title}
              className="glass-card lift-on-hover rounded-2xl p-6 flex gap-5"
            >
              <div className="shrink-0 flex flex-col items-center gap-2">
                <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-xs font-mono font-semibold text-[hsl(var(--penn-gold))]">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <div className="space-y-2 flex-1">
                <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Replacement schedule covered by most plans */}
      <section className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
            <CalendarClock className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
              What insurance typically covers
            </h2>
            <p className="text-sm text-muted-foreground">
              The cadences below match the standard replacement schedule
              most patients use. Some plans (Medicare in particular) may
              cover specific items more frequently — we verify your
              exact benefit before each order.
            </p>
          </div>
        </div>
        <div className="glass-card rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-foreground">
              <tr>
                <th scope="col" className="text-left font-semibold tracking-tight px-5 py-3">
                  Item
                </th>
                <th scope="col" className="text-left font-semibold tracking-tight px-5 py-3">
                  Replacement cadence
                </th>
                <th scope="col" className="text-left font-semibold tracking-tight px-5 py-3 hidden sm:table-cell">
                  Note
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {schedule.map((row) => (
                <tr key={row.item} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-5 py-3 font-medium">{row.item}</td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">
                    {row.cadence}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground hidden sm:table-cell">
                    {row.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground text-center">
          Don't want to track this yourself?{" "}
          <Link
            href="/reminders"
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            Sign up for free replacement reminders
          </Link>{" "}
          and we'll email you when each item is due.
        </p>
      </section>

      {/* What we need from you */}
      <section className="grid md:grid-cols-2 gap-4">
        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">What we need from you</h3>
          <ul className="text-sm text-muted-foreground leading-relaxed space-y-2 list-disc list-inside">
            <li>Insurance carrier, member ID, group number</li>
            <li>Patient's full name and date of birth</li>
            <li>Shipping address</li>
            <li>The name of your sleep provider (if we don't already have your prescription)</li>
          </ul>
        </div>
        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight">What we handle for you</h3>
          <ul className="text-sm text-muted-foreground leading-relaxed space-y-2 list-disc list-inside">
            <li>Real-time benefits verification with your plan</li>
            <li>Prescription request from your sleep provider</li>
            <li>Insurance claim filing and follow-up</li>
            <li>Up-front notice of any out-of-pocket cost before we ship</li>
          </ul>
        </div>
      </section>

      {/* FAQ */}
      <section className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
            <HelpCircle className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
              Common insurance questions
            </h2>
            <p className="text-sm text-muted-foreground">
              The things patients ask us most before placing an order.
            </p>
          </div>
        </div>
        <div className="glass-card rounded-2xl p-2 sm:p-4">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((row, i) => (
              <AccordionItem
                key={row.q}
                value={`insurance-faq-${i}`}
                className="border-border/50 last:border-b-0"
              >
                <AccordionTrigger
                  className="text-left text-base font-semibold hover:no-underline hover:text-primary px-2"
                  data-testid={`insurance-faq-trigger-${i}`}
                >
                  {row.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed text-sm px-2 pb-4">
                  {row.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* No insurance? */}
      <section>
        <div className="glass-card rounded-2xl relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 100% 0%, hsl(var(--penn-gold) / 0.18), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <div className="p-6 sm:p-8 flex flex-col sm:flex-row gap-5 items-start relative">
            <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
              <ShoppingBag className="w-5 h-5" />
            </div>
            <div className="space-y-2 flex-1">
              <h3 className="text-xl font-semibold tracking-tight">
                No insurance? You can still order direct.
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The PennPaps shop sells the same cushions, filters,
                tubing, and bundles on a cash-pay basis — no
                prescription needed for most consumables, and we ship
                fast.
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                <Link href="/shop">
                  <Button
                    variant="outline"
                    className="rounded-full glass-panel border-border/60 gap-2"
                    data-testid="insurance-cta-shop"
                  >
                    Browse the cash-pay shop
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Primary CTA — start an insurance order */}
      <section className="text-center space-y-4 pt-2">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          Ready when you are.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Start an insurance order in about three minutes. We'll verify
          your benefits and reach out before any charge — no obligation
          to proceed.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link href="/consent">
            <Button
              size="lg"
              className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow gap-2"
              data-testid="insurance-cta-start-order"
            >
              <Sparkles className="w-4 h-4" />
              Start an insurance order
            </Button>
          </Link>
          <Link href="/faq">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full glass-panel border-border/60"
              data-testid="insurance-cta-faq"
            >
              Read the full FAQ
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
