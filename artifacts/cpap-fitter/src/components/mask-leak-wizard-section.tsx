import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wind, ArrowLeft, Sparkles } from "lucide-react";

import { fetchTherapySummary } from "@/lib/account-api";

/**
 * Mask-leak troubleshooting wizard on /account.
 *
 * Tier 1 K patient-facing decision tree. Walks the patient through
 * a small Q&A and lands them on a concrete next step — refit,
 * cushion-replace, headgear adjustment, side-sleeper accommodation.
 *
 * When the patient is linked to a therapy stream AND their recent
 * avg leak rate is elevated (>24 L/min, the manufacturer-published
 * "high-leak" threshold most CPAP UIs use), the wizard opens with
 * a personalized intro: "Your last 30 nights averaged X L/min —
 * here's what to check first."
 *
 * Decisions are kept short on purpose. Patients don't read long
 * branching trees; the goal is to move them toward EITHER a
 * concrete action OR opening a chat with us within 2-3 clicks.
 */

type Step =
  | { kind: "start" }
  | { kind: "when_leaks_most" }
  | { kind: "cushion_age"; cause: "fit" | "movement" | "wear" }
  | { kind: "side_sleeper" }
  | { kind: "advice"; reason: string; bullets: string[]; learnSlug?: string };

const HIGH_LEAK_THRESHOLD = 24; // L/min — common UI threshold

export function MaskLeakWizardSection() {
  const [step, setStep] = useState<Step>({ kind: "start" });
  const { data: therapy } = useQuery({
    queryKey: ["account", "therapy-summary"] as const,
    queryFn: fetchTherapySummary,
  });

  const recentLeak =
    therapy?.patientLinked && therapy.avgLeakLMin != null
      ? therapy.avgLeakLMin
      : null;
  const elevated = recentLeak != null && recentLeak >= HIGH_LEAK_THRESHOLD;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-mask-leak-wizard"
    >
      <div className="flex items-center gap-2">
        <Wind className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">Mask leak troubleshooting</h2>
      </div>

      {recentLeak != null && (
        <div
          className="rounded-xl border p-3 text-sm"
          style={{
            borderColor: elevated ? "hsl(0 70% 80%)" : "hsl(var(--line-1))",
            backgroundColor: elevated ? "hsl(0 70% 97%)" : undefined,
          }}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            <span>
              Your last 30 nights averaged{" "}
              <strong>{recentLeak.toFixed(1)} L/min</strong> leak.
            </span>
          </div>
          {elevated ? (
            <p className="text-xs mt-1" style={{ color: "hsl(0 70% 35%)" }}>
              That's above the 24 L/min threshold most masks flag as "high
              leak." Walk through the questions below — most fixes are quick.
            </p>
          ) : (
            <p className="text-xs mt-1 text-muted-foreground">
              That's within the typical range, but if you've noticed a change
              recently, the questions below help narrow it down.
            </p>
          )}
        </div>
      )}

      <WizardBody step={step} setStep={setStep} />
    </section>
  );
}

