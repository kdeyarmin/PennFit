import React, { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, CheckCircle2, Lightbulb } from "lucide-react";
import type { QuestionnaireAnswers } from "@workspace/api-client-react";

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
  const [, setLocation] = useLocation();
  const { answers, updateAnswers, measurements } = useFitterStore();
  const [currentIndex, setCurrentIndex] = useState(0);

  // Redirect to capture if measurements are missing — must run as an effect, not during render
  useEffect(() => {
    if (!measurements) {
      setLocation("/capture");
    }
  }, [measurements, setLocation]);

  if (!measurements) return null;

  const currentQ = questions[currentIndex];
  const progress = (currentIndex / questions.length) * 100;

  const handleAnswer = (value: any) => {
    updateAnswers({ [currentQ.id]: value });

    if (currentIndex < questions.length - 1) {
      setCurrentIndex((curr) => curr + 1);
    } else {
      setLocation("/results");
    }
  };

  const handleBack = () => {
    if (currentIndex > 0) {
      setCurrentIndex((curr) => curr - 1);
    }
  };

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8 space-y-4">
        <div className="flex items-center gap-4 text-sm font-medium text-muted-foreground mb-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            disabled={currentIndex === 0}
            className="h-8 w-8 rounded-full"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span>
            Step {currentIndex + 1} of {questions.length}
          </span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      <div className="animate-in slide-in-from-right-4 fade-in duration-300" key={currentIndex}>
        <Card className="border-border shadow-sm min-h-[400px] flex flex-col">
          <CardHeader className="pb-4">
            <CardTitle className="text-2xl leading-tight">{currentQ.question}</CardTitle>
            {currentQ.description && (
              <p className="text-muted-foreground mt-2">{currentQ.description}</p>
            )}
            {currentQ.helpText && (
              <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-md p-2.5">
                <Lightbulb className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
                <span>
                  <strong className="text-amber-800">Why we ask:</strong> {currentQ.helpText}
                </span>
              </div>
            )}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-center gap-4">
            {currentQ.type === "boolean" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <Button
                  variant="outline"
                  className={`h-20 text-lg border-2 ${
                    answers[currentQ.id] === true
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50"
                  }`}
                  onClick={() => handleAnswer(true)}
                  data-testid={`button-${currentQ.id}-yes`}
                >
                  Yes
                </Button>
                <Button
                  variant="outline"
                  className={`h-20 text-lg border-2 ${
                    answers[currentQ.id] === false
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50"
                  }`}
                  onClick={() => handleAnswer(false)}
                  data-testid={`button-${currentQ.id}-no`}
                >
                  No
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 mt-4">
                {currentQ.options?.map((opt) => {
                  const selected = answers[currentQ.id] === opt.value;
                  return (
                    <Button
                      key={opt.value}
                      variant="outline"
                      className={`h-auto py-4 px-5 justify-start text-left whitespace-normal border-2 ${
                        selected ? "border-primary bg-primary/5" : "hover:border-primary/50"
                      }`}
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
                          <span className="font-medium">{opt.label}</span>
                          {opt.sublabel && (
                            <span className="text-xs text-muted-foreground font-normal">
                              {opt.sublabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </Button>
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
