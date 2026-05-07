// FacialMeasurementsCard — shared display for the customer's
// on-device facial measurements.
//
// Shown on:
//   * /order (checkout summary, so the customer sees what's about
//     to be sent to PennPaps)
//   * /order-success (post-submit confirmation)
//   * /account (signed-in customer's saved sizing)
//   * Admin Customer 360 (CSR view via the same shape)
//
// Grouping mirrors measure.tsx so the customer sees the same
// "Headgear & mask sizing" / "Nasal pillow sizing" framing wherever
// the numbers appear. Numbers are millimetres at one decimal —
// extra precision would imply a level of accuracy the iris-
// calibrated face-mesh doesn't deliver.

import React from "react";
import { Ruler } from "lucide-react";

export interface FacialMeasurementsLike {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
  calibrationMethod?: "iris" | "manual_card" | string;
  capturedAt?: string;
}

export function FacialMeasurementsCard({
  measurements,
  variant = "page",
  capturedAt,
  testIdPrefix = "facial-measurements",
}: {
  measurements: FacialMeasurementsLike;
  /** "page" = standalone glass card with header. "inline" = bare groups for embedding inside another card. */
  variant?: "page" | "inline";
  /** Optional override (otherwise reads measurements.capturedAt). */
  capturedAt?: string | null;
  testIdPrefix?: string;
}) {
  const headgearRows = [
    {
      label: "Face width (cheekbones)",
      value: measurements.faceWidthAtCheekbones,
    },
    { label: "Nose to chin", value: measurements.noseToChin },
    { label: "Mouth width", value: measurements.mouthWidth },
  ];
  const nostrilRows = [
    { label: "Nostril span (alar width)", value: measurements.noseWidth },
    { label: "Nose height", value: measurements.noseHeight },
  ];

  const captured = capturedAt ?? measurements.capturedAt ?? null;
  const capturedLabel = captured ? formatCapturedAt(captured) : null;

  const groups = (
    <div className="space-y-3" data-testid={`${testIdPrefix}-readout`}>
      <MeasurementGroup
        title="Headgear & mask sizing"
        subtitle="Drives strap fit and full-face / nasal mask cushion size."
        rows={headgearRows}
        testId={`${testIdPrefix}-headgear`}
      />
      <MeasurementGroup
        title="Nasal pillow sizing"
        subtitle="Sets the small / medium / large pillow that seals at your nostrils."
        rows={nostrilRows}
        testId={`${testIdPrefix}-nostril`}
      />
    </div>
  );

  if (variant === "inline") {
    return groups;
  }

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid={`${testIdPrefix}-card`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center shrink-0">
            <Ruler className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              Your facial measurements
            </h2>
            <p className="text-xs text-muted-foreground leading-snug">
              Captured on-device. Used to recommend the right mask cushion and
              pillow size.
            </p>
          </div>
        </div>
        {capturedLabel && (
          <span
            className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground whitespace-nowrap"
            data-testid={`${testIdPrefix}-captured-at`}
          >
            {capturedLabel}
          </span>
        )}
      </header>
      {groups}
    </section>
  );
}

function MeasurementGroup({
  title,
  subtitle,
  rows,
  testId,
}: {
  title: string;
  subtitle: string;
  rows: { label: string; value: number }[];
  testId: string;
}) {
  return (
    <div className="callout-navy px-4 py-3 rounded-xl" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[hsl(var(--penn-navy))]/85">
          {title}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
        {subtitle}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between"
            data-testid={`${testId}-row-${row.label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")}`}
          >
            <dt className="text-foreground/70">{row.label}</dt>
            <dd className="font-mono font-semibold text-foreground tabular-nums">
              {row.value.toFixed(1)} mm
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatCapturedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "Captured today";
  if (diffMs < 2 * day) return "Captured yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 30) return `Captured ${days} days ago`;
  return `Captured ${d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}
