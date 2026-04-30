// Five-step progress indicator for the virtual mask-fit flow
// (W4 T-C14).
//
// Renders two layouts driven purely by Tailwind breakpoints (no JS
// resize listener — preserves SSR-safety even though we don't SSR
// today, and avoids the layout flicker a JS-based switch would
// cause):
//
//   * <md (mobile, ~<768px): one-line "Step 3 of 5 · Questionnaire"
//     with a thin progress bar underneath. Designed for the 375px
//     viewport — an iPhone SE in portrait — without horizontal
//     scroll, and to disappear gracefully on the smallest screens
//     by collapsing the label, not the bar.
//
//   * ≥md (desktop): full horizontal pill row with all five steps,
//     connecting lines that fill in as the user advances, and a
//     tooltip-grade title attribute on each circle for keyboard /
//     screen-reader users.
//
// Lives in `components/` rather than `components/ui/` because it's
// product-specific (knows the mask-fit step names and the wouter
// route mapping) — the UI primitives folder is reserved for the
// generic shadcn-derived parts.

import { Check } from "lucide-react";
import { useLocation } from "wouter";

type StepDef = {
  // Path that activates this step. Matched as a literal — none of
  // the fit-flow steps take URL params today.
  path: string;
  label: string;
  shortLabel: string;
};

// Order is the source of truth for the step numbering. To insert a
// step, just splice into this array and adjust nothing else.
const STEPS: ReadonlyArray<StepDef> = [
  { path: "/capture", label: "Photo capture", shortLabel: "Capture" },
  { path: "/measure", label: "Measurements", shortLabel: "Measure" },
  {
    path: "/questionnaire",
    label: "Sleep questionnaire",
    shortLabel: "Survey",
  },
  { path: "/results", label: "Mask matches", shortLabel: "Results" },
  { path: "/order", label: "Order", shortLabel: "Order" },
] as const;

/**
 * If the current location maps to one of the fit-flow steps, returns
 * the zero-based index. Otherwise returns -1 so callers can early-
 * return without rendering the stepper.
 */
function findCurrentStepIndex(pathname: string): number {
  return STEPS.findIndex((s) => s.path === pathname);
}

export function FitFlowStepper() {
  const [location] = useLocation();
  const currentIndex = findCurrentStepIndex(location);
  if (currentIndex < 0) return null;

  const current = STEPS[currentIndex];
  const totalSteps = STEPS.length;
  // Percentage filled is the fraction of completed steps INCLUDING
  // the one the user is on, so the bar reaches 100% on the final
  // step. Using `+1` over `totalSteps` (rather than (n-1) /
  // (total-1)) means step 1 starts the bar at 20% — that gives the
  // user immediate visual feedback that they've already made
  // progress by being on the page.
  const percentComplete = Math.round(((currentIndex + 1) / totalSteps) * 100);

  return (
    <nav
      aria-label="Mask fit progress"
      className="border-b border-border/40 bg-white/60 backdrop-blur-sm"
    >
      <div className="container mx-auto px-4 md:px-6 py-3 md:py-4">
        {/* Mobile: collapsed single-line + bar. Hidden ≥md. */}
        <div className="md:hidden">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Step {currentIndex + 1} of {totalSteps}
            </div>
            <div
              className="text-sm font-semibold text-primary truncate"
              data-testid="fit-stepper-mobile-label"
            >
              {current.label}
            </div>
          </div>
          {/*
           * Static bar — no transition needed since the value only
           * changes on a full route navigation, which itself triggers
           * a remount of the page contents below.
           */}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentComplete}
            aria-valuetext={`Step ${currentIndex + 1} of ${totalSteps}: ${current.label}`}
            aria-label={`Step ${currentIndex + 1} of ${totalSteps}`}
            className="mt-2 h-1.5 w-full rounded-full bg-muted/60 overflow-hidden"
          >
            <div
              className="h-full rounded-full bg-[hsl(var(--penn-gold))]"
              style={{ width: `${percentComplete}%` }}
            />
          </div>
        </div>

        {/* Desktop: full step row. Hidden <md. */}
        <ol className="hidden md:flex items-center justify-between gap-2">
          {STEPS.map((step, idx) => {
            const isComplete = idx < currentIndex;
            const isCurrent = idx === currentIndex;
            const isLast = idx === STEPS.length - 1;
            return (
              <li
                key={step.path}
                className="flex items-center flex-1 last:flex-initial"
              >
                <div
                  className="flex items-center gap-2 min-w-0"
                  title={step.label}
                  data-testid={`fit-stepper-step-${idx + 1}`}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      isComplete
                        ? "bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))]"
                        : isCurrent
                          ? "bg-[hsl(var(--penn-navy))] text-white ring-2 ring-[hsl(var(--penn-gold))] ring-offset-2 ring-offset-white"
                          : "bg-muted text-muted-foreground",
                    ].join(" ")}
                  >
                    {isComplete ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    ) : (
                      idx + 1
                    )}
                  </span>
                  <span
                    className={[
                      "text-sm whitespace-nowrap",
                      isCurrent
                        ? "font-semibold text-primary"
                        : isComplete
                          ? "text-foreground"
                          : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {step.shortLabel}
                  </span>
                </div>
                {/*
                 * Connector line: filled if THIS step is complete
                 * (i.e. the user has progressed past it). Sits in
                 * the row's flex-grow space so the line stretches
                 * naturally between dots regardless of label width.
                 */}
                {!isLast && (
                  <div
                    aria-hidden="true"
                    className="mx-3 h-px flex-1 min-w-4 bg-muted relative overflow-hidden"
                  >
                    <div
                      className={[
                        "absolute inset-y-0 left-0",
                        isComplete
                          ? "w-full bg-[hsl(var(--penn-gold))]"
                          : "w-0",
                      ].join(" ")}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
