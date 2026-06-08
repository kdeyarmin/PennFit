// /fitter-invite — landing page for a staff-initiated AI mask-fitter
// invite link (`/fitter-invite?t=<signed-token>`).
//
// Flow:
//   1. Resolve the signed token (server marks the invite "opened" and
//      returns the recipient's email/name for prefill).
//   2. Stash the token in the fitter store so /results can transmit
//      the completed fitting back to PennPaps and attach it to the
//      patient's chart.
//   3. Drop the patient straight into the fitter — to /capture when we
//      already have their email (invited as a known patient), or to
//      /consent to collect one first (SMS-only prospect).
//
// Invalid / expired / revoked links get a friendly dead-end rather
// than a stack trace.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, ScanFace, ShieldCheck } from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";
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
  expired:
    "This invite link has expired. Ask your PennPaps contact to resend it.",
  revoked:
    "This invite link is no longer active. Ask your PennPaps contact for a new one.",
  not_found:
    "We couldn't find this invite. Ask your PennPaps contact to resend it.",
  malformed:
    "This link looks incomplete. Try opening it again, or ask for a fresh link.",
  bad_signature:
    "This link looks incomplete. Try opening it again, or ask for a fresh link.",
  unavailable:
    "This invite isn't available right now. Ask your PennPaps contact for a new one.",
  missing:
    "This page needs an invite link. Ask your PennPaps contact to send you one.",
  error:
    "Something went wrong opening your invite. Please try again in a moment.",
};

export function FitterInvite() {
  useDocumentTitle("Your mask-fitting invite");
  const [, setLocation] = useLocation();
  const { setEmailConsent, setInviteToken } = useFitterStore();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const token = getTokenFromUrl();
    if (!token) {
      setState({ kind: "invalid", reason: "missing" });
      return;
    }
    let cancelled = false;
    track("fitter_invite_opened");
    resolveFitterInvite(token)
      .then((res) => {
        if (cancelled) return;
        if (!res.valid) {
          setState({ kind: "invalid", reason: res.reason ?? "error" });
          return;
        }
        // Stash the token now so it survives the multi-step flow even
        // if the patient navigates away before clicking start.
        setInviteToken(token);
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
  }, [setInviteToken]);

  const handleStart = (email: string | null) => {
    track("fitter_invite_started");
    if (email) {
      // Known patient — prefill the email gate and head straight into
      // the camera step. Consent flag (true) just satisfies the flow
      // gate; the privacy/biometric disclosure still renders in-flow.
      setEmailConsent(email, true);
      setLocation("/capture");
    } else {
      // No email on file (SMS-only prospect) — collect one on /consent
      // first. The invite token is already stashed.
      setLocation("/consent");
    }
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

          {state.kind === "invalid" && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>This invite link isn't usable</AlertTitle>
              <AlertDescription>
                {REASON_COPY[state.reason] ?? REASON_COPY.error}
              </AlertDescription>
            </Alert>
          )}

          {state.kind === "ready" && (
            <div className="text-center space-y-5">
              <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
                {firstName ? `Welcome, ${firstName}!` : "You're invited"}
              </h1>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto">
                Your care team at <strong>PennPaps</strong> invited you to find
                your best-fitting CPAP mask. It takes about two minutes using
                your phone or computer camera.
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
