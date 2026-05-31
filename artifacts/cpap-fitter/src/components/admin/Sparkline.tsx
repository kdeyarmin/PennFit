// Sparkline — a tiny dependency-free SVG trend line for a numeric
// series (e.g. 90 nights of usage / AHI / leak). No chart library; the
// geometry is a pure, unit-tested function so the SVG markup stays a
// thin renderer.
//
// Nulls (missing nights) break the line into separate segments rather
// than interpolating across a gap — an honest "no data here" instead of
// a fabricated straight line. The most-recent point gets a dot so the
// eye lands on "where are we now".

export interface SparklineGeometry {
  /** Polyline segments (each a run of consecutive non-null points). A
   *  single isolated point yields a 1-element segment (rendered as a
   *  dot, not a line). */
  segments: Array<Array<{ x: number; y: number }>>;
  /** The most-recent plotted point, or null when the series is empty. */
  last: { x: number; y: number } | null;
  min: number;
  max: number;
  /** Count of non-null samples. */
  sampleCount: number;
}

/**
 * Pure: map a numeric series (oldest → newest) to SVG coordinates in a
 * `width × height` box. Higher values plot higher (smaller y). A flat
 * series (min === max) plots along the vertical midline. Nulls produce
 * gaps between segments.
 */
export function buildSparkline(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
): SparklineGeometry {
  const numeric = values.filter((v): v is number => v != null);
  const sampleCount = numeric.length;
  const min = numeric.length > 0 ? Math.min(...numeric) : 0;
  const max = numeric.length > 0 ? Math.max(...numeric) : 0;
  const span = max - min;
  const n = values.length;

  const yFor = (v: number): number =>
    span === 0 ? height / 2 : height - ((v - min) / span) * height;
  const xFor = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * width);

  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    const pt = { x: xFor(i), y: yFor(v) };
    current.push(pt);
    last = pt;
  }
  if (current.length > 0) segments.push(current);

  return { segments, last, min, max, sampleCount };
}

export interface SparklineProps {
  values: ReadonlyArray<number | null>;
  width?: number;
  height?: number;
  /** Stroke colour (any CSS colour). Defaults to the brand navy. */
  color?: string;
  /** Accessible label for the trend. */
  ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = "hsl(var(--penn-navy))",
  ariaLabel,
}: SparklineProps) {
  const geo = buildSparkline(values, width, height);

  if (geo.sampleCount < 2) {
    return (
      <span className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        not enough data
      </span>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className="overflow-visible"
    >
      {geo.segments.map((seg, i) =>
        seg.length >= 2 ? (
          <polyline
            key={i}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={seg
              .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
              .join(" ")}
          />
        ) : null,
      )}
      {geo.last && (
        <circle cx={geo.last.x} cy={geo.last.y} r={2} fill={color} />
      )}
    </svg>
  );
}
