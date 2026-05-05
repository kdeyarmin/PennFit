// Customer-facing product Q&A panel (Phase A.5 / feature #24
// extension). Renders below the existing reviews section on
// product detail. Shoppers read peer Q&A then submit their own;
// CSRs answer via the admin moderation queue.
//
// Why a separate panel from reviews: reviews are about the
// product (rated 1..5, single per buyer); questions are about
// shopper intent ("does this fit?"). Mixing them would dilute
// both.

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { HelpCircle, MessageSquare, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SignedIn } from "@/lib/identity";
import {
  fetchProductQuestions,
  submitProductQuestion,
  type ShopProductQuestion,
} from "@/lib/product-questions-api";

interface Props {
  productId: string;
}

const MIN_BODY = 10;
const MAX_BODY = 1000;

export function ProductQuestionsSection({ productId }: Props) {
  const [questions, setQuestions] = useState<ShopProductQuestion[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQuestions(null);
    setLoadError(null);
    void (async () => {
      try {
        const r = await fetchProductQuestions(productId);
        if (!cancelled) setQuestions(r.questions);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  return (
    <section
      className="mt-12 max-w-3xl mx-auto"
      data-testid="product-questions-section"
    >
      <header className="mb-4 flex items-center gap-2">
        <HelpCircle className="w-5 h-5 text-[hsl(var(--penn-navy))]" />
        <h2 className="text-xl font-semibold tracking-tight">
          Questions &amp; answers
        </h2>
      </header>
      <p className="text-sm text-muted-foreground mb-6">
        Real questions from shoppers, answered by our customer-service team.
        Don&apos;t see your question? Ask one — we typically reply within a
        business day.
      </p>

      <SignedIn fallback={<SignedOutAskPrompt />}>
        <AskForm productId={productId} />
      </SignedIn>

      {loadError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          We couldn&apos;t load questions right now: {loadError}
        </div>
      )}

      {questions === null && !loadError ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading questions…
        </div>
      ) : questions && questions.length === 0 ? (
        <div
          className="rounded-xl border border-border bg-background/60 p-4 text-sm text-muted-foreground"
          data-testid="product-questions-empty"
        >
          No questions yet on this product.
        </div>
      ) : questions ? (
        <ul className="space-y-4" data-testid="product-questions-list">
          {questions.map((q) => (
            <QnaItem key={q.id} q={q} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function QnaItem({ q }: { q: ShopProductQuestion }) {
  return (
    <li className="rounded-xl border border-border bg-background/70 p-4">
      <div className="flex items-start gap-3">
        <span className="h-7 w-7 rounded-full bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center shrink-0">
          <HelpCircle className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground whitespace-pre-wrap break-words">
            {q.questionBody}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Asked by {q.askerDisplayName} ·{" "}
            {new Date(q.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
      <div className="mt-3 ml-10 rounded-lg bg-[hsl(var(--penn-gold)/0.08)] border border-[hsl(var(--penn-gold)/0.30)] p-3">
        <div className="flex items-start gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep,_var(--penn-navy)))] mt-1 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[hsl(var(--penn-navy))] mb-1">
              PennPaps customer service
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap break-words">
              {q.answerBody}
            </p>
            {q.answeredAt && (
              <p className="text-[11px] text-muted-foreground mt-1">
                {new Date(q.answeredAt).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function SignedOutAskPrompt() {
  return (
    <div
      className="rounded-xl border border-border bg-background/60 p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between"
      data-testid="product-questions-signin"
    >
      <p className="text-sm text-muted-foreground">
        Sign in to ask a question — we&apos;ll email you when our team replies.
      </p>
      <Link href="/sign-in">
        <Button size="sm" variant="outline">
          Sign in to ask
        </Button>
      </Link>
    </div>
  );
}

function AskForm({ productId }: { productId: string }) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const trimmedLen = body.trim().length;
  const tooShort = trimmedLen > 0 && trimmedLen < MIN_BODY;
  const tooLong = trimmedLen > MAX_BODY;
  const canSubmit = trimmedLen >= MIN_BODY && !tooLong && !submitting;

  if (submitted) {
    return (
      <div
        className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 mb-6"
        data-testid="product-questions-submitted"
      >
        Thanks — your question is in our moderation queue. We&apos;ll publish it
        here with the answer once a CSR replies.
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        submitProductQuestion(productId, body.trim())
          .then(() => {
            setBody("");
            setSubmitted(true);
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setSubmitting(false));
      }}
      className="rounded-xl border border-border bg-background/60 p-4 mb-6 space-y-2"
      data-testid="product-questions-form"
    >
      <label
        htmlFor="product-question-body"
        className="text-xs font-semibold text-[hsl(var(--penn-navy))] block"
      >
        Ask a question about this product
      </label>
      <textarea
        id="product-question-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={MAX_BODY + 200}
        placeholder="e.g. Will this cushion seal at 12 cm of pressure?"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-sans"
        disabled={submitting}
        data-testid="product-questions-body"
      />
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <span
          className="text-[11px] text-muted-foreground"
          data-testid="product-questions-counter"
        >
          {trimmedLen}/{MAX_BODY}
          {tooShort && ` · ${MIN_BODY - trimmedLen} more characters needed`}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit}
          data-testid="product-questions-submit"
        >
          {submitting ? "Submitting…" : "Ask"}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
