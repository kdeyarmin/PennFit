// /mask-fit — landing page for the post-delivery mask-fit micro-survey
// link in our delivery-followup email (RT #22a).
//
// The email carries three buttons (Good fit / Leaking / Uncomfortable),
// each linking to /mask-fit?orderId=&fit=&t=, where `t` is the
// HMAC-signed token binding (orderId, fit) to a 30-day expiry. On mount
// we POST the token to /resupply-api/shop/orders/mask-fit, which verifies
// the signature server-side and records the outcome. We then invite an
// optional comment. No login — the signed token is the auth.

import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Wind } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { csrfHeader } from "@/lib/csrf";

function readSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

const OUTCOMES = ["good", "leaking", "uncomfortable"] as const;
type Outcome = (typeof OUTCOMES)[number];

export function MaskFitLanding() {
  useDocumentTitle("Thanks for the feedback — PennPaps");
  const [, setLocation] = useLocation();
  const [token] = useState(() => readSearchParam("t") ?? "");
  const [fit] = useState<Outcome | null>(() => {
    const raw = readSearchParam("fit");
    return raw && (OUTCOMES as readonly string[]).includes(raw)
      ? (raw as Outcome)
      : null;
  });
  const [submitState, setSubmitState] = useState<"submitting" | "ok" | "error">(
    "submitting",
  );
  const [comment, setComment] = useState("");
  const [commentState, setCommentState] = useState<
    "idle" | "submitting" | "ok" | "error"
  >("idle");

  useEffect(() => {
    let cancelled = false;
    if (!token || fit === null) {
      setSubmitState("error");
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const res = await fetch("/resupply-api/shop/orders/mask-fit", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...csrfHeader(),
          },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        setSubmitState(res.ok ? "ok" : "error");
      } catch {
        if (!cancelled) setSubmitState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, fit]);

  async function handleSubmitComment() {
    if (!token || !comment.trim()) return;
    setCommentState("submitting");
    try {
      const res = await fetch("/resupply-api/shop/orders/mask-fit", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...csrfHeader(),
        },
        body: JSON.stringify({ token, comment: comment.trim() }),
      });
      setCommentState(res.ok ? "ok" : "error");
    } catch {
      setCommentState("error");
    }
  }

  const headline =
    fit === "good"
      ? "Great — glad it's sealing well"
      : fit === "leaking"
        ? "Thanks — let's stop that leak"
        : fit === "uncomfortable"
          ? "Sorry it's uncomfortable"
          : "Thanks for the feedback";

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 space-y-6 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {submitState === "ok" ? (
              <CheckCircle2 className="w-6 h-6 text-[hsl(var(--penn-gold))]" />
            ) : (
              <Wind className="w-6 h-6 text-[hsl(var(--penn-gold))]" />
            )}
            {headline}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {submitState === "submitting" && (
            <p className="text-sm text-muted-foreground">
              Recording your feedback…
            </p>
          )}
          {submitState === "error" && (
            <p
              className="text-sm text-destructive"
              data-testid="mask-fit-error"
            >
              We couldn&apos;t save your feedback from this link. It may have
              expired (links work for 30 days). Please reply to the email
              directly — we read every one.
            </p>
          )}
          {submitState === "ok" && (
            <>
              <p
                className="text-base text-muted-foreground leading-relaxed"
                data-testid="mask-fit-ok"
              >
                {fit === "good"
                  ? "Thanks for letting us know! "
                  : "Thanks — a respiratory therapist will look at this. "}
                Anything else you want to tell us about the fit? Optional, but
                it helps us help you.
              </p>
              {commentState !== "ok" ? (
                <div className="space-y-3">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="Where is it leaking / uncomfortable?"
                    className="w-full px-3 py-2 rounded-md border text-sm bg-background"
                    data-testid="mask-fit-comment"
                  />
                  {commentState === "error" && (
                    <p className="text-sm text-destructive">
                      Couldn&apos;t save your comment. Please try again.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSubmitComment}
                      disabled={
                        !comment.trim() || commentState === "submitting"
                      }
                      data-testid="mask-fit-comment-submit"
                      className="rounded-full"
                    >
                      {commentState === "submitting"
                        ? "Sending…"
                        : "Send comment"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setLocation("/")}
                      className="rounded-full"
                    >
                      No thanks
                    </Button>
                  </div>
                </div>
              ) : (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="mask-fit-comment-ok"
                >
                  Got it — thank you. We&apos;ll follow up if it needs
                  attention.
                </p>
              )}
              <div className="pt-2">
                <Link href="/" className="text-sm text-primary hover:underline">
                  Back to PennPaps
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
