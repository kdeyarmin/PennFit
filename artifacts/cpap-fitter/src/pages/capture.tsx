import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Camera, AlertCircle, RefreshCw, Eye, Sun, ScanFace } from "lucide-react";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function Capture() {
  const [, setLocation] = useLocation();
  const { setCapturedImage } = useFitterStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setHasPermission(true);
    } catch (err: any) {
      console.error("Camera error:", err);
      setHasPermission(false);
      if (err.name === "NotAllowedError") {
        setError(
          "Camera access was denied. Please enable camera permissions in your browser settings to continue.",
        );
      } else if (err.name === "NotFoundError") {
        setError("No camera found on this device.");
      } else {
        setError("An error occurred while accessing the camera: " + err.message);
      }
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
    }
  };

  // Capture the current frame from the video feed.
  // Returns true on success, false on failure (so the caller can reset countdown).
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
      setCapturedImage(dataUrl);
      stopCamera();
      setLocation("/measure");
      return true;
    } catch (err: any) {
      console.error("Capture error:", err);
      setError("Failed to capture an image: " + (err?.message ?? "unknown error"));
      return false;
    }
  };

  // 3-2-1 countdown so the user can steady the device before the shutter fires
  const startCountdown = () => {
    if (countdown !== null) return;
    setCountdown(3);
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      const ok = captureFrame();
      // If capture failed, reset countdown so the user can retry.
      if (!ok) setCountdown(null);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  if (hasPermission === false || error) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Camera Access Required</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div className="flex justify-center">
          <Button onClick={startCamera} variant="outline" className="gap-2">
            <RefreshCw className="h-4 w-4" /> Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-8 flex flex-col items-center animate-in fade-in duration-500">
      <div className="text-center mb-6 max-w-xl">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-3">
          <ScanFace className="w-3.5 h-3.5" />
          <span>Step 1 of 3 · Capture</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Position Your Face</h1>
        <p className="text-muted-foreground">
          Center your face in the oval and look straight at the camera. Penn Fit
          uses your eye's iris (a known size) to calibrate the measurement scale —
          no rulers or cards needed.
        </p>
      </div>

      <div className="relative w-full max-w-lg aspect-[3/4] md:aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl mb-6 border border-border">
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

        {/* Overlay Guides */}
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
          {/* Face Oval — softer, premium "scanner" feel */}
          <div className="w-3/5 md:w-2/5 aspect-[3/4] border-[3px] border-primary/80 rounded-[100%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45),inset_0_0_30px_rgba(255,255,255,0.08)]" />

          {/* Corner brackets for 'sci-fi' tech feel */}
          <CornerBrackets />
        </div>

        {/* Countdown overlay */}
        {countdown !== null && countdown > 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="text-white text-9xl font-bold tabular-nums drop-shadow-2xl animate-in zoom-in-50 duration-300">
              {countdown}
            </div>
          </div>
        )}
        {countdown === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 animate-in fade-in duration-200">
            <Camera className="w-16 h-16 text-primary" />
          </div>
        )}
      </div>

      {/* Quick reminders */}
      <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground mb-6">
        <span className="inline-flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5" /> Remove glasses
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sun className="w-3.5 h-3.5" /> Even lighting on your face
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ScanFace className="w-3.5 h-3.5" /> Look directly at the camera
        </span>
      </div>

      <Button
        size="lg"
        className="h-16 px-12 rounded-full text-lg shadow-lg hover:scale-105 transition-transform disabled:opacity-100"
        onClick={startCountdown}
        disabled={countdown !== null || hasPermission === null}
        data-testid="button-capture"
      >
        <Camera className="mr-2 h-6 w-6" />
        {countdown === null ? "Capture Measurement Frame" : "Hold still…"}
      </Button>
    </div>
  );
}

function CornerBrackets() {
  const cornerClass =
    "absolute w-8 h-8 border-primary/70 transition-opacity duration-300";
  return (
    <>
      <div className={`${cornerClass} top-6 left-6 border-t-2 border-l-2 rounded-tl-md`} />
      <div className={`${cornerClass} top-6 right-6 border-t-2 border-r-2 rounded-tr-md`} />
      <div className={`${cornerClass} bottom-6 left-6 border-b-2 border-l-2 rounded-bl-md`} />
      <div className={`${cornerClass} bottom-6 right-6 border-b-2 border-r-2 rounded-br-md`} />
    </>
  );
}
