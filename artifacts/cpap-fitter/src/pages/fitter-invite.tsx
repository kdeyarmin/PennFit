// /fitter-invite — landing page for a staff-initiated AI mask-fitter
// invite link (`/fitter-invite?t=<signed-token>`).
//
// Flow:
//   1. Resolve the signed token (server marks the invite "opened" and
//      returns the recipient's email/name for prefill).
//   2. Stash the token in the fitter store so /results can transmit
//      the completed fitting back to Penn Home Medical Supply and attach it to the
//      patient's chart.
//   3. Drop the patient straight into the fitter — to /capture when we
//      already have their email (invited as a known patient), or to
//      /consent to collect one first (SMS-only prospect).
//
// Invalid / expired / revoked links get a friendly dead-end rather
// than a stack trace.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, ScanFace, ShieldCheck } from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";
import { BrandName } from "@/components/company-contact";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { resolveFitterInvite } from "@/lib/shop-api";
import { track } from "@/lib/track";

type State =
  | { kind: "loading" }
  | { kind: "ready"; email: string | null; name: string | null }
  | { kind: "invalid"; reason: string };

function getTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("t");
  return t && t.length > 0 ? t : null;
}

const REASON_COPY: Record<string, string> = {
  expired: "This invite link has expired. Ask your DME company to resend it.",
  revoked:
    "This invite link is no longer active. Ask your DME company for a new one.",
  not_found: "We couldn't find this invite. Ask your DME company to resend it.",
  malformed:
    "This link looks incomplete. Try opening it again, or ask for a fresh link.",
  bad_signature:
    "This link looks incomplete. Try opening it again, or ask for a fresh link.",
  unavailable:
    "This invite isn't available right now. Ask your DME company for a new one.",
  missing:
    "This page needs an invite link. Ask your local DME company (your CPAP supplier) to send you one.",
  error:
    "Something went wrong opening your invite. Please try again in a moment.",
};

// The "missing" reason is what an uninvited visitor sees when a fitter
// route (e.g. /consent) bounces them here because they have no invite
// token. It isn't an error — it's the expected gate — so render it as
// a friendly "invitation required" explainer rather than a red alert.
const MISSING_REASON = "missing";

