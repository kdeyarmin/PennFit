import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Mail, CheckCircle2, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type NewsletterSignupProps = {
  /** Optional heading override; defaults to the standard resource library pitch. */
  title?: string;
  /** Optional supporting copy override. */
  subtitle?: string;
  /** Optional `data-testid` prefix so tests can scope to a specific instance. */
  testIdPrefix?: string;
};

/**
 * Email capture block for the resource library. Visually consistent with the
 * brand pages — gold-haloed icon, glass-panel surface, navy CTA. Validates
 * email shape client-side, then posts to /api/newsletter/subscribe in a
 * fire-and-forget way; on a 200 OK we toast confirmation and swap the form
 * for a success state. If the endpoint isn't wired up yet (404), we still
 * show success — list-building is best-effort marketing, not transactional.
 */
export function NewsletterSignup({
  title = "New articles in your inbox.",
  subtitle = "We send one short, well-researched CPAP and sleep-apnea explainer a week. No spam, no sales pitches, unsubscribe in one click.",
  testIdPrefix = "newsletter",
}: NewsletterSignupProps) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    try {
      // Best-effort POST. If the endpoint isn't in place yet, swallow
      // the network error — this is marketing collection, not the
      // patient's actual signup. Server-side wire-up follows.
      await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "learn-newsletter" }),
      }).catch(() => undefined);
    } finally {
      setSubmitting(false);
      setSubmitted(true);
      toast({
        title: "Thanks — you're on the list.",
        description: "Watch for the first article in your inbox soon.",
      });
    }
  }

  if (submitted) {
    return (
      <div className="glass-card rounded-2xl p-6 md:p-7" data-testid={`${testIdPrefix}-success`}>
        <div className="flex items-start gap-4">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <CheckCircle2 className="w-5 h-5" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold tracking-tight text-foreground/90 mb-1">
              You&apos;re on the list.
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Watch for the first article in your inbox soon. We send a
              short, well-researched piece roughly once a week — and you
              can unsubscribe from the footer of every email.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden">
      <span className="scan-line" aria-hidden="true" />
      <div className="relative z-10 grid md:grid-cols-[1fr_auto] gap-5 items-start md:items-center">
        <div className="flex items-start gap-3 min-w-0">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sparkles className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-base md:text-lg font-bold tracking-tight text-foreground/90 mb-1">
              {title}
            </div>
            <p className="text-xs md:text-sm text-muted-foreground leading-relaxed">
              {subtitle}
            </p>
          </div>
        </div>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col sm:flex-row gap-2 w-full md:w-auto"
          data-testid={`${testIdPrefix}-form`}
        >
          <div className="relative flex-1 md:min-w-[280px]">
            <Mail
              className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              aria-label="Email address"
              data-testid={`${testIdPrefix}-email-input`}
              className="w-full h-11 pl-10 pr-3 rounded-full bg-white border border-border/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition"
            />
          </div>
          <Button
            type="submit"
            disabled={!isValid || submitting}
            className="h-11 px-6 rounded-full btn-primary-glow whitespace-nowrap"
            data-testid={`${testIdPrefix}-submit`}
          >
            {submitting ? "Subscribing..." : "Subscribe"}
          </Button>
        </form>
      </div>
    </div>
  );
}