function WizardBody({
  step,
  setStep,
}: {
  step: Step;
  setStep: (s: Step) => void;
}) {
  if (step.kind === "start") {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Answer two or three questions and we'll land on the most likely cause.
          Most leaks come down to fit, age, or sleep position.
        </p>
        <button
          type="button"
          className="rounded-md px-4 py-2 text-sm font-semibold text-white"
          style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
          onClick={() => setStep({ kind: "when_leaks_most" })}
        >
          Start →
        </button>
      </div>
    );
  }

  if (step.kind === "when_leaks_most") {
    return (
      <WizardStep
        title="When does your mask leak most?"
        onBack={() => setStep({ kind: "start" })}
        setStep={setStep}
        options={[
          {
            label: "Right after I put it on",
            next: { kind: "cushion_age", cause: "fit" },
          },
          {
            label: "When I roll over or change position",
            next: { kind: "side_sleeper" },
          },
          {
            label: "Constantly through the night",
            next: { kind: "cushion_age", cause: "wear" },
          },
        ]}
      />
    );
  }

  if (step.kind === "cushion_age") {
    return (
      <WizardStep
        title="How old is your current mask cushion?"
        onBack={() => setStep({ kind: "when_leaks_most" })}
        setStep={setStep}
        options={[
          {
            label: "Less than a month",
            next: {
              kind: "advice",
              reason:
                step.cause === "fit"
                  ? "Fresh cushion + leaks right after putting it on usually means a size or seat issue, not wear."
                  : "Fresh cushion shouldn't be leaking continuously — let's get our team to take a quick look.",
              bullets: [
                "Check the cushion's size code (S/M/L) against your fit history.",
                "Try the 30-second seal test: lie back, run a finger along the cushion edge to find the gap.",
                "Loosen the headgear straps a notch; over-tight straps actually create leaks.",
              ],
              learnSlug: "/learn/mask-fit-basics",
            },
          },
          {
            label: "1–3 months",
            next: {
              kind: "advice",
              reason:
                "Cushions start to deform around the 3-month mark — a partial-month-old cushion may be on the edge.",
              bullets: [
                "Inspect the cushion for shiny / flattened spots — that's the deformation zone.",
                "If the cushion still looks good, focus on fit (sizing / strap tension).",
                "If it's lost its shape, order a replacement.",
              ],
              learnSlug: "/learn/persistent-leaks",
            },
          },
          {
            label: "Over 3 months",
            next: {
              kind: "advice",
              reason:
                "Manufacturer-recommended replacement is monthly for cushions; past three months it's almost certainly the cushion.",
              bullets: [
                "Order a fresh cushion from your resupply schedule.",
                "If we're between resupply cycles, message us and we'll expedite.",
              ],
            },
          },
        ]}
      />
    );
  }

  if (step.kind === "side_sleeper") {
    return (
      <WizardStep
        title="Do you sleep on your side?"
        onBack={() => setStep({ kind: "when_leaks_most" })}
        setStep={setStep}
        options={[
          {
            label: "Yes, mostly side-sleeper",
            next: {
              kind: "advice",
              reason:
                "Side-sleeping pushes the cushion against the pillow and breaks the seal. Two quick fixes.",
              bullets: [
                "Try a CPAP-shaped pillow (cutouts let the mask sit clear of the pillow).",
                "Consider switching to a nasal-pillow or low-profile mask that doesn't extend off your face.",
                "A small strap-tension reduction often helps once the pillow is right.",
              ],
              learnSlug: "/learn/side-sleeping",
            },
          },
          {
            label: "No, I sleep on my back",
            next: {
              kind: "advice",
              reason:
                "Leaks-on-movement for back-sleepers is usually strap tension or pillow height pushing the chin up.",
              bullets: [
                "Loosen the lower (chin) straps half a notch.",
                "Try a thinner pillow or a CPAP-friendly pillow shape.",
                "If the leak coincides with mouth-breathing, a chin strap can help.",
              ],
              learnSlug: "/learn/persistent-leaks",
            },
          },
        ]}
      />
    );
  }

  // advice
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
        onClick={() => setStep({ kind: "start" })}
      >
        <ArrowLeft className="h-3 w-3" />
        Start over
      </button>
      <p className="text-sm">{step.reason}</p>
      <ul className="space-y-1 text-sm">
        {step.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 rounded-full shrink-0 bg-[hsl(var(--penn-gold))]" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 pt-2">
        {step.learnSlug && (
          <a
            href={step.learnSlug}
            className="rounded-md px-3 py-1.5 text-xs font-semibold border"
            style={{
              borderColor: "hsl(var(--line-1))",
              color: "hsl(var(--penn-navy))",
            }}
          >
            Read more
          </a>
        )}
        <a
          href="#customer-chat"
          className="rounded-md px-3 py-1.5 text-xs font-semibold text-white"
          style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
        >
          Still leaking — chat with us
        </a>
      </div>
    </div>
  );
}

function WizardStep({
  title,
  options,
  onBack,
  setStep,
}: {
  title: string;
  options: Array<{ label: string; next: Step }>;
  onBack: () => void;
  setStep: (s: Step) => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
        onClick={onBack}
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>
      <p className="text-sm font-medium">{title}</p>
      <div className="grid sm:grid-cols-3 gap-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => setStep(o.next)}
            className="rounded-xl border p-3 text-sm text-left hover:shadow-sm transition-shadow"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