export function FitterInvite() {
  useDocumentTitle("Your mask-fitting invite");
  const [, setLocation] = useLocation();
  const {
    inviteToken: storedInviteToken,
    reset,
    setEmailConsent,
    setInviteToken,
    setFitProfileV2,
    setMultiframeCapture,
    setEntryPoint,
  } = useFitterStore();
  const [state, setState] = useState<State>({ kind: "loading" });
  // The store setters in the deps get a fresh identity whenever the
  // provider re-renders — which the setInviteToken call below itself
  // causes — so without this guard the effect re-runs and the invite is
  // resolved (and tracked) twice per landing.
  const resolvedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const token = getTokenFromUrl();
    if (!token) {
      setState({ kind: "invalid", reason: "missing" });
      return;
    }
    if (resolvedTokenRef.current === token) return;
    resolvedTokenRef.current = token;
    let cancelled = false;
    track("fitter_invite_opened");
    resolveFitterInvite(token)
      .then((res) => {
        if (cancelled) return;
        if (!res.valid) {
          setState({ kind: "invalid", reason: res.reason ?? "error" });
          return;
        }
        // A DIFFERENT invite than the one this tab was fitting: wipe the
        // previous fitting entirely — measurements, answers, chosen mask,
        // email, entry channel — before stashing the new context. The
        // store persists per tab (sessionStorage), so on a shared device
        // (a clinic kiosk, a family phone) the previous patient's face
        // measurements and email would otherwise carry into the next
        // patient's fitting and could be transmitted to THEIR chart.
        // Same-token re-landings (a refresh mid-flow) keep everything.
        if (storedInviteToken !== null && storedInviteToken !== token) {
          reset();
        }
        // Stash the token now so it survives the multi-step flow even
        // if the patient navigates away before clicking start.
        setInviteToken(token);
        // Which questionnaire and capture mode this tenant runs. Decided
        // here because /capture and /questionnaire render long before
        // /results ever probes the clinical route.
        setFitProfileV2(Boolean(res.fitProfileV2));
        setMultiframeCapture(Boolean(res.multiframeCapture));
        // Re-anchor the entry channel to THIS invite's URL. Without it, a
        // fresh invite opened in the same tab (no `entry` param) inherits
        // whatever channel the previous fitting persisted — an ordinary
        // remote invite after a kiosk or refit-campaign fitting would be
        // recorded under the stale channel.
        const entryRaw = new URLSearchParams(window.location.search).get(
          "entry",
        );
        setEntryPoint(
          entryRaw === "in_office" ||
            entryRaw === "kiosk_qr" ||
            entryRaw === "remote_link" ||
            entryRaw === "refit_campaign"
            ? entryRaw
            : null,
        );
        setState({
          kind: "ready",
          email: res.email ?? null,
          name: res.name ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "invalid", reason: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [
    storedInviteToken,
    reset,
    setInviteToken,
    setFitProfileV2,
    setMultiframeCapture,
    setEntryPoint,
  ]);

  const handleStart = (email: string | null) => {
    track("fitter_invite_started");
    if (email) {
      // Known patient — prefill the email gate so /consent only asks for
      // the checkbox. Marketing consent stays FALSE here: granting it
      // for them would auto-enroll every invited patient in the nurture
      // campaign without consent; the optional opt-in is theirs to check
      // on /consent.
      setEmailConsent(email, false);
    }
    // EVERY invitee goes through /consent — including known-email ones.
    // The biometric-information disclosure and the affirmative
    // camera-consent checkbox live ONLY there; the old known-email
    // shortcut to /capture rested on a (since-deleted) comment claiming
    // the disclosure "still renders in-flow", which was never true, so
    // invited patients reached getUserMedia without ever being shown the
    // disclosure or recording a consent_given.
    setLocation("/consent");
  };

  const firstName =
    state.kind === "ready" && state.name ? state.name.split(/\s+/)[0] : null;

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-8 space-y-6">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto">
            <ScanFace className="w-7 h-7" />
          </div>

          {state.kind === "loading" && (
            <div className="space-y-4">
              <Skeleton className="h-8 w-2/3 mx-auto rounded-lg" />
              <Skeleton className="h-5 w-full rounded-lg" />
              <Skeleton className="h-5 w-3/4 mx-auto rounded-lg" />
              <Skeleton className="h-11 w-48 mx-auto rounded-full" />
            </div>
          )}

          {state.kind === "invalid" && state.reason === MISSING_REASON && (
            <div className="text-center space-y-5">
              <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
                Invitation required
              </h1>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto">
                The virtual mask fitter is available by invitation only. To use
                it, ask your local DME company (your CPAP supplier) to send you
                an invite link or code by text or email. Open that link on your
                phone or computer to get started.
              </p>
              <div className="flex items-start gap-3 text-left rounded-xl glass-panel p-4 max-w-xl mx-auto">
                <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Already have a link from your provider? Open it directly — it
                  carries the invite that unlocks the fitter. Your camera images
                  never leave your device; only numeric measurements are shared.
                </p>
              </div>
            </div>
          )}

          {state.kind === "invalid" && state.reason !== MISSING_REASON && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>This invite link isn&apos;t usable</AlertTitle>
                <AlertDescription>
                  {REASON_COPY[state.reason] ?? REASON_COPY.error}
                </AlertDescription>
              </Alert>
              {/* "error" is a transient failure (network blip, server
                  hiccup) — the token is still in the URL, so a retry can
                  simply reload. Without this the patient's only option
                  was to know to refresh the page themselves. */}
              {state.reason === "error" && (
                <div className="text-center">
                  <Button
                    variant="outline"
                    className="rounded-full glass-panel border-0 px-6"
                    onClick={() => window.location.reload()}
                    data-testid="fitter-invite-retry"
                  >
                    Try again
                  </Button>
                </div>
              )}
            </div>
          )}

          {state.kind === "ready" && (
            <div className="text-center space-y-5">
              <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
                {firstName ? `Welcome, ${firstName}!` : "You're invited"}
              </h1>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto">
                Your care team at{" "}
                <strong>
                  <BrandName />
                </strong>{" "}
                invited you to find your best-fitting CPAP mask. It takes about
                two minutes using your phone or computer camera.
              </p>
              <div className="flex items-start gap-3 text-left rounded-xl glass-panel p-4 max-w-xl mx-auto">
                <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Your camera images never leave your device — only the numeric
                  measurements are shared with your care team so they can follow
                  up on your fit.
                </p>
              </div>
              <Button
                size="lg"
                className="px-8 btn-primary-glow rounded-full"
                onClick={() => handleStart(state.email)}
                data-testid="button-start-invited-fitting"
              >
                Start my mask fitting
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
