// Starter "monogram" logo — generated entirely in the browser (no external
// calls) from the storefront name, so a new tenant's shop has a real logo
// before they've designed one. The output is a PNG uploaded through the
// normal logo endpoint, so it's a genuine, replaceable logo — not a
// transient placeholder.
//
// Split into pure helpers (initials + color, unit-tested) and a canvas
// renderer (browser-only).

// Common words that shouldn't drive the initials (so "The Sleep Co" → "SC",
// not "TS"). Legal suffixes are dropped for the same reason.
const SKIP_WORDS = new Set([
  "the",
  "of",
  "and",
  "for",
  "a",
  "an",
  "to",
  "by",
  "at",
  "on",
  "llc",
  "inc",
  "co",
  "corp",
  "ltd",
  "company",
]);

/** Up to two uppercase initials derived from a storefront name. */
export function deriveInitials(name: string): string {
  const words = (name ?? "")
    .normalize("NFKD")
    // Keep letters/numbers/space/&/-; everything else becomes a separator.
    .replace(/[^\p{L}\p{N}\s&-]/gu, " ")
    .split(/[\s&-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "•";
  const significant = words.filter((w) => !SKIP_WORDS.has(w.toLowerCase()));
  const pick = significant.length > 0 ? significant : words;
  if (pick.length === 1) {
    const w = pick[0];
    return (w.length >= 2 ? w.slice(0, 2) : w.slice(0, 1)).toUpperCase();
  }
  return (pick[0][0] + pick[1][0]).toUpperCase();
}

/**
 * Deterministic, muted brand color for a name (stable per name, so the tile
 * looks intentional and a given tenant always gets the same color). Fixed
 * saturation/lightness for a professional look; only the hue varies.
 */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < (name ?? "").length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return `hsl(${h}, 45%, 32%)`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Render a monogram tile (rounded brand-colored square + white initials) to a
 * PNG File, ready to hand to `uploadStorefrontLogo`. Browser-only; rejects if
 * a 2D canvas isn't available.
 */
export async function renderMonogramLogo(name: string): Promise<File> {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");

  ctx.fillStyle = colorForName(name);
  roundRectPath(ctx, 0, 0, size, size, size * 0.18);
  ctx.fill();

  const initials = deriveInitials(name);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font =
    `700 ${Math.round(size * (initials.length > 1 ? 0.42 : 0.52))}px ` +
    `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  // Small downward nudge so the cap-height block sits optically centered.
  ctx.fillText(initials, size / 2, size / 2 + size * 0.04);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("logo_render_failed");
  return new File([blob], "starter-logo.png", { type: "image/png" });
}
