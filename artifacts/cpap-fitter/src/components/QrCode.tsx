// Small client-side QR code renderer (canvas-backed, via the `qrcode`
// package). Used by the MFA enrollment screens to render the otpauth://
// URI so an authenticator app can be enrolled by scanning instead of
// typing the secret. The value is rendered locally — it never leaves
// the browser.

import { useEffect, useRef, useState } from "react";
import QRCodeLib from "qrcode";

export function QrCode({
  value,
  size = 168,
  ariaLabel = "QR code",
  className,
}: {
  value: string;
  size?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    QRCodeLib.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  // The screens that embed this always show the secret + otpauth link
  // for manual entry, so a render failure simply hides the canvas.
  if (failed) return null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}
