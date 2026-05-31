// /nps — landing page for the post-delivery follow-up NPS rating
// link in our email.
//
// Flow
// ----
// The email's 0-10 buttons each link to /nps?orderId=&score=&t=,
// where `t` is the HMAC-signed token that binds (orderId, score)
// to a 30-day expiry. On mount we POST the token to
// /api/shop/orders/nps, which verifies the signature server-side
// and persists the rating. Then we invite the patient to add a
// short comment if they want — a second POST with the same token
// upserts an additional comment-only row (the schema allows
// multiple rows per order so the patient can change their mind).
//
// No login required — the signed token is the auth.

import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Star } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { csrfHeader } from "@/lib/csrf";

function readSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

export function NpsLanding() {
  useDocumentTitle("Thanks for your rating — PennPaps");
  const [, setLocation] = useLocation();
  const [token] = useState(() => readSearchParam("t") ?? "");
  const [score] = useState(() => {
    const raw = readSearchParam("score");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
  });
  const [submitState, setSubmitState] = useState<"submitting" | "ok" | "error">(
    "submitting",
  );
  const [comment, setComment] = useState("");
  const [commentState, setCommentState] = useState<
    "idle" | "submitting" | "ok" | "error"
  >("idle");

  // Fire the rating on mount. The patient already chose the score in
  // the email; landing on this page is implicit confirmation.
  useEffect(() => {
    let cancelled = false;
    if (!token || score === null) {
      setSubmitState("error");
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const res = await fetch("/resupply-api/shop/orders/nps", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...csrfHeader(),
          },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setSubmitState("error");
          return;
        }
        setSubmitState("ok");
      } catch {
        if (!cancelled) setSubmitState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, score]);

  async function handleSubmitComment() {
    if (!token || !comment.trim()) return;
    setCommentState("submitting");
    try {
      const res = await fetch("/resupply-api/shop/orders/nps", {
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

  const tone =
    score === null
      ? "neutral"
      : score >= 9
        ? "promoter"
        : score >= 7
          ? "passive"
          : "detractor";
  const headline =
    tone === "promoter"
      ? "Glad you'd recommend us"
      : tone === "passive"
        ? "Thanks for the rating"
        : tone === "detractor"
          ? "Sorry it isn't going well"
          : "Thanks";

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 space-y-6 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {submitState === "ok" ? (
              <CheckCircle2 className="w-6 h-6 text-[hsl(var(--penn-gold))]" />
            ) : (
              <Star className="w-6 h-6 text-[hsl(var(--penn-gold))]" />
            )}
            {headline}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {submitState === "submitting" && (
            <p className="text-sm text-muted-foreground">
              Recording your rating…
            </p>
          )}
          {submitState === "error" && (
            <div className="space-y-2">
              <p className="text-sm text-destructive" data-testid="nps-error">
                We couldn&apos;t save your rating from this link. It may have
                expired (links work for 30 days). Please reply to the email
                directly — we read every one.
              </p>
            </div>
          )}
          {submitState === "ok" && (
            <>
              <p
                className="text-base text-muted-foreground leading-relaxed"
                data-testid="nps-ok"
              >
                We recorded your rating of <strong>{score}/10</strong>. Want to
                tell us anything else? Optional but appreciated — every comment
                lands in front of a real human.
              </p>
              {commentState !== "ok" ? (
                <div className="space-y-3">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="What worked? What didn't?"
                    className="w-full px-3 py-2 rounded-md border text-sm bg-background"
                    data-testid="nps-comment"
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
                      data-testid="nps-comment-submit"
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
                  data-testid="nps-comment-ok"
                >
                  Got it — thank you. We&apos;ll be in touch if anything needs a
                  follow-up.
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
