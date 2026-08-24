// The v2 Patient Fit Profile questionnaire — the chaptered, branching
// flow `lib/fit-profile.ts` was built for.
//
// Rendered by /questionnaire when the tenant's invite resolved with
// `fitter.fit_profile_v2` on; the legacy 11-question flow stays the
// default. Two invariants keep every downstream consumer working:
//
//   * Answers land in the store's `fitAnswers` (the v2 shape), AND the
//     legacy `answers` are re-derived from them on completion via
//     `toLegacyAnswers` — so the /api/recommend fallback, the invite
//     completion payload, and the campaign ping see the same 11 fields
//     they always have.
//   * A skipped or "I'm not sure" answer stays `null`, never a default —
//     the engine must be able to tell "declined to answer" from "no".
//
// The safety chapter renders on /results from the server's
// version-controlled question set, not here — a manufacturer revising a
// warning must not require a deploy.

import React, { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, CheckCircle2, Lightbulb } from "lucide-react";
import type { QuestionnaireAnswers } from "@workspace/api-client-react/storefront";
import {
  FIT_QUESTIONS,
  chapterProgress,
  nextQuestionIndex,
  overallProgress,
  previousQuestionIndex,
  pruneInapplicableAnswers,
  toLegacyAnswers,
  type AnswerValue,
  type FitAnswers,
  type FitQuestion,
} from "@/lib/fit-profile";

const PAGE_TITLE = "Your fit profile";

export function QuestionnaireV2({
  onReopenGate,
}: {
  /** Reopen the adult-or-child gate from the first question. See the
   *  note on `reopenGate` in questionnaire.tsx — a mis-tap there decides
   *  which masks are eligible and must stay correctable. */
  onReopenGate?: () => void;
}) {
  useDocumentTitle(PAGE_TITLE);
  const [, setLocation] = useLocation();
  const { fitAnswers, replaceFitAnswers, updateAnswers } = useFitterStore();
  const [currentIndex, setCurrentIndex] = useState(0);
  // Local scratch for the two answer kinds that need an explicit
  // Continue (multi-select and number entry).
  const [multiDraft, setMultiDraft] = useState<string[]>([]);
  const [numberDraft, setNumberDraft] = useState<string>("");

  const question = FIT_QUESTIONS[currentIndex]!;
  const progress = chapterProgress(currentIndex, fitAnswers);
  const overall = overallProgress(currentIndex, fitAnswers);

  // Re-seed the drafts when the question changes, so Back shows what was
  // previously chosen.
  useEffect(() => {
    const existing = fitAnswers[question.id];
    setMultiDraft(Array.isArray(existing) ? existing : []);
    setNumberDraft(typeof existing === "number" ? String(existing) : "");
    // The drafts belong to the question being shown, not to every answer
    // change while it is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const finish = (finalAnswers: FitAnswers) => {
    // Keep the legacy 11 answers in lockstep — every consumer that still
    // speaks v1 (the /api/recommend fallback, the invite completion
    // payload, the campaign ping) reads them from the store.
    updateAnswers(
      toLegacyAnswers(finalAnswers) as Partial<QuestionnaireAnswers>,
    );
    track("questionnaire_completed");
    setLocation("/results");
  };

  const commit = (value: AnswerValue) => {
    // Prune answers from branches this answer just closed — going Back
    // and switching a branching choice must not leave the old branch's
    // answers to reach the engine and the clinical record. REPLACE the
    // store (the merge updater can never delete a key).
    const merged = pruneInapplicableAnswers({
      ...fitAnswers,
      [question.id]: value,
    });
    replaceFitAnswers(merged);
    const next = nextQuestionIndex(currentIndex, merged);
    if (next === null) finish(merged);
    else setCurrentIndex(next);
  };

  const canGoBack =
    previousQuestionIndex(currentIndex, fitAnswers) !== null ||
    Boolean(onReopenGate);
  const handleBack = () => {
    const prev = previousQuestionIndex(currentIndex, fitAnswers);
    if (prev !== null) setCurrentIndex(prev);
    else onReopenGate?.();
  };

  // Keyboard navigation, mirroring the v1 flow: number keys pick the
  // matching option on single-choice kinds, ← / Backspace goes back.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "ArrowLeft" || e.key === "Backspace") {
        if (canGoBack) {
          e.preventDefault();
          handleBack();
        }
        return;
      }

      const n = Number.parseInt(e.key, 10);
      if (Number.isNaN(n) || n < 1) return;
      let choices: AnswerValue[] = [];
      if (question.kind === "boolean") {
        choices = question.allowUnsure ? [true, false, null] : [true, false];
      } else if (question.kind === "single") {
        choices = (question.options ?? []).map((o) => o.value);
        if (question.allowUnsure) choices.push(null);
      } else if (question.kind === "scale") {
        const min = question.min ?? 1;
        const max = question.max ?? 5;
        choices = Array.from({ length: max - min + 1 }, (_, i) => min + i);
        if (question.allowUnsure) choices.push(null);
      }
      if (n <= choices.length) {
        e.preventDefault();
        commit(choices[n - 1]!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-subscribed each question so the closure sees the live state;
    // the handlers are recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, fitAnswers]);

  const numberValid = (() => {
    if (numberDraft.trim() === "") return false;
    const n = Number(numberDraft);
    if (!Number.isFinite(n)) return false;
    if (question.min !== undefined && n < question.min) return false;
    if (question.max !== undefined && n > question.max) return false;
    return true;
  })();

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="mb-8 space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            disabled={!canGoBack}
            aria-label={
              previousQuestionIndex(currentIndex, fitAnswers) === null
                ? "Back to who this fitting is for"
                : "Previous question"
            }
            className="h-9 w-9 rounded-full glass-panel border-0 disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 flex items-baseline justify-between gap-3">
            <span
              className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75"
              data-testid="fit-profile-chapter"
            >
              {progress
                ? `${progress.chapter.title} · ${progress.chapterNumber}/${progress.totalChapters}`
                : "Fit profile"}
            </span>
            {progress && (
              <span className="text-xs font-mono text-muted-foreground tabular-nums">
                <span className="text-[hsl(var(--penn-gold))] font-bold">
                  {progress.indexInChapter + 1}
                </span>
                {" / "}
                {progress.chapterLength}
              </span>
            )}
          </div>
        </div>
        <Progress
          value={overall * 100}
          className="h-1.5"
          aria-label="Fit profile progress"
        />
        {progress && (
          <p className="text-xs text-muted-foreground">
            {progress.chapter.blurb}
          </p>
        )}
      </div>

      <div
        className="animate-in slide-in-from-right-4 fade-in duration-300"
        key={currentIndex}
      >
        <Card className="border-0 glass-card rounded-2xl min-h-[420px] flex flex-col">
          <CardHeader className="pb-4">
            <CardTitle
              id={`fit-question-${question.id}-label`}
              className="text-display text-2xl md:text-3xl leading-tight tracking-tight font-bold"
            >
              {question.question}
            </CardTitle>
            {question.help && (
              <div className="mt-4 flex items-start gap-2.5 text-xs rounded-xl callout-gold p-3">
                <Lightbulb className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))] shrink-0" />
                <span className="text-foreground/85 leading-relaxed">
                  {question.help}
                </span>
              </div>
            )}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-center gap-4">
            <QuestionBody
              question={question}
              answer={fitAnswers[question.id]}
              multiDraft={multiDraft}
              setMultiDraft={setMultiDraft}
              numberDraft={numberDraft}
              setNumberDraft={setNumberDraft}
              numberValid={numberValid}
              onCommit={commit}
            />
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 hidden text-center text-xs text-muted-foreground sm:block">
        Tip: press a number key (1, 2, 3…) to choose an answer, or ← to go back.
      </p>
    </div>
  );
}

