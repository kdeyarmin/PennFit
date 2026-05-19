// /insurance/estimate — quick coverage check.
//
// Low-friction sibling of /insurance's full lead form. The patient
// answers two questions (their payer + their email) and gets:
//
//   * An inline result card with a conservative range from the
//     static payer table.
//   * A written confirmation email with the same numbers + CTAs
//     into either the at-home fitting (/consent) or the full
//     verification form (/insurance).
//
// The full /insurance form (full name + DOB + member id + group) is
// still the path the verification team needs. This page exists for
// the top-of-funnel "will it be covered?" question, which the heavy
// form was scaring away.

import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CheckCircle2,
  Mail,
  ShieldCheck,
  Stethoscope,
  ArrowRight,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  PAYER_ESTIMATES,
  findPayerEstimate,
  formatEstimateRange,
} from "@/lib/insurance-estimate-data";
import { submitInsuranceEstimate } from "@/lib/shop-api";

// Lightweight email-shape guard. Server still validates canonically.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose US ZIP gate (5 or 5+4). Optional field; we only check shape
// to stop typos from hitting the server's stricter regex.
const ZIP_RE = /^\d{5}(-\d{4})?$/;

interface ServerEstimate {
  slug: string;
  label: string;
  lowDollars: number;
  highDollars: number;
  note: string;
}

