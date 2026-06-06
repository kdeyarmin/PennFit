import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Eraser } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SignaturePadHandle {
  /** PNG data URL of the drawn signature, or null when empty. */
  toDataURL: () => string | null;
  clear: () => void;
  isEmpty: () => boolean;
}

interface SignaturePadProps {
  /** Logical drawing height in CSS pixels. Width fills the container. */
  height?: number;
  /** Called whenever the empty/non-empty state changes. */
  onChange?: (isEmpty: boolean) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

// A dependency-free signature canvas. Captures pointer/touch strokes,
// draws them smoothly, and exports a trimmed PNG data URL. Backed by a
// HiDPI-aware canvas so the exported image is crisp.
export const SignaturePad = React.forwardRef<
  SignaturePadHandle,
  SignaturePadProps
>(function SignaturePad(
  {
    height = 200,
    onChange,
    className,
    disabled = false,
    ariaLabel = "Signature pad",
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const emptyRef = useRef(true);
  const [empty, setEmpty] = useState(true);

  const setEmptyState = useCallback(
    (next: boolean) => {
      if (emptyRef.current !== next) {
        emptyRef.current = next;
        setEmpty(next);
        onChange?.(next);
      }
    },
    [onChange],
  );

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 320;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, [height]);

  useEffect(() => {
    setupCanvas();
    const onResize = () => {
      // Re-setup wipes the canvas; acceptable on orientation change.
      setupCanvas();
      setEmptyState(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setupCanvas, setEmptyState]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = pointFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = pointFromEvent(e);
    const last = lastRef.current ?? p;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    setEmptyState(false);
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
  };

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setEmptyState(true);
  }, [setEmptyState]);

  useImperativeHandle(
    ref,
    () => ({
      toDataURL: () => {
        if (emptyRef.current) return null;
        return canvasRef.current?.toDataURL("image/png") ?? null;
      },
      clear,
      isEmpty: () => emptyRef.current,
    }),
    [clear],
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className={cn(
          "relative rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 overflow-hidden",
          disabled && "opacity-60",
        )}
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={ariaLabel}
          className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-slate-400">Sign here</span>
          </div>
        )}
        {/* Baseline */}
        <div className="pointer-events-none absolute bottom-8 left-6 right-6 border-b border-slate-300" />
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={disabled || empty}
        >
          <Eraser className="mr-1 h-4 w-4" />
          Clear
        </Button>
      </div>
    </div>
  );
});
