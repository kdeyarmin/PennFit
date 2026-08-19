/**
 * The magnetic-component safety screen, asked of the patient.
 *
 * Why this exists: `/api/fit/assess` has always been able to demand this
 * screen — with `fitter.magnet_screening` on it answers
 * `{valid:false, reason:"safety_screen_required"}` and hands back the
 * questions — but nothing ever rendered them. `results.tsx` treated that
 * response like any other non-assessment reply and fell through to the
 * legacy engine, which has no safety filter at all. So with the feature
 * nominally ON, an implant patient could still be recommended a mask with
 * magnetic headgear clips. That is the failure this component closes.
 *
 * Design rules, all of them clinical rather than cosmetic:
 *
 *  - **No default answers.** Every question starts unanswered. A
 *    pre-selected "no" is an answer the patient did not give, and on this
 *    screen that is the dangerous direction.
 *  - **"Not sure" is a first-class answer**, not a nudge toward "no". The
 *    engine treats unsure as disqualifying for the magnet rule, which is
 *    the correct reading of "I don't know if I have one".
 *  - **The screen cannot be skipped.** There is no dismiss affordance;
 *    the only way past it is to answer everything and attest. The caller
 *    must not fall back to the legacy engine when this is showing.
 *  - **Household questions are labelled as such**, because the risk is
 *    proximity — the person who sleeps beside the mask matters too, and a
 *    patient reading fast will otherwise answer for themselves.
 */

import { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SafetyScreenPrompt } from "@/lib/fit-assess-api";

export type SafetyAnswer = "yes" | "no" | "unsure";

export interface SafetyScreenSubmission {
  screenVersion: string;
  attestedAt: string;
  responses: Array<{ questionKey: string; answer: SafetyAnswer }>;
}

const ANSWER_OPTIONS: Array<{ value: SafetyAnswer; label: string }> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unsure", label: "Not sure" },
];

const SUBJECT_LABEL: Record<"patient" | "household", string> = {
  patient: "About you",
  household: "About anyone who shares your bed or handles your mask",
};

export function SafetyScreen({
  screen,
  onSubmit,
  submitting = false,
  error = null,
}: {
  screen: SafetyScreenPrompt;
  onSubmit: (submission: SafetyScreenSubmission) => void;
  submitting?: boolean;
  error?: string | null;
}) {
  const [answers, setAnswers] = useState<Record<string, SafetyAnswer>>({});
  const [attested, setAttested] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // Grouped by subject so the household questions read as a distinct
  // section rather than blurring into the patient's own answers.
  const groups = useMemo(() => {
    const sorted = [...screen.questions].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const bySubject: Array<{
      subject: "patient" | "household";
      questions: typeof sorted;
    }> = [];
    for (const q of sorted) {
      const last = bySubject[bySubject.length - 1];
      if (last && last.subject === q.subject) last.questions.push(q);
      else bySubject.push({ subject: q.subject, questions: [q] });
    }
    return bySubject;
  }, [screen.questions]);

  const unanswered = screen.questions
    .map((q) => q.questionKey)
    .filter((k) => !answers[k]);
  const canSubmit = unanswered.length === 0 && attested && !submitting;

  const submit = () => {
    if (!canSubmit) {
      setShowErrors(true);
      return;
    }
    onSubmit({
      screenVersion: screen.version,
      attestedAt: new Date().toISOString(),
      responses: screen.questions.map((q) => ({
        questionKey: q.questionKey,
        answer: answers[q.questionKey]!,
      })),
    });
  };

  return (
    <div className="space-y-6" data-testid="safety-screen">
      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>{screen.title}</AlertTitle>
        {screen.introCopy ? (
          <AlertDescription>{screen.introCopy}</AlertDescription>
        ) : null}
      </Alert>

      {groups.map((group) => (
        <Card
          className="border-0 glass-card rounded-2xl p-5 space-y-5"
          key={`${group.subject}-${group.questions[0]?.questionKey}`}
        >
          <h3 className="font-semibold text-sm">
            {SUBJECT_LABEL[group.subject]}
          </h3>
          {group.questions.map((q) => {
            const missing = showErrors && !answers[q.questionKey];
            return (
              <fieldset
                className="space-y-2"
                key={q.questionKey}
                aria-invalid={missing || undefined}
              >
                <legend className="text-sm font-medium">{q.prompt}</legend>
                {q.helpText ? (
                  <p className="text-sm text-muted-foreground">{q.helpText}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  {ANSWER_OPTIONS.map((opt) => {
                    const selected = answers[q.questionKey] === opt.value;
                    return (
                      <label
                        className={`cursor-pointer rounded-xl border px-4 py-2 text-sm transition ${
                          selected
                            ? "border-primary bg-primary/10 font-medium"
                            : "border-border bg-white/40 hover:bg-white/70"
                        }`}
                        key={opt.value}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          name={q.questionKey}
                          value={opt.value}
                          checked={selected}
                          onChange={() =>
                            setAnswers((prev) => ({
                              ...prev,
                              [q.questionKey]: opt.value,
                            }))
                          }
                        />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
                {missing ? (
                  <p className="text-sm text-destructive">
                    Please answer this before continuing.
                  </p>
                ) : null}
              </fieldset>
            );
          })}
        </Card>
      ))}

      <Card className="border-0 glass-card rounded-2xl p-5 space-y-4">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
            data-testid="safety-attest"
          />
          <span>{screen.attestationCopy}</span>
        </label>
        {showErrors && !attested ? (
          <p className="text-sm text-destructive">
            Please confirm the statement above before continuing.
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          className="w-full"
          onClick={submit}
          disabled={submitting}
          data-testid="safety-submit"
        >
          {submitting ? "Checking…" : "Continue to my results"}
        </Button>
        <p className="text-xs text-muted-foreground">
          We ask because some masks use magnetic headgear clips, which are not
          safe near certain implanted devices. Answering &ldquo;not sure&rdquo;
          is fine — we will simply leave those masks out.
        </p>
      </Card>
    </div>
  );
}
