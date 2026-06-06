// Renders a typed name into a signature-style PNG data URL on an
// offscreen canvas. Lets a patient "sign" by simply typing their legal
// name and picking a style — no drawing required. Whatever the browser
// renders for the cursive font stack is captured into the image, so the
// signed PDF shows a real signature rather than plain text.

export interface SignatureStyle {
  label: string;
  /** CSS font-family stack — also used for the canvas font. */
  fontStack: string;
}

export const SIGNATURE_STYLES: SignatureStyle[] = [
  {
    label: "Classic",
    fontStack: "'Brush Script MT', 'Segoe Script', 'Bradley Hand', cursive",
  },
  {
    label: "Formal",
    fontStack: "'Snell Roundhand', 'Apple Chancery', 'URW Chancery L', cursive",
  },
  {
    label: "Casual",
    fontStack: "'Lucida Handwriting', 'Bradley Hand', 'Comic Sans MS', cursive",
  },
];

export function renderTypedSignatureDataUrl(
  name: string,
  fontStack: string,
): string | null {
  const trimmed = name.trim();
  if (typeof document === "undefined" || trimmed.length === 0) return null;

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const width = 600;
  const height = 160;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#0f172a";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  // Shrink the font until the name fits within the canvas width.
  let fontSize = 68;
  const setFont = () => {
    ctx.font = `italic ${fontSize}px ${fontStack}`;
  };
  setFont();
  while (fontSize > 22 && ctx.measureText(trimmed).width > width - 48) {
    fontSize -= 2;
    setFont();
  }

  ctx.fillText(trimmed, width / 2, height / 2);
  return canvas.toDataURL("image/png");
}
