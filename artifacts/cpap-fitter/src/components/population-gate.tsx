// The adult-or-child gate — the first thing the questionnaire asks.
//
// Why this is a SCREEN rather than a question in either question set:
// population is a property of the fitting SESSION, not an answer about
// the patient's breathing. It selects the measurement plausibility
// window, the tier-1 service-line filter in the clinical engine
// (`applySafetyExclusions` — a pediatric interface must never reach an
// adult, and an adult-only interface must never reach a child), and the
// `population` column on the stored fit session. Both question sets need
// it, so it lives once, ahead of both, instead of being duplicated into
// the v1 array and the v2 chapter list and drifting apart.
//
// There is deliberately no "I'm not sure" escape. Every other question
// in the flow has one, because "declined to answer" is a real and safe
// state there — the engine simply skips that weight. Here it is not:
// a null population would have to default to something, and defaulting
// either way is exactly the mistake this screen exists to prevent.

import React, { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Baby, Lightbulb, User } from "lucide-react";
import type { Population } from "@/hooks/use-fitter-store";

export function PopulationGate({
  value,
  onSelect,
}: {
  value: Population | null;
  onSelect: (value: Population) => void;
}) {
  // Number-key selection, matching both questionnaires' own shortcuts so
  // this screen doesn't break the rhythm of the flow it sits in front of.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") {
        e.preventDefault();
        onSelect("adult");
      } else if (e.key === "2") {
        e.preventDefault();
        onSelect("pediatric");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="mb-8 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Before we start
          </span>
        </div>
      </div>

      <Card className="border-0 glass-card rounded-2xl min-h-[420px] flex flex-col">
        <CardHeader className="pb-4">
          <CardTitle
            id="population-gate-label"
            className="text-display text-2xl md:text-3xl leading-tight tracking-tight font-bold"
          >
            Who is this fitting for?
          </CardTitle>
          <p className="text-muted-foreground mt-2 leading-relaxed">
            Answer for the person who will wear the mask, not the person filling
            this in.
          </p>
          <div className="mt-4 flex items-start gap-2.5 text-xs rounded-xl callout-gold p-3">
            <Lightbulb className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))] shrink-0" />
            <span className="text-foreground/85 leading-relaxed">
              <strong className="text-[hsl(var(--penn-navy-deep))] font-semibold">
                Why we ask:
              </strong>{" "}
              Children&apos;s masks are a separate product line — they are sized
              and tested for smaller faces. We use your answer to hide every
              mask that isn&apos;t made for this age, so nothing you see is the
              wrong fit.
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col justify-center gap-4">
          <div
            role="radiogroup"
            aria-labelledby="population-gate-label"
            className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4"
          >
            <PopulationTile
              icon={User}
              title="An adult"
              sublabel="18 or older"
              selected={value === "adult"}
              onClick={() => onSelect("adult")}
              testId="button-population-adult"
            />
            <PopulationTile
              icon={Baby}
              title="A child or teenager"
              sublabel="Under 18"
              selected={value === "pediatric"}
              onClick={() => onSelect("pediatric")}
              testId="button-population-pediatric"
            />
          </div>
        </CardContent>
      </Card>

      <p className="mt-4 hidden text-center text-xs text-muted-foreground sm:block">
        Tip: press 1 for an adult, or 2 for a child.
      </p>
    </div>
  );
}

function PopulationTile({
  icon: Icon,
  title,
  sublabel,
  selected,
  onClick,
  testId,
}: {
  icon: typeof User;
  title: string;
  sublabel: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      data-testid={testId}
      className={`option-tile ${
        selected ? "option-tile-selected" : ""
      } h-32 rounded-xl px-5 flex flex-col items-center justify-center gap-2 text-foreground`}
    >
      <Icon className="h-6 w-6 text-[hsl(var(--penn-navy))]" />
      <span className="text-lg font-semibold tracking-tight">{title}</span>
      <span className="text-xs font-normal text-muted-foreground">
        {sublabel}
      </span>
    </button>
  );
}