function tileClass(selected: boolean): string {
  return `option-tile ${selected ? "option-tile-selected" : ""} py-4 px-5 text-left whitespace-normal rounded-xl text-foreground`;
}

function QuestionBody({
  question,
  answer,
  multiDraft,
  setMultiDraft,
  numberDraft,
  setNumberDraft,
  numberValid,
  onCommit,
}: {
  question: FitQuestion;
  answer: AnswerValue | undefined;
  multiDraft: string[];
  setMultiDraft: (next: string[]) => void;
  numberDraft: string;
  setNumberDraft: (next: string) => void;
  numberValid: boolean;
  onCommit: (value: AnswerValue) => void;
}) {
  const labelId = `fit-question-${question.id}-label`;

  if (question.kind === "boolean") {
    return (
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4"
      >
        <button
          type="button"
          role="radio"
          aria-checked={answer === true}
          className={`option-tile ${answer === true ? "option-tile-selected" : ""} h-20 text-lg font-semibold tracking-tight rounded-xl px-5 flex items-center justify-center text-foreground`}
          onClick={() => onCommit(true)}
          data-testid={`fit-${question.id}-yes`}
        >
          Yes
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={answer === false}
          className={`option-tile ${answer === false ? "option-tile-selected" : ""} h-20 text-lg font-semibold tracking-tight rounded-xl px-5 flex items-center justify-center text-foreground`}
          onClick={() => onCommit(false)}
          data-testid={`fit-${question.id}-no`}
        >
          No
        </button>
        {question.allowUnsure && (
          <button
            type="button"
            role="radio"
            aria-checked={answer === null}
            className={`option-tile ${answer === null ? "option-tile-selected" : ""} h-20 text-base font-medium tracking-tight rounded-xl px-4 flex items-center justify-center text-muted-foreground`}
            onClick={() => onCommit(null)}
            data-testid={`fit-${question.id}-unsure`}
          >
            I&apos;m not sure
          </button>
        )}
      </div>
    );
  }

  if (question.kind === "single") {
    return (
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex flex-col gap-3 mt-4"
      >
        {question.options?.map((opt) => {
          const selected = answer === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={tileClass(selected)}
              onClick={() => onCommit(opt.value)}
              data-testid={`fit-${question.id}-${opt.value}`}
            >
              <div className="flex items-start gap-3 w-full">
                <div className="shrink-0 mt-0.5">
                  {selected ? (
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30" />
                  )}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className="font-medium tracking-tight">
                    {opt.label}
                  </span>
                  {opt.sublabel && (
                    <span className="text-xs text-muted-foreground font-normal">
                      {opt.sublabel}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
        {question.allowUnsure && (
          <button
            type="button"
            role="radio"
            aria-checked={answer === null}
            className={`option-tile ${answer === null ? "option-tile-selected" : ""} py-3 px-5 text-left rounded-xl text-muted-foreground`}
            onClick={() => onCommit(null)}
            data-testid={`fit-${question.id}-unsure`}
          >
            I&apos;m not sure
          </button>
        )}
      </div>
    );
  }

  if (question.kind === "multi") {
    const toggle = (value: string) => {
      setMultiDraft(
        multiDraft.includes(value)
          ? multiDraft.filter((v) => v !== value)
          : [...multiDraft, value],
      );
    };
    return (
      <div className="flex flex-col gap-3 mt-4">
        <div
          role="group"
          aria-labelledby={labelId}
          className="flex flex-col gap-3"
        >
          {question.options?.map((opt) => {
            const selected = multiDraft.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                role="checkbox"
                aria-checked={selected}
                className={tileClass(selected)}
                onClick={() => toggle(opt.value)}
                data-testid={`fit-${question.id}-${opt.value}`}
              >
                <div className="flex items-start gap-3 w-full">
                  <div className="shrink-0 mt-0.5">
                    {selected ? (
                      <CheckCircle2 className="h-5 w-5 text-primary" />
                    ) : (
                      <div className="h-5 w-5 rounded border-2 border-muted-foreground/30" />
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span className="font-medium tracking-tight">
                      {opt.label}
                    </span>
                    {opt.sublabel && (
                      <span className="text-xs text-muted-foreground font-normal">
                        {opt.sublabel}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 mt-2">
          <Button
            disabled={multiDraft.length === 0}
            onClick={() => onCommit(multiDraft)}
            className="rounded-full btn-primary-glow px-8"
            data-testid={`fit-${question.id}-continue`}
          >
            Continue
          </Button>
          <Button
            variant="ghost"
            onClick={() => onCommit([])}
            className="rounded-full text-muted-foreground"
            data-testid={`fit-${question.id}-none`}
          >
            None of these
          </Button>
        </div>
      </div>
    );
  }

  if (question.kind === "number") {
    return (
      <div className="flex flex-col gap-4 mt-4">
        <div className="flex items-center gap-3">
          <input
            type="number"
            inputMode="decimal"
            min={question.min}
            max={question.max}
            value={numberDraft}
            onChange={(e) => setNumberDraft(e.target.value)}
            aria-labelledby={labelId}
            className="option-tile h-16 w-40 rounded-xl px-5 text-2xl font-semibold text-foreground text-center"
            data-testid={`fit-${question.id}-input`}
          />
          {question.unit && (
            <span className="text-lg text-muted-foreground">
              {question.unit}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={!numberValid}
            onClick={() => onCommit(Number(numberDraft))}
            className="rounded-full btn-primary-glow px-8"
            data-testid={`fit-${question.id}-continue`}
          >
            Continue
          </Button>
          {question.allowUnsure && (
            <Button
              variant="ghost"
              onClick={() => onCommit(null)}
              className="rounded-full text-muted-foreground"
              data-testid={`fit-${question.id}-unsure`}
            >
              I&apos;m not sure — skip
            </Button>
          )}
        </div>
      </div>
    );
  }

  // scale
  const min = question.min ?? 1;
  const max = question.max ?? 5;
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div className="flex flex-col gap-4 mt-4">
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-5 gap-2"
      >
        {values.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={answer === v}
            className={`option-tile ${answer === v ? "option-tile-selected" : ""} h-16 text-xl font-semibold rounded-xl flex items-center justify-center text-foreground`}
            onClick={() => onCommit(v)}
            data-testid={`fit-${question.id}-${v}`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground px-1">
        <span>Didn&apos;t work for me</span>
        <span>Worked great</span>
      </div>
      {question.allowUnsure && (
        <Button
          variant="ghost"
          onClick={() => onCommit(null)}
          className="rounded-full text-muted-foreground self-start"
          data-testid={`fit-${question.id}-unsure`}
        >
          I&apos;m not sure
        </Button>
      )}
    </div>
  );
}
