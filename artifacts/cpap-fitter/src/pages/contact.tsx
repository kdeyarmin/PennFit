// /contact — how to reach a human, on one page.
//
// This page has two jobs:
//   1. It is the general "talk to us" surface linked from prose across the
//      storefront (footer column, FAQ, chat launcher copy).
//   2. It is the landing target for the fitter's fit-withheld screen
//      ("Talk to a specialist", components/clinical-results.tsx) — the one
//      case where a visitor arrives because the scan flagged something a
//      human must review. The clinical callout below speaks to exactly
//      that visitor, so the page must never dead-end them.
//
// Every contact detail renders through useCompanyContact() so the page is
// tenant-branded (admin-saved values), never hardcoded to the seed tenant.
// The phone card hides entirely when the tenant has no support number —
// the platform fallback identity ships without one.

import React from "react";
import { Link } from "wouter";
import { Clock, Mail, MessageCircle, Phone, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useCompanyContact } from "@/lib/contact";
import { openPennBot } from "@/lib/chat-events";

export function Contact() {
  const contact = useCompanyContact();
  useDocumentTitle(
    "Contact us",
    `Call, email, or chat with ${contact.legalName} — real people who can help with masks, orders, and anything the fitter flagged.`,
  );
  useDocumentMeta({
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ContactPage",
      name: `Contact ${contact.name}`,
      description: `How to reach ${contact.legalName} by phone, email, or chat.`,
    },
  });

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-12 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Contact {contact.name}
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Talk to a Real Person
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Questions about a mask, an order, or something the fitter flagged?
          Reach us whichever way is easiest — a human reads every message.
        </p>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" aria-hidden="true" />
          <span>Team hours: {contact.hours}</span>
        </p>
      </header>

      {/* Ways to reach us */}
      <section
        aria-label="Ways to contact us"
        className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        {contact.phoneE164 ? (
          <div className="glass-panel rounded-xl p-6 space-y-3 shadow-sm">
            <div className="inline-flex items-center gap-2 text-primary font-semibold">
              <Phone className="w-5 h-5" aria-hidden="true" />
              <h2 className="text-base">Call us</h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Fastest for anything urgent. Our voice assistant answers around
              the clock and hands you to the team during business hours.
            </p>
            <Button asChild className="w-full">
              <a href={`tel:${contact.phoneE164}`}>{contact.phoneDisplay}</a>
            </Button>
          </div>
        ) : null}

        <div className="glass-panel rounded-xl p-6 space-y-3 shadow-sm">
          <div className="inline-flex items-center gap-2 text-primary font-semibold">
            <Mail className="w-5 h-5" aria-hidden="true" />
            <h2 className="text-base">Email us</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Best for anything with details or attachments. We reply within one
            business day.
          </p>
          <Button asChild variant="outline" className="w-full">
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </Button>
        </div>

        <div className="glass-panel rounded-xl p-6 space-y-3 shadow-sm">
          <div className="inline-flex items-center gap-2 text-primary font-semibold">
            <MessageCircle className="w-5 h-5" aria-hidden="true" />
            <h2 className="text-base">Chat with us</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {contact.assistantStorefrontName} answers instantly and brings in
            the team whenever you ask for a person.
          </p>
          <Button
            variant="outline"
            className="w-full"
            // Plain openPennBot() lands on the CHAT tab — the assistant
            // input this card promises. (contactTab: true would open the
            // launcher's phone/email panel instead.)
            onClick={() => openPennBot()}
          >
            Start a conversation
          </Button>
        </div>
      </section>

      {/* Clinical hand-off callout — the fit-withheld screen links here. */}
      <section
        aria-label="After a flagged mask fitting"
        className="glass-panel rounded-xl p-6 md:p-8 space-y-3 shadow-sm border-l-4 border-[hsl(var(--penn-gold))]"
      >
        <div className="inline-flex items-center gap-2 text-primary font-semibold">
          <Stethoscope className="w-5 h-5" aria-hidden="true" />
          <h2 className="text-base">Sent here by the mask fitter?</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          If your scan or answers flagged something that needs a human look,
          that&apos;s exactly what our specialists are for. Call or email with
          the name on your fitting session and we&apos;ll review it together —
          and if anything suggests a therapy or medical concern, we&apos;ll
          point you to your sleep provider rather than guess.
        </p>
      </section>

      {/* Self-serve pointers */}
      <p className="text-center text-sm text-muted-foreground">
        Prefer self-serve? Step-by-step guides live in the{" "}
        <Link
          href="/help"
          className="text-[hsl(var(--penn-gold))] hover:underline font-medium"
        >
          Help Center
        </Link>{" "}
        and quick answers in the{" "}
        <Link
          href="/faq"
          className="text-[hsl(var(--penn-gold))] hover:underline font-medium"
        >
          FAQ
        </Link>
        .
      </p>
    </div>
  );
}
