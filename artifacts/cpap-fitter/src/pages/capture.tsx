import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Camera, AlertCircle, RefreshCw, ScanFace } from "lucide-react";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { getCaptureBlockers, isCaptureReady } from "@/lib/capture-readiness";
import { useVisionRuntimeHealth } from "@/hooks/use-vision-runtime-health";

export function Capture() {
  useDocumentTitle("Take a photo");
  const [, setLocation] = useLocation();
  const { setCapturedImage } = useFitterStore();
  const visionHealth = useVisionRuntimeHealth();
  useEffect(() => {
    track("capture_started");
  }, []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Tracks the active MediaStream so stopCamera works even if the component
  // unmounts while getUserMedia() is still in flight (videoRef becomes null
  // on unmount, so we can't rely on videoRef.current.srcObject for cleanup).
  const streamRef = useRef<MediaStream | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Attach the live stream to the <video> element and arm the
  // videoReady flip. Called from startCamera when the element is
  // already mounted, and from the effect below for the retry path,
  // where the element only mounts AFTER the stream lands.
  const attachStream = () => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    video.onloadeddata = () => setVideoReady(true);
  };

  const startCamera = async (): Promise<MediaStream | null> => {
    setError(null);
    setVideoReady(false);
    try {
      // Stop any existing stream before acquiring a new one (retry path).
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      attachStream();
      setHasPermission(true);
      return stream;
    } catch (err) {
      console.error(
        "Camera error:",
        err instanceof Error ? err.message : String(err),
      );
      setHasPermission(false);
      setVideoReady(false);
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      if (name === "NotAllowedError") {
        setError(
          "Camera access was denied. Please enable camera permissions in your browser settings to continue.",
        );
      } else if (name === "NotFoundError") {
        setError("No camera found on this device.");
      } else {
        setError("An error occurred while accessing the camera: " + message);
      }
      return null;
    }
  };

  useEffect(() => {
    let active = true;
    void startCamera().then((stream) => {
      // If the component unmounted while getUserMedia was in flight, stop
      // the stream immediately — the cleanup below already ran and couldn't
      // see it because streamRef wasn't set yet.
      if (!active && stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    });
    return () => {
      active = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-attach on the retry path: the error screen renders WITHOUT the
  // <video> element, so when "Try again" succeeds the element only
  // mounts on the NEXT render — after startCamera's own attach already
  // saw a null ref. Without this, the fresh <video> has no srcObject,
  // videoReady never flips, and the page wedges on "warming up" with
  // the camera light on (docs/app-review-2026-06-10.md P0-4). Every
  // acquisition path resets `error` to null and lands
  // `hasPermission === true`, so these deps cover all of them; the
  // srcObject identity guard makes redundant runs no-ops.
  useEffect(() => {
    attachStream();
  }, [hasPermission, error]);

  // Capture the current frame from the video feed.
  // Returns true on success, false on failure (so the caller can reset state).
  const captureFrame = (): boolean => {
    try {
      if (!videoRef.current || !canvasRef.current) {
        setError("Camera or canvas was not ready. Please try again.");
        return false;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;

      // Guard against zero-size video (camera not ready)
      if (!video.videoWidth || !video.videoHeight) {
        setError("Camera feed wasn't ready yet. Please try again in a moment.");
        return false;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setError("Could not initialize image capture.");
        return false;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      // flushSync forces the captured-image context state to commit BEFORE
      // we navigate. Without it, wouter's setLocation synchronously fires a
      // 'pushState' event that re-renders the wouter subtree first, so the
      // GuardedMeasure on /measure reads the still-null capturedImage and
      // bounces straight back to /capture. (Wouter's own source notes the
      // missing unstable_batchedUpdates as a known caveat — see
      // node_modules/wouter/src/use-browser-location.js lines 74-76.)
      flushSync(() => {
        setCapturedImage(dataUrl);
      });
      stopCamera();
      track("capture_taken");
      setLocation("/measure");
      return true;
    } catch (err) {
      console.error(
        "Capture error:",
        err instanceof Error ? err.message : String(err),
      );
      const message = err instanceof Error ? err.message : "unknown error";
      setError("Failed to capture an image: " + message);
      return false;
    }
  };

  // Immediate capture — no countdown. Older versions held a 3-2-1 timer
  // so users could steady the camera, but the extra wait felt sluggish
  // and drove drop-off; the iris-calibrated math is robust to small
  // motion. Disabled-button gating still prevents a press before the
  // camera/runtime is ready.
  const blockers = getCaptureBlockers(hasPermission, videoReady);
  const captureReady = isCaptureReady(blockers) && visionHealth === "ready";
  const handleCapture = () => {
    if (capturing) return;
    if (!captureReady) {
      track("capture_blocked", {
        ...blockers,
        runtimeReady: visionHealth === "ready",
      });
      return;
    }
    setCapturing(true);
    const ok = captureFrame();
    if (!ok) setCapturing(false);
  };

  if (hasPermission === false || error) {
    // Browser-specific instructions for re-enabling the camera. We
    // detect via UA — coarse but right for the common cases (iOS
    // Safari, Android Chrome, desktop Chrome / Safari / Firefox).
    // Worst case: we fall through to the generic "address-bar lock
    // icon" advice, which is right on every desktop browser. We never
    // block the user — even with no camera at all, the rest of the
    // shop is fully usable, so we always surface that escape hatch.
    const ua =
      typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
    const isIos = /iphone|ipad|ipod/.test(ua);
    const isAndroid = /android/.test(ua);
    const isFirefox = /firefox/.test(ua);
    let howTo: string;
    if (isIos) {
      howTo =
        'On iPhone or iPad: open Settings → Safari → Camera and pick "Allow" for this site, then come back and tap Try again.';
    } else if (isAndroid) {
      howTo =
        "On Android: tap the lock icon to the left of the address bar → Permissions → Camera → Allow, then tap Try again.";
    } else if (isFirefox) {
      howTo =
        "In Firefox: click the camera icon in the address bar (or Settings → Privacy & Security → Permissions → Camera) and grant access for this site, then tap Try again.";
    } else {
      howTo =
        'Click the lock or camera icon to the left of the address bar, set Camera to "Allow" for this site, refresh, then tap Try again.';
    }
    const isPermissionDenied = /denied|notallowederror/i.test(error ?? "");
    const isNoDevice = /no camera/i.test(error ?? "");
    return (
      <div className="container max-w-2xl mx-auto px-4 py-16 animate-shimmer-in space-y-6">
        <Alert
          variant="destructive"
          className="glass-card border-destructive/30"
          data-testid="capture-camera-error"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {isPermissionDenied
              ? "Camera permission was blocked"
              : isNoDevice
                ? "We couldn't find a camera on this device"
                : "Camera access required"}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            {isPermissionDenied && (
              <p
                className="text-xs leading-relaxed bg-white/40 border border-destructive/20 rounded-lg p-2.5"
                data-testid="capture-camera-howto"
              >
                {howTo}
              </p>
            )}
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap gap-3 justify-center">
          {!isNoDevice && (
            <Button
              onClick={startCamera}
              className="gap-2 rounded-full btn-primary-glow px-6"
              data-testid="capture-camera-retry"
            >
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          )}
          <Link href="/shop">
            <Button
              variant="outline"
              className="rounded-full glass-panel border-0 px-6"
              data-testid="capture-camera-fallback-shop"
            >
              Skip for now — browse the shop
            </Button>
          </Link>
        </div>

        <p className="text-xs text-center text-muted-foreground/85 max-w-md mx-auto leading-relaxed">
          The camera is only used to measure your face on this device. Photos
          never leave your phone. If you'd rather not use the camera, you can
          still browse our shop or use insurance — PennPaps will help you pick a
          mask in person.
        </p>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 md:py-12 flex flex-col items-center animate-shimmer-in">
      <div className="text-center mb-3 md:mb-8 max-w-xl">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-xs font-medium mb-4">
          <ScanFace className="w-3.5 h-3.5" />
          <span className="font-semibold tracking-wide">
            Step 1 of 3 · Capture
          </span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Camera status:{" "}
          <span
            className={
              videoReady
                ? "text-emerald-700 font-medium"
                : "text-amber-700 font-medium"
            }
          >
            {videoReady ? "ready" : "warming up"}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Vision runtime:{" "}
          <span
            className={
              visionHealth === "ready"
                ? "text-emerald-700 font-medium"
                : visionHealth === "checking"
                  ? "text-amber-700 font-medium"
                  : "text-rose-700 font-medium"
            }
          >
            {visionHealth}
          </span>
        </div>
        <div className="inline-flex items-center justify-center gap-3 mb-3">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Position
          </span>
          <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
        </div>
        <h1 className="text-display text-2xl md:text-5xl font-bold tracking-tight mb-2 md:mb-3 text-gradient-brand">
          Position Your Face
        </h1>
        <p className="hidden md:block text-muted-foreground leading-relaxed">
          Center your face in the oval and look straight at the camera. We
          measure off your iris — it's almost exactly the same size in every
          adult.
        </p>
        <p className="md:hidden text-sm text-muted-foreground leading-snug">
          Center your face in the oval.
        </p>
      </div>

      {/* Camera frame.
          Mobile (portrait phones): cap the height to ~50vh so the
          oval AND the "Take Photo" button always fit on one screen
          without scrolling — the previous aspect-[3/4] container
          would push the button below the fold on shorter handsets.
          Desktop keeps the wider 16:9 framing. */}
      <div className="relative w-full max-w-lg h-[min(50vh,28rem)] md:h-auto md:aspect-video bg-black rounded-2xl overflow-hidden mb-4 md:mb-6 border border-[hsl(var(--penn-navy)/0.18)] shadow-[0_20px_60px_hsl(var(--penn-navy)/0.20),0_0_0_1px_hsl(var(--penn-navy)/0.08)]">
        {/* Loading state indicator */}
        {hasPermission === null && (
          <div className="absolute inset-0 flex items-center justify-center text-white/50">
            <RefreshCw className="h-8 w-8 animate-spin" />
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover transform -scale-x-100"
        />

        {/* Hidden canvas for extraction */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Overlay Guides — purely decorative scan-frame chrome.
            aria-hidden because screen readers should not announce the
            empty face oval / corner-bracket divs; the actual guidance
            lives in the visible "Quick reminders" list below + the
            countdown live region further down. */}
        <div
          className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center"
          aria-hidden="true"
        >
          {/* Face Oval — softer, premium "scanner" feel.
              Aspect-[2/3] is a tall portrait ratio (width:height = 2:3),
              which matches the actual proportions of a human head far
              better than the near-square 3:4 we had before. Sized off
              height on mobile so the oval stays fully inside the
              capped frame; off width on desktop where the frame is
              wider than tall. */}
          <div className="h-4/5 max-h-[80%] aspect-[2/3] md:h-auto md:w-1/3 md:max-h-none border-[3px] border-primary/80 rounded-[100%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45),inset_0_0_30px_rgba(255,255,255,0.08)]" />

          {/* Corner brackets for 'sci-fi' tech feel */}
          <CornerBrackets />
        </div>

        {/* Brief shutter flash on capture so the press feels confirmed. */}
        {capturing && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 animate-in fade-in duration-150">
            <Camera className="w-16 h-16 text-primary" />
          </div>
        )}
        <div
          className="sr-only"
          role="status"
          aria-live="assertive"
          aria-atomic="true"
        >
          {capturing ? "Capturing now" : ""}
        </div>
      </div>

      {!captureReady && visionHealth !== "ready" && (
        <p className="w-full max-w-lg mb-4 text-xs text-muted-foreground text-center">
          Vision runtime is not ready yet. Please wait a moment and try again.
        </p>
      )}

      <Button
        size="lg"
        className="h-12 md:h-16 px-8 md:px-12 rounded-full text-base md:text-lg btn-primary-glow hover:scale-[1.02] transition-transform disabled:opacity-60"
        onClick={handleCapture}
        disabled={capturing || !captureReady}
        data-testid="button-capture"
      >
        <Camera className="mr-2 h-5 w-5 md:h-6 md:w-6" />
        {capturing ? "Capturing…" : "Take Photo"}
      </Button>
      <p className="hidden md:block mt-3 text-xs text-muted-foreground text-center max-w-md">
        {captureReady
          ? "We'll measure your face for headgear sizing and your nostrils for nasal pillow sizing — all on this device."
          : "Waiting for camera to be ready…"}
      </p>
    </div>
  );
}

function CornerBrackets() {
  const cornerClass =
    "absolute w-8 h-8 border-primary/70 transition-opacity duration-300";
  return (
    <>
      <div
        className={`${cornerClass} top-6 left-6 border-t-2 border-l-2 rounded-tl-md`}
      />
      <div
        className={`${cornerClass} top-6 right-6 border-t-2 border-r-2 rounded-tr-md`}
      />
      <div
        className={`${cornerClass} bottom-6 left-6 border-b-2 border-l-2 rounded-bl-md`}
      />
      <div
        className={`${cornerClass} bottom-6 right-6 border-b-2 border-r-2 rounded-br-md`}
      />
    </>
  );
}
