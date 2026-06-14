import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ShieldCheck,
  Camera,
  ServerOff,
  AlertCircle,
  Database,
  Mail,
  MessageSquare,
} from "lucide-react";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { submitFitterLead } from "@/lib/shop-api";
import { formatUsPhone } from "@/lib/format-phone";

// Lightweight RFC-5322-ish check. The order form's zod schema runs a
// stricter validation at submit time; this one just guards the
// in-flow gate so the patient sees a clear error before clicking
// Continue, not a 400 from /capture.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Loose 10-or-11-digit US-phone check. Server-side does the canonical
// normalize-or-reject; this guard is purely UX so a clearly-wrong
// number gets an inline error before the patient clicks Continue.
const PHONE_DIGIT_RE = /^\d{10}$|^1\d{10}$/;

export function Consent() {
  useDocumentTitle("Privacy consent");
  const [, setLocation] = useLocation();
  const {
    email: storedEmail,
    emailConsent: storedEmailConsent,
    setEmailConsent,
    storagePersisted,
  } = useFitterStore();
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [email, setEmail] = useState(storedEmail ?? "");
  const [emailOptIn, setEmailOptIn] = useState(storedEmailConsent);
  // Phone is optional. SMS opt-in is a separate checkbox; the server
  // enforces that smsOptIn=true without a valid phone is dropped, but
  // the UI also disables the checkbox until a phone is present so the
  // intent is clear.
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);

  // home_view fires on mount — the consent page is the first content view
  // after the landing CTA, so it's the right anchor for the funnel.
  useEffect(() => {
    track("home_view");
  }, []);

  const trimmedEmail = email.trim();
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const phoneDigits = phone.replace(/[^\d]/g, "");
  // Phone is optional → either empty (skip block) or 10/11 US digits.
  const phoneValid =
    phoneDigits.length === 0 || PHONE_DIGIT_RE.test(phoneDigits);
  const phoneFilled = phoneDigits.length > 0;
  // Marketing opt-in is intentionally NOT part of the gate: we require the
  // camera consent + a valid email (so we can deliver the recommendation)
  // and a well-formed phone IF one was entered. Forcing the marketing
  // checkbox to advance would be a consent dark pattern — see the phone
  // block comment below, which already documents this intent.
  const canContinue = agreed && emailValid && phoneValid;

  const handleContinue = () => {
    if (!canContinue) return;
    const normalizedEmail = trimmedEmail.toLowerCase();
    setEmailConsent(normalizedEmail, emailOptIn);
    track("consent_given");
    // Fire-and-forget the server-side record so the opt-in row exists
    // even for patients who don't make it to /order. We deliberately
    // don't await — the in-memory FitterStore is the source of truth
    // for the rest of the flow, and the endpoint itself is best-effort
    // on the server side too. A failure here is logged for ops triage
    // and the patient still advances.
    submitFitterLead({
      email: normalizedEmail,
      marketingOptIn: emailOptIn,
      phone: phoneFilled ? phone.trim() : undefined,
      smsOptIn: phoneFilled && smsOptIn,
      website: "",
    }).catch((err: unknown) => {
      // Silent failure metric. The patient flow always advances —
      // see comment above the submit call — but a rising failure
      // rate here means downstream resupply funnels (supply
      // campaigns, conversion attribution) silently lose leads.
      // Emit a structured event so ops can graph the rate and a
      // creeping problem doesn't hide as a slow drop in fitter-
      // funnel volume.
      const raw = err instanceof Error ? err.message : String(err ?? "unknown");
      const httpMatch = /^http_(\d{3})$/.exec(raw);
      const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
      let category: "http_4xx" | "http_5xx" | "network" | "other";
      if (httpStatus !== null) {
        category =
          httpStatus >= 500
            ? "http_5xx"
            : httpStatus >= 400
              ? "http_4xx"
              : "other";
      } else if (
        err instanceof TypeError ||
        /networkerror|failed to fetch/i.test(raw)
      ) {
        // fetch() rejects with a TypeError on network failure; some
        // browsers surface a localised message instead, so we also
        // match the canonical text.
        category = "network";
      } else {
        category = "other";
      }
      track("fitter_lead_submit_failed", {
        category,
        httpStatus,
        errorCode: raw.slice(0, 64),
      });
      // Preserve the legacy console.warn for live-debugging — ops
      // gets the metric, devs hunting a regression still see the
      // raw error in the browser console.
      console.warn("fitter-lead submit failed (continuing)", err);
    });
    setLocation("/capture");
  };

  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-shimmer-in">
      {!storagePersisted && !storageNoticeDismissed && (
        // Heads-up when sessionStorage is unusable (some private-
        // browsing modes / fully-blocked site data). The fitter still
        // works — state lives in memory — but a refresh restarts the
        // flow, which would otherwise feel like a silent data loss.
        <div
          role="status"
          className="mb-6 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="fitter-storage-notice"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p className="flex-1">
            Your browser is blocking temporary storage (often private browsing).
            You can still complete the fitting, but refreshing or closing this
            tab will restart it from the beginning.
          </p>
          <button
            type="button"
            onClick={() => setStorageNoticeDismissed(true)}
            aria-label="Dismiss storage notice"
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Got it
          </button>
        </div>
      )}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto mb-2">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <CardTitle className="text-display text-3xl md:text-4xl text-center font-bold tracking-tight text-gradient-brand">
            Privacy & Consent
          </CardTitle>
          <CardDescription className="text-center text-lg max-w-xl mx-auto">
            At PennPaps, your privacy is our absolute priority. Before we begin,
            please review how PennPaps protects your data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex gap-4 p-5 rounded-xl glass-panel">
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                <ServerOff className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 tracking-tight">
                  On-Device Processing
                </h3>
                <p className="text-sm text-muted-foreground">
                  All camera processing happens entirely on your device. Images
                  and video <strong>never</strong> leave your phone or computer.
                </p>
              </div>
            </div>

            <div className="flex gap-4 p-5 rounded-xl glass-panel">
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <Camera className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 tracking-tight">
                  No Image Storage
                </h3>
                <p className="text-sm text-muted-foreground">
                  The capture is held temporarily in memory just long enough to
                  extract measurements, then immediately discarded.
                </p>
              </div>
            </div>
          </div>

          {/*
            Order-data storage disclosure — required reading before patients
            commit. The image / measurement story above is unchanged (still
            on-device only). Order details are different: once a patient
            chooses to place an order, name/DOB/address/insurance/Rx ARE
            stored on PennPaps's servers so staff can fulfill it. Be explicit so
            consent is informed.
          */}
          <div className="flex gap-4 p-5 rounded-xl glass-panel border border-[hsl(var(--penn-gold)/0.4)]">
            <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold mb-1 tracking-tight">
                If You Place an Order
              </h3>
              <p className="text-sm text-muted-foreground">
                Camera measurements stay on your device.{" "}
                <strong>However, when you submit an order</strong>, the contact,
                shipping, insurance, and prescription details you enter are
                stored in PennPaps's secure database so our fulfillment team can
                ship your mask and bill your insurance. You'll re-confirm this
                at checkout. See our{" "}
                <Link href="/privacy" className="underline hover:text-primary">
                  Privacy Policy
                </Link>{" "}
                for full details.
              </p>
            </div>
          </div>

          <div
            className="rounded-xl p-5 text-sm space-y-4 border border-[hsl(var(--penn-navy)/0.18)] relative overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--penn-navy) / 0.05) 0%, hsl(var(--penn-mist) / 0.5) 100%)",
            }}
          >
            <div className="flex items-start gap-3 relative">
              <AlertCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-3">
                <p className="font-medium text-primary tracking-tight">
                  Biometric Information Privacy Disclosure
                </p>
                <p className="text-foreground/80 leading-relaxed">
                  To provide mask recommendations, PennPaps uses facial
                  recognition technology to extract numerical measurements (such
                  as the distance between your nose and chin).
                  <strong>
                    {" "}
                    No images or biometric identifiers are stored, recorded, or
                    transmitted to PennPaps or any third party.
                  </strong>
                </p>
                <p className="text-foreground/80 leading-relaxed">
                  Only the extracted numerical values (in millimeters) and your
                  questionnaire answers are sent securely to the PennPaps
                  recommendation engine.
                </p>
              </div>
            </div>
          </div>

          <div
            className="flex flex-row items-start space-x-3 space-y-0 rounded-xl border border-border/60 glass-panel p-4 hover:border-primary/40 transition-colors cursor-pointer"
            onClick={() => setAgreed(!agreed)}
          >
            <Checkbox
              id="consent"
              checked={agreed}
              onCheckedChange={(checked) => setAgreed(checked as boolean)}
            />
            <div className="space-y-1 leading-none">
              <label htmlFor="consent" className="font-medium cursor-pointer">
                I understand and consent to the use of my camera for on-device
                measurement
              </label>
              <p className="text-sm text-muted-foreground">
                I acknowledge that no images will be saved or uploaded.
              </p>
            </div>
          </div>

          {/*
            Email gate. The fitter walks the patient through ~five
            screens of measurement + recommendation work; without an
            email on file we can't follow up with the mask suggestion,
            answer questions, or remind them to finish if they drop
            off. We collect both fields here so the gate is explicit
            (and the order page later can pre-fill from this value).
          */}
          <div className="space-y-3 rounded-xl border border-border/60 glass-panel p-5">
            <div className="flex items-center gap-3">
              <div className="shrink-0 h-9 w-9 rounded-lg icon-halo-navy flex items-center justify-center">
                <Mail className="w-4 h-4" />
              </div>
              <Label
                htmlFor="fitter-email"
                className="font-medium tracking-tight"
              >
                Email address
              </Label>
            </div>
            <Input
              id="fitter-email"
              data-testid="input-fitter-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email.length > 0 && !emailValid}
              aria-describedby={
                email.length > 0 && !emailValid
                  ? "fitter-email-error"
                  : "fitter-email-help"
              }
            />
            {email.length > 0 && !emailValid && (
              <p
                id="fitter-email-error"
                role="alert"
                className="text-sm font-medium text-destructive"
              >
                Enter a valid email address (e.g. you@example.com).
              </p>
            )}
            <p id="fitter-email-help" className="text-sm text-muted-foreground">
              We need an email on file so we can send you the mask
              recommendation and any follow-up about your order.
            </p>
            <div
              className="flex flex-row items-start space-x-3 space-y-0 pt-2 cursor-pointer"
              onClick={() => setEmailOptIn(!emailOptIn)}
            >
              <Checkbox
                id="email-consent"
                checked={emailOptIn}
                onCheckedChange={(checked) => setEmailOptIn(checked as boolean)}
              />
              <div className="space-y-1 leading-none">
                <label
                  htmlFor="email-consent"
                  className="font-medium cursor-pointer"
                >
                  I agree to receive emails from PennPaps
                </label>
                <p className="text-sm text-muted-foreground">
                  Mask recommendation, fitting follow-ups, and product news. You
                  can unsubscribe at any time.
                </p>
              </div>
            </div>

            {/*
              Optional phone + SMS opt-in. Phone is the single biggest
              top-of-funnel channel uplift we have access to (SMS open
              rates are 4-5× email across every demographic). We keep
              both fields fully optional — the consent gate above
              only requires email — so adding the field can't make
              consent strictly harder for the patient.
            */}
            <div className="space-y-3 pt-4 border-t border-border/40">
              <div className="flex items-center gap-2">
                <div className="shrink-0 h-8 w-8 rounded-lg icon-halo-navy flex items-center justify-center">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <Label
                  htmlFor="fitter-phone"
                  className="font-medium tracking-tight"
                >
                  Phone number{" "}
                  <span className="text-muted-foreground font-normal text-sm">
                    (optional)
                  </span>
                </Label>
              </div>
              <Input
                id="fitter-phone"
                data-testid="input-fitter-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(555) 123-4567"
                value={phone}
                onChange={(e) => setPhone(formatUsPhone(e.target.value))}
                aria-invalid={phoneFilled && !phoneValid}
                aria-describedby={
                  phoneFilled && !phoneValid
                    ? "fitter-phone-error"
                    : "fitter-phone-help"
                }
              />
              {phoneFilled && !phoneValid && (
                <p
                  id="fitter-phone-error"
                  role="alert"
                  className="text-sm font-medium text-destructive"
                >
                  Enter a 10-digit US phone number, or clear the field to skip.
                </p>
              )}
              <p
                id="fitter-phone-help"
                className="text-sm text-muted-foreground"
              >
                We&apos;ll only text if you opt in below. Useful for shipment
                updates and a faster way to reach our team than email.
              </p>
              <div
                className={`flex flex-row items-start space-x-3 space-y-0 pt-1 ${
                  phoneFilled && phoneValid
                    ? "cursor-pointer"
                    : "cursor-not-allowed opacity-60"
                }`}
                onClick={() => {
                  if (phoneFilled && phoneValid) setSmsOptIn(!smsOptIn);
                }}
              >
                <Checkbox
                  id="sms-consent"
                  checked={smsOptIn && phoneFilled && phoneValid}
                  disabled={!phoneFilled || !phoneValid}
                  onCheckedChange={(checked) => setSmsOptIn(checked as boolean)}
                />
                <div className="space-y-1 leading-none">
                  <label
                    htmlFor="sms-consent"
                    className="font-medium cursor-pointer"
                  >
                    I agree to receive text messages from PennPaps
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Order shipped &amp; delivered notifications, fitting
                    follow-ups. Msg &amp; data rates may apply. Reply STOP to
                    unsubscribe.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-between border-t border-border/40 p-6">
          <Link href="/">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button
            onClick={handleContinue}
            disabled={!canContinue}
            data-testid="button-continue-to-camera"
            className="px-8 btn-primary-glow disabled:shadow-none rounded-full"
          >
            I Consent, Continue to Camera
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
