import React, { useState } from "react";
import { useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, CheckCircle2, Lightbulb } from "lucide-react";
import type { QuestionnaireAnswers } from "@workspace/api-client-react/storefront";

const PAGE_TITLE = "A few quick questions";

type Question = {
  id: keyof QuestionnaireAnswers;
  question: string;
  description?: string;
  helpText?: string;
  type: "boolean" | "select";
  options?: { value: string; label: string; sublabel?: string }[];
};

const questions: Question[] = [
  {
    id: "priorMaskExperience",
    question: "Have you used a CPAP mask before?",
    type: "select",
    options: [
      { value: "none", label: "No, this is my first time" },
      { value: "nasal", label: "Yes, a Nasal Mask (covers nose only)" },
      { value: "nasalPillow", label: "Yes, Nasal Pillows (inserts into nostrils)" },
      { value: "fullFace", label: "Yes, a Full Face Mask (covers nose and mouth)" },
      { value: "hybrid", label: "Yes, a Hybrid Mask (under nose and covers mouth)" },
    ],
  },
  {
    id: "cpapPressureSetting",
    question: "What is your prescribed CPAP pressure?",
    description: "Found on your CPAP machine settings or your titration study report (in cmH₂O).",
    helpText:
      "Higher pressures (15+) need a mask with a broader, tighter seal. Most nasal pillows aren't rated above ~20 cmH₂O.",
    type: "select",
    options: [
      { value: "unknown", label: "I'm not sure", sublabel: "We'll skip this in scoring — pick the closest" },
      { value: "low", label: "Low (4–9 cmH₂O)", sublabel: "Common for mild apnea" },
      { value: "medium", label: "Medium (10–14 cmH₂O)", sublabel: "Most common range" },
      { value: "high", label: "High (15+ cmH₂O)", sublabel: "Severe apnea or BiPAP" },
    ],
  },
  {
    id: "mouthBreather",
    question: "Do you frequently breathe through your mouth while sleeping?",
    description: "If you wake up with a very dry mouth, you might be a mouth breather.",
    helpText: "Mouth breathing makes nasal-only masks ineffective — air leaks out the mouth.",
    type: "boolean",
  },
  {
    id: "sideOrStomachSleeper",
    question: "Do you primarily sleep on your side or stomach?",
    description: "Active sleepers or side/stomach sleepers often need lower-profile masks.",
    type: "boolean",
  },
  {
    id: "claustrophobic",
    question: "Do you experience claustrophobia?",
    description: "If you feel anxious with things covering your face, we'll recommend minimal-contact masks.",
    type: "boolean",
  },
  {
    id: "heavyFacialHair",
    question: "Do you have a beard or heavy facial hair?",
    description: "Facial hair can interfere with the seal of certain mask types.",
    helpText:
      "Full-face and nasal cushions seal against skin — beards break that seal. Nasal pillows tend to work better.",
    type: "boolean",
  },
  {
    id: "wearsGlasses",
    question: "Do you like to read or watch TV in bed while wearing glasses?",
    description: "Some masks block the bridge of your nose, making glasses impossible to wear.",
    type: "boolean",
  },
  {
    id: "frequentCongestion",
    question: "Do you frequently suffer from nasal congestion or allergies?",
    description: "If your nose is often blocked, a nasal-only mask may not provide adequate therapy.",
    type: "boolean",
  },
  {
    id: "mobilityLimitations",
    question: "Do you have arthritis or limited dexterity in your hands?",
    description: "We'll prioritize masks with magnetic clips and easy-release headgear.",
    type: "boolean",
  },
  {
    id: "sensitiveSkin",
    question: "Do you have easily irritated or sensitive skin on your face?",
    type: "boolean",
  },
  {
    id: "siliconeSensitivity",
    question: "Do you have a known allergy or sensitivity to silicone?",
    description: "Most mask cushions are silicone, but alternatives exist (like memory foam).",
    type: "boolean",
  },
];

