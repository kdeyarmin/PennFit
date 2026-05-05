// Floating contact launcher (Phase A.2 — feature #20).
//
// A small fixed-position bubble in the bottom-right that opens a
// popover with three contact channels:
//   * Phone (tap-to-call on mobile, displays the number on desktop)
//   * Email
//   * "Message your account" deep link to /account#messages — only
//     shown for signed-in users since that surface requires auth.
//
// Why a launcher and not an inline chat widget: the in-app
// messaging surface (Phase 2) is auth-gated and requires the
// account context. Forcing every page to load the conversation
// thread would either degrade gracefully to noise on guest pages
// or require a stub render. The launcher keeps the surface light
// and routes to the right place based on auth state.
//
// Hidden on the admin SPA — admin shell has its own chrome and
// doesn't need a customer-facing contact bubble.

import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { MessageCircle, Phone, Mail, ArrowRight, X } from "lucide-react";

import { SignedIn } from "@/lib/identity";
import {
  SUPPORT_EMAIL,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
} from "@/lib/contact";

export function FloatingContactLauncher() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);

  // Close on route change so the popover doesn't linger across
  // navigations. Cheap to do; useLocation is the same hook the
  // ScrollToTop helper subscribes to in layout.tsx.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  // The admin SPA mounts its own shell; we don't want to overlap
  // a contact bubble with an admin nav. Wouter's location is the
  // SPA path including any base; we check the prefix.
  if (location.startsWith("/admin")) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 print:hidden"
      data-testid="floating-contact"
    >
      {open && (
        <div
          className="mb-3 w-72 rounded-xl border border-border bg-background shadow-xl overflow-hidden"
          role="dialog"
          aria-label="Contact PennPaps support"
          data-testid="floating-contact-popover"
        >
          <div className="px-4 py-3 bg-[hsl(var(--penn-navy))] text-white flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Need a hand?</div>
              <div className="text-[11px] opacity-80">{SUPPORT_HOURS}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md hover:bg-white/10 p-1"
              aria-label="Close"
              data-testid="floating-contact-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-2">
            <a
              href={`tel:${SUPPORT_PHONE_E164}`}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
              data-testid="floating-contact-phone"
            >
              <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center">
                <Phone className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  Call us
                </span>
                <span className="block text-xs text-muted-foreground">
                  {SUPPORT_PHONE_DISPLAY}
                </span>
              </span>
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
              data-testid="floating-contact-email"
            >
              <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center">
                <Mail className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  Email
                </span>
                <span className="block text-xs text-muted-foreground truncate">
                  {SUPPORT_EMAIL}
                </span>
              </span>
            </a>
            <SignedIn>
              <Link
                href="/account#messages"
                className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/40"
                data-testid="floating-contact-thread"
              >
                <span className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-gold)/0.20)] flex items-center justify-center">
                  <MessageCircle className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    Message your CSR
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Replies show up in your account
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            </SignedIn>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-14 w-14 rounded-full shadow-lg bg-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-navy-deep))] text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-gold))] focus-visible:ring-offset-2"
        aria-label={open ? "Close contact menu" : "Open contact menu"}
        aria-expanded={open}
        data-testid="floating-contact-toggle"
      >
        {open ? (
          <X className="h-6 w-6" />
        ) : (
          <MessageCircle className="h-6 w-6" />
        )}
      </button>
    </div>
  );
}