export function InsuranceEstimate() {
  useDocumentTitle(
    "Quick CPAP coverage check — PennPaps",
    "Get a conservative estimate of your out-of-pocket cost per CPAP resupply in 30 seconds. No member-id required.",
  );

  const [email, setEmail] = useState("");
  const [payerSlug, setPayerSlug] = useState<string>("");
  const [zip, setZip] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ServerEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedEmail = email.trim();
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const zipValid = zip.length === 0 || ZIP_RE.test(zip.trim());
  const canSubmit = emailValid && payerSlug !== "" && zipValid && !submitting;

  const selected = useMemo(
    () => (payerSlug ? findPayerEstimate(payerSlug) : null),
    [payerSlug],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitInsuranceEstimate({
        email: trimmedEmail.toLowerCase(),
        payerSlug,
        zip: zip.trim() || undefined,
        marketingOptIn,
        website: "",
      });
      setResult(res.estimate);
    } catch (err) {
      const code = err instanceof Error ? err.message : "unknown";
      setError(
        code === "rate_limited"
          ? "You've submitted a few of these already — please try again in a few minutes."
          : "Something went wrong. Please try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 space-y-10 animate-shimmer-in">
      <header className="text-center space-y-4">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <ShieldCheck className="w-4 h-4" />
            30-second coverage check
          </div>
        </div>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Will my insurance cover this?
        </h1>
        <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Tell us your insurance carrier and we&apos;ll send you a written
          estimate of what most patients pay. No member-id required.
        </p>
      </header>

      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            Quick estimate
          </CardTitle>
          <CardDescription>
            We&apos;ll show you a range now and email a written copy you can
            share with your spouse or physician.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <ResultPanel result={result} zipShown={zip.trim() || null} />
          ) : (
            <form
              onSubmit={handleSubmit}
              className="space-y-5"
              data-testid="insurance-estimate-form"
            >
              <div className="space-y-2">
                <Label htmlFor="estimate-payer">Your insurance carrier</Label>
                <select
                  id="estimate-payer"
                  data-testid="estimate-payer"
                  value={payerSlug}
                  onChange={(e) => setPayerSlug(e.target.value)}
                  className="w-full h-10 px-3 rounded-md border bg-background text-sm"
                  required
                >
                  <option value="" disabled>
                    Choose your carrier…
                  </option>
                  {PAYER_ESTIMATES.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {selected && (
                  <p className="text-xs text-muted-foreground">
                    Typical range:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatEstimateRange(selected)}
                    </span>{" "}
                    per resupply, post-deductible.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="estimate-email">Your email</Label>
                <Input
                  id="estimate-email"
                  data-testid="estimate-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={email.length > 0 && !emailValid}
                />
                <p className="text-xs text-muted-foreground">
                  We&apos;ll email your estimate so you have it in writing.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="estimate-zip">
                  ZIP code{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="estimate-zip"
                  data-testid="estimate-zip"
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="12345"
                  maxLength={10}
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  aria-invalid={zip.length > 0 && !zipValid}
                />
              </div>

              <div
                className="flex flex-row items-start space-x-3 space-y-0 pt-1 cursor-pointer"
                onClick={() => setMarketingOptIn(!marketingOptIn)}
              >
                <Checkbox
                  id="estimate-marketing"
                  checked={marketingOptIn}
                  onCheckedChange={(checked) =>
                    setMarketingOptIn(checked as boolean)
                  }
                />
                <div className="space-y-1 leading-none">
                  <label
                    htmlFor="estimate-marketing"
                    className="text-sm font-medium cursor-pointer"
                  >
                    Send me occasional CPAP tips and product updates
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Off by default. Your estimate email is sent either way.
                  </p>
                </div>
              </div>

              {error && (
                <p
                  className="text-sm text-destructive"
                  data-testid="estimate-error"
                >
                  {error}
                </p>
              )}

              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                <Button
                  type="submit"
                  disabled={!canSubmit}
                  data-testid="estimate-submit"
                  className="sm:flex-1 h-11 rounded-full btn-primary-glow disabled:shadow-none"
                >
                  {submitting ? "Sending…" : "Email me my estimate"}
                </Button>
                <Link href="/insurance" className="sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-11 rounded-full"
                  >
                    Submit my member ID instead
                  </Button>
                </Link>
              </div>

              <p className="text-xs text-muted-foreground pt-1">
                This is an estimate, not a quote. We verify your specific
                plan&apos;s DME benefit before any charge.
              </p>
            </form>
          )}
        </CardContent>
      </Card>

      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/consent"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="estimate-link-consent"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <h3 className="font-semibold tracking-tight">
              Already know what you need?
            </h3>
            <p className="text-sm text-muted-foreground">
              Start the 5-minute at-home camera fitting.
            </p>
            <span className="text-sm font-medium text-primary inline-flex items-center gap-1">
              Begin fitting{" "}
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </Link>
        <Link
          href="/insurance"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="estimate-link-full-form"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Mail className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <h3 className="font-semibold tracking-tight">
              Want an exact answer?
            </h3>
            <p className="text-sm text-muted-foreground">
              Submit your member ID and our team verifies within one business
              day.
            </p>
            <span className="text-sm font-medium text-primary inline-flex items-center gap-1">
              Full verification{" "}
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </Link>
      </section>
    </div>
  );
}

function ResultPanel({
  result,
  zipShown,
}: {
  result: ServerEstimate;
  zipShown: string | null;
}) {
  const range =
    result.lowDollars === 0 && result.highDollars === 0
      ? "$0 (free)"
      : result.lowDollars === 0
        ? `$0–$${result.highDollars}`
        : `$${result.lowDollars}–$${result.highDollars}`;

  return (
    <div className="space-y-5" data-testid="insurance-estimate-result">
      <div className="rounded-xl bg-[hsl(var(--penn-navy))]/[0.06] ring-1 ring-[hsl(var(--penn-navy))]/10 p-5 text-center">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Typical patient pays per resupply
        </p>
        <p className="text-3xl font-bold tabular-nums text-primary mt-1">
          {range}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Post-deductible · {result.label}
        </p>
      </div>
      <div className="rounded-xl glass-panel p-4 sm:p-5 space-y-2">
        <p className="text-sm font-semibold text-primary flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
          We just emailed this to you
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {result.note}
        </p>
        {zipShown && (
          <p className="text-xs text-muted-foreground">
            ZIP we have on file for you: <strong>{zipShown}</strong>
          </p>
        )}
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link href="/consent" className="sm:flex-1">
          <Button className="w-full h-11 rounded-full btn-primary-glow">
            Start mask fitting
          </Button>
        </Link>
        <Link href="/insurance" className="sm:w-auto">
          <Button
            type="button"
            variant="outline"
            className="w-full h-11 rounded-full"
          >
            Verify my plan
          </Button>
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        This is an estimate, not a quote. We verify your specific plan&apos;s
        DME benefit before any charge.
      </p>
    </div>
  );
}
