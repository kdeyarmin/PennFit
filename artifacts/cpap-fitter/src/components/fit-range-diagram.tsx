// To-scale fit diagram — shows the comparison the engine actually made.
//
// One row per facial dimension: the mask's published fit range as a band,
// the patient's own measurement as a marker on it. That is the whole
// recommendation, made visible. See lib/fit-range-diagram.ts for why this
// rather than a mask rendered onto a model of the patient's face.
//
// Everything here is computed from numbers already in the browser. No
// image, no camera, no request.

import { CheckCircle2, AlertCircle } from "lucide-react";

import {
  buildFitRangeGeometry,
  mm,
  type FitRangeRow,
} from "@/lib/fit-range-diagram";

export function FitRangeDiagram({ rows }: { rows: FitRangeRow[] }) {
  const geometry = rows
    .map((r) => buildFitRangeGeometry(r))
    .filter((g): g is NonNullable<typeof g> => g !== null);

  if (geometry.length === 0) return null;

  const outOfRange = geometry.filter((g) => !g.inRange).length;

  return (
    <div data-testid="fit-range-diagram">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        How your measurements line up
      </h4>

      <div className="space-y-2.5">
        {geometry.map((g) => (
          <div key={g.label}>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="text-xs text-muted-foreground">{g.label}</span>
              <span className="text-xs font-medium tabular-nums">
                yours {mm(g.value)}
                <span className="text-muted-foreground font-normal">
                  {" · fits "}
                  {mm(g.min)}–{mm(g.max)}
                </span>
              </span>
            </div>

            {/* Track. The band is the mask's range; the dot is the
                patient. Both are positioned on the same scale, so the
                picture is literally the comparison, not an illustration
                of one. */}
            <div
              className="relative h-2 rounded-full bg-muted"
              role="img"
              aria-label={`${g.label}: yours ${mm(g.value)}, this mask fits ${mm(g.min)} to ${mm(g.max)} — ${
                g.inRange ? "within range" : "outside range"
              }`}
            >
              <div
                className={`absolute inset-y-0 rounded-full ${
                  g.inRange
                    ? "bg-[hsl(var(--penn-gold)/0.55)]"
                    : "bg-muted-foreground/25"
                }`}
                style={{
                  left: `${g.bandStartPct}%`,
                  width: `${g.bandWidthPct}%`,
                }}
              />
              <div
                className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${
                  g.inRange ? "bg-[hsl(var(--penn-navy))]" : "bg-destructive"
                }`}
                style={{ left: `${g.markerPct}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground mt-2 leading-relaxed flex items-start gap-1.5">
        {outOfRange === 0 ? (
          <>
            <CheckCircle2
              size={14}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Every measurement sits inside this mask&apos;s published fit
              range.
            </span>
          </>
        ) : (
          <>
            <AlertCircle
              size={14}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {outOfRange === 1
                ? "One measurement sits outside"
                : `${outOfRange} measurements sit outside`}{" "}
              this mask&apos;s published range. It can still work — ranges are
              guidance, not limits — but try the alternatives too, and tell us
              if the seal isn&apos;t right.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

export default FitRangeDiagram;