export function Questionnaire() {
  useDocumentTitle(PAGE_TITLE);
  const [, setLocation] = useLocation();
  // The route-level <ProtectedRoute> in App.tsx already guarantees that
  // `measurements` is non-null by the time this component mounts — no
  // local guard needed.
  const { answers, updateAnswers } = useFitterStore();
  const [currentIndex, setCurrentIndex] = useState(0);

  const currentQ = questions[currentIndex];
  const progress = (currentIndex / questions.length) * 100;

  // Answer values are heterogeneous: boolean for `type: "boolean"`
  // questions and string (an option's `value`) for `type: "select"`.
  // We can't narrow further at the call site because TS sees
  // `currentQ.id` as `keyof QuestionnaireAnswers` (a union) and the
  // value type per key varies — so the computed-key dispatch needs
  // a cast to the destination shape. The runtime guarantee comes from
  // the question schema: each question only emits a value compatible
  // with its declared key.
  const handleAnswer = (value: boolean | string) => {
    updateAnswers({
      [currentQ.id]: value,
    } as Partial<QuestionnaireAnswers>);

    if (currentIndex < questions.length - 1) {
      setCurrentIndex((curr) => curr + 1);
    } else {
      track("questionnaire_completed");
      setLocation("/results");
    }
  };

  const handleBack = () => {
    if (currentIndex > 0) {
      setCurrentIndex((curr) => curr - 1);
    }
  };

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="mb-8 space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            disabled={currentIndex === 0}
            className="h-9 w-9 rounded-full glass-panel border-0 disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              PennPaps · Questionnaire
            </span>
            <span className="text-xs font-mono text-muted-foreground tabular-nums">
              <span className="text-[hsl(var(--penn-gold))] font-bold">
                {String(currentIndex + 1).padStart(2, "0")}
              </span>
              {" / "}
              {String(questions.length).padStart(2, "0")}
            </span>
          </div>
        </div>
        <Progress value={progress} className="h-1.5" />
      </div>

      <div className="animate-in slide-in-from-right-4 fade-in duration-300" key={currentIndex}>
        <Card className="border-0 glass-card rounded-2xl min-h-[420px] flex flex-col">
          <CardHeader className="pb-4">
            <CardTitle
              // id is referenced by aria-labelledby on the radiogroup
              // below so screen readers announce the question text as
              // the group label when entering the choices.
              id={`question-${currentQ.id}-label`}
              className="text-display text-2xl md:text-3xl leading-tight tracking-tight font-bold"
            >
              {currentQ.question}
            </CardTitle>
            {currentQ.description && (
              <p className="text-muted-foreground mt-2 leading-relaxed">{currentQ.description}</p>
            )}
            {currentQ.helpText && (
              <div className="mt-4 flex items-start gap-2.5 text-xs rounded-xl callout-gold p-3">
                <Lightbulb className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))] shrink-0" />
                <span className="text-foreground/85 leading-relaxed">
                  <strong className="text-[hsl(var(--penn-navy-deep))] font-semibold">Why we ask:</strong>{" "}
                  {currentQ.helpText}
                </span>
              </div>
            )}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-center gap-4">
            {currentQ.type === "boolean" ? (
              // Single-select choice → radiogroup semantics. role=radio +
              // aria-checked is the canonical pattern for "pick exactly one";
              // aria-labelledby points at the question heading so a screen
              // reader announces the question as the group's accessible name.
              <div
                role="radiogroup"
                aria-labelledby={`question-${currentQ.id}-label`}
                className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={answers[currentQ.id] === true}
                  className={`option-tile ${
                    answers[currentQ.id] === true ? "option-tile-selected" : ""
                  } h-20 text-lg font-semibold tracking-tight rounded-xl px-5 flex items-center justify-center text-foreground`}
                  onClick={() => handleAnswer(true)}
                  data-testid={`button-${currentQ.id}-yes`}
                >
                  Yes
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={answers[currentQ.id] === false}
                  className={`option-tile ${
                    answers[currentQ.id] === false ? "option-tile-selected" : ""
                  } h-20 text-lg font-semibold tracking-tight rounded-xl px-5 flex items-center justify-center text-foreground`}
                  onClick={() => handleAnswer(false)}
                  data-testid={`button-${currentQ.id}-no`}
                >
                  No
                </button>
              </div>
            ) : (
              // Same radiogroup pattern as the boolean branch — these
              // tiles are visually a card list but semantically a
              // single-select group, so radio semantics are correct.
              <div
                role="radiogroup"
                aria-labelledby={`question-${currentQ.id}-label`}
                className="flex flex-col gap-3 mt-4"
              >
                {currentQ.options?.map((opt) => {
                  const selected = answers[currentQ.id] === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`option-tile ${
                        selected ? "option-tile-selected" : ""
                      } py-4 px-5 text-left whitespace-normal rounded-xl text-foreground`}
                      onClick={() => handleAnswer(opt.value)}
                      data-testid={`button-${currentQ.id}-${opt.value}`}
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
                          <span className="font-medium tracking-tight">{opt.label}</span>
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
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
